//! Timeline d'un salon (lecture) via `matrix_sdk_ui::timeline::Timeline`.
//!
//! Une tâche par salon sélectionné : chargement initial, pagination vers le haut à la demande, et
//! temps réel (chaque lot de modifications republie un instantané que le domaine fusionne par id).
//! Tout s'exécute sur Tokio ; l'UI ne fait que recevoir des [`TimelineUpdate`].

use chrono::{DateTime, Local, TimeZone};
use domain::{
    initials, EventId, EventState, EventVm, MediaKind, MediaPayload, MediaStatus, MediaVm, RoomId,
    TimelineUpdate, REDACTED_PLACEHOLDER, UNDECRYPTABLE_PLACEHOLDER,
};
use futures_util::StreamExt;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::ruma::api::client::typing::create_typing_event::{self, v3::{Typing, TypingInfo}};
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::events::room::message::{
    MessageType, RoomMessageEventContent, RoomMessageEventContentWithoutRelation,
};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::{EventId as SdkEventId, RoomId as SdkRoomId, UserId as SdkUserId};
use matrix_sdk::attachment::{AttachmentInfo, BaseAudioInfo, BaseFileInfo, BaseImageInfo, BaseVideoInfo};
use matrix_sdk::Client;
use matrix_sdk_ui::timeline::{
    AttachmentConfig, EventSendState, MsgLikeKind, RoomExt, TimelineDetails, TimelineEventItemId, TimelineItem,
    TimelineItemContent,
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::MatrixError;
use crate::media::{check_upload, fetch_image, mime_for, ImageRequest, MediaCache};

/// Taille d'une page (chargement initial et pagination).
pub const PAGE_SIZE: u16 = 50;

/// Demande de l'UI à la tâche de timeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimelineCommand {
    /// Charger une page plus ancienne.
    LoadOlder,
    /// Envoyer un message texte brut dans le salon (chiffré automatiquement par le SDK si le salon l'est).
    SendText(String),
    /// Modifier le message d'identifiant d'événement `event_id` (`Timeline::edit`).
    Edit { event_id: String, body: String },
    /// Supprimer (redacter) le message `event_id` (`Timeline::redact`).
    Redact { event_id: String },
    /// Marquer le salon comme lu jusqu'au dernier message (`Timeline::mark_as_read`).
    MarkRead,
    /// Annoncer que j'écris (`true`) ou que j'ai cessé (`false`) (`Room::typing_notice`).
    Typing(bool),
    /// Envoyer le fichier `path` en pièce jointe (`Timeline::send_attachment`, chiffré par le SDK si le
    /// salon l'est). La lecture du fichier se fait ici, sur Tokio, jamais dans l'UI.
    SendAttachment(std::path::PathBuf),
}

/// Téléchargements d'images de la timeline : au plus [`MAX_PARALLEL_DOWNLOADS`] à la fois, chaque média
/// une seule fois par timeline (le cache évite aussi tout retéléchargement entre timelines).
const MAX_PARALLEL_DOWNLOADS: usize = 4;

struct ImageFetcher {
    client: Client,
    cache: std::sync::Arc<MediaCache>,
    requested: std::collections::HashSet<String>,
    tasks: JoinSet<()>,
    results: UnboundedSender<(String, MediaPayload)>,
    limit: std::sync::Arc<Semaphore>,
}

impl ImageFetcher {
    fn new(
        client: Client,
        cache: std::sync::Arc<MediaCache>,
        results: UnboundedSender<(String, MediaPayload)>,
    ) -> Self {
        Self {
            client,
            cache,
            requested: std::collections::HashSet::new(),
            tasks: JoinSet::new(),
            results,
            limit: std::sync::Arc::new(Semaphore::new(MAX_PARALLEL_DOWNLOADS)),
        }
    }

    /// Lance le téléchargement des images pas encore demandées. Les tâches s'arrêtent avec la timeline.
    fn request(&mut self, requests: Vec<ImageRequest>) {
        for request in requests {
            if !self.requested.insert(request.key.clone()) {
                continue;
            }
            let client = self.client.clone();
            let cache = std::sync::Arc::clone(&self.cache);
            let results = self.results.clone();
            let limit = std::sync::Arc::clone(&self.limit);
            self.tasks.spawn(async move {
                // Semaphore fermé = arrêt : on abandonne sans rien envoyer.
                let Ok(_permit) = limit.acquire_owned().await else {
                    return;
                };
                let payload = match fetch_image(&client, &cache, &request).await {
                    Ok(bytes) => MediaPayload::Ready(bytes),
                    Err(err) => MediaPayload::Failed(err.to_string()),
                };
                let _ = results.send((request.key, payload));
            });
        }
    }
}

/// Ce que l'on sait d'un fichier avant de l'envoyer : de quoi remplir l'en-tête `info` de l'événement.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedAttachment {
    mime: mime::Mime,
    /// Taille du fichier en octets (celle du disque, déjà contrôlée par `check_upload`).
    size: u64,
    /// Largeur × hauteur d'une image, lues dans l'en-tête du fichier ; `None` si inconnues.
    dimensions: Option<(u32, u32)>,
}

/// Vérifie le fichier à envoyer (lisible, régulier, pas trop gros), devine son type MIME et relève sa taille et,
/// pour une image, ses dimensions. Une image dont l'en-tête est illisible part quand même, avec sa taille seule.
async fn prepare_attachment(path: &std::path::Path) -> Result<PreparedAttachment, String> {
    let meta = tokio::fs::metadata(path).await.map_err(|_| "Fichier illisible.".to_owned())?;
    if !meta.is_file() {
        return Err("Ce n'est pas un fichier.".to_owned());
    }
    check_upload(meta.len())?;
    let mime = mime_for(path);
    let dimensions = if mime.type_() == mime::IMAGE {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || image_dimensions(&path)).await.ok().flatten()
    } else {
        None
    };
    Ok(PreparedAttachment { mime, size: meta.len(), dimensions })
}

/// Dimensions d'une image (png, jpeg, gif, webp) lues dans l'en-tête du fichier, sans décoder l'image.
fn image_dimensions(path: &std::path::Path) -> Option<(u32, u32)> {
    let size = imagesize::size(path).ok()?;
    Some((u32::try_from(size.width).ok()?, u32::try_from(size.height).ok()?))
}

/// En-tête `info` de l'événement, selon le type MIME. Un champ inconnu reste `None` : rien n'est inventé.
fn attachment_info(prepared: &PreparedAttachment) -> AttachmentInfo {
    let size = matrix_sdk::ruma::UInt::new(prepared.size);
    let dimension = |value: u32| Some(matrix_sdk::ruma::UInt::from(value));
    let (width, height) = match prepared.dimensions {
        Some((w, h)) => (dimension(w), dimension(h)),
        None => (None, None),
    };
    match prepared.mime.type_() {
        mime::IMAGE => AttachmentInfo::Image(BaseImageInfo { height, width, size, blurhash: None, is_animated: None }),
        mime::VIDEO => AttachmentInfo::Video(BaseVideoInfo { duration: None, height: None, width: None, size, blurhash: None }),
        mime::AUDIO => AttachmentInfo::Audio(BaseAudioInfo { duration: None, size, waveform: None }),
        _ => AttachmentInfo::File(BaseFileInfo { size }),
    }
}

fn uint_u64(value: Option<matrix_sdk::ruma::UInt>) -> Option<u64> {
    value.map(u64::from)
}

fn uint_u32(value: Option<matrix_sdk::ruma::UInt>) -> Option<u32> {
    value.and_then(|v| u32::try_from(u64::from(v)).ok())
}

fn media_key(source: &MediaSource) -> (String, bool) {
    match source {
        MediaSource::Plain(uri) => (uri.to_string(), false),
        MediaSource::Encrypted(file) => (file.url.to_string(), true),
    }
}

/// Durée de validité côté serveur d'une notice « j'écris » (même valeur que le SDK, qui attend une relance
/// toutes les ~3 s : voir `TYPING_RESEND_MS` dans `domain`).
const TYPING_SERVER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Requête `m.typing` explicite : `true` = « j'écris » (valable [`TYPING_SERVER_TIMEOUT`]), `false` = « j'ai cessé ».
fn typing_request(
    user: matrix_sdk::ruma::OwnedUserId,
    room: matrix_sdk::ruma::OwnedRoomId,
    typing: bool,
) -> create_typing_event::v3::Request {
    let state = if typing {
        Typing::Yes(TypingInfo::new(TYPING_SERVER_TIMEOUT))
    } else {
        Typing::No
    };
    create_typing_event::v3::Request::new(user, room, state)
}

/// Envoie l'état de frappe **sans passer par `Room::typing_notice`** : ce dernier ignore un arrêt quand sa
/// propre fenêtre locale de 4 s est écoulée, alors que le serveur peut encore afficher « écrit… » (il
/// n'expire les notices que paresseusement). Le seul dédoublonnage est celui de `domain::TypingThrottle`.
async fn send_typing(client: &Client, room: &matrix_sdk::Room, typing: bool) -> Result<(), String> {
    let user = client.user_id().ok_or("session sans identifiant utilisateur")?.to_owned();
    let request = typing_request(user, room.room_id().to_owned(), typing);
    client.send(request).await.map(|_| ()).map_err(|err| err.to_string())
}

/// Média décrit par un message `image`/`file`/`audio`/`video` (+ requête de téléchargement pour une image).
fn media_of(message_type: &MessageType) -> Option<(MediaVm, Option<ImageRequest>)> {
    let (kind, filename, source, size, mime, width, height) = match message_type {
        MessageType::Image(c) => {
            let info = c.info.as_deref();
            (
                MediaKind::Image,
                c.filename().to_owned(),
                &c.source,
                uint_u64(info.and_then(|i| i.size)),
                info.and_then(|i| i.mimetype.clone()),
                uint_u32(info.and_then(|i| i.width)),
                uint_u32(info.and_then(|i| i.height)),
            )
        }
        MessageType::File(c) => {
            let info = c.info.as_deref();
            (
                MediaKind::File,
                c.filename().to_owned(),
                &c.source,
                uint_u64(info.and_then(|i| i.size)),
                info.and_then(|i| i.mimetype.clone()),
                None,
                None,
            )
        }
        MessageType::Audio(c) => {
            let info = c.info.as_deref();
            (
                MediaKind::Audio,
                c.filename().to_owned(),
                &c.source,
                uint_u64(info.and_then(|i| i.size)),
                info.and_then(|i| i.mimetype.clone()),
                None,
                None,
            )
        }
        MessageType::Video(c) => {
            let info = c.info.as_deref();
            (
                MediaKind::Video,
                c.filename().to_owned(),
                &c.source,
                uint_u64(info.and_then(|i| i.size)),
                info.and_then(|i| i.mimetype.clone()),
                uint_u32(info.and_then(|i| i.width)),
                uint_u32(info.and_then(|i| i.height)),
            )
        }
        _ => return None,
    };
    let (key, encrypted) = media_key(source);
    let request = match message_type {
        MessageType::Image(c) => Some(ImageRequest {
            key: key.clone(),
            source: c.source.clone(),
            thumbnail: c.info.as_deref().and_then(|i| i.thumbnail_source.clone()),
            declared_size: size,
        }),
        _ => None,
    };
    let media = MediaVm {
        key,
        kind,
        filename,
        size,
        mime,
        width,
        height,
        encrypted,
        status: MediaStatus::Available,
    };
    Some((media, request))
}

/// `HH:MM` dans le fuseau donné ; chaîne vide si l'horodatage est hors bornes.
pub fn format_time_label<Tz: TimeZone>(timestamp_ms: u64, zone: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    i64::try_from(timestamp_ms)
        .ok()
        .and_then(DateTime::from_timestamp_millis)
        .map(|utc| utc.with_timezone(zone).format("%H:%M").to_string())
        .unwrap_or_default()
}

/// Clé de cache d'une photo de profil (même clé côté UI : `domain::avatar_key`).
fn avatar_key(mxc: &str) -> String {
    domain::avatar_key(mxc)
}

fn localpart(user_id: &str) -> &str {
    user_id.trim_start_matches('@').split(':').next().unwrap_or(user_id)
}

/// Noms courts (triés) de ceux qui ont lu un message : tous les accusés posés dessus, sauf le mien et celui
/// de l'expéditeur (son accusé sur son propre message ne dit rien : ce n'est pas une lecture par un tiers).
fn readers<'a>(
    receipt_users: impl IntoIterator<Item = &'a SdkUserId>,
    sender: &SdkUserId,
    own: Option<&SdkUserId>,
) -> Vec<String> {
    let mut names: Vec<String> = receipt_users
        .into_iter()
        .filter(|user| Some(*user) != own && *user != sender)
        .map(|user| localpart(user.as_str()).to_owned())
        .collect();
    names.sort();
    names
}

/// Convertit un élément du SDK ; `None` pour ce qui n'est pas un message (séparateurs, changements
/// d'état, appartenance…).
fn to_event_vm(
    item: &TimelineItem,
    own_user: Option<&SdkUserId>,
    requests: &mut Vec<ImageRequest>,
) -> Option<EventVm> {
    let event = item.as_event()?;
    let TimelineItemContent::MsgLike(content) = event.content() else {
        return None;
    };
    let mut edited = false;
    let mut media: Option<MediaVm> = None;
    let (body, mut state) = match &content.kind {
        MsgLikeKind::Message(message) => {
            edited = message.is_edited();
            match media_of(message.msgtype()) {
                Some((vm, request)) => {
                    requests.extend(request);
                    let name = vm.filename.clone();
                    media = Some(vm);
                    (name, EventState::Normal)
                }
                None => (message.body().to_owned(), EventState::Normal),
            }
        }
        MsgLikeKind::UnableToDecrypt(_) => {
            (UNDECRYPTABLE_PLACEHOLDER.to_owned(), EventState::Indechiffrable)
        }
        MsgLikeKind::Redacted => (REDACTED_PLACEHOLDER.to_owned(), EventState::Supprime),
        MsgLikeKind::Sticker(_) => ("[autocollant]".to_owned(), EventState::Normal),
        MsgLikeKind::Poll(_) => ("[sondage]".to_owned(), EventState::Normal),
        _ => ("[contenu non pris en charge]".to_owned(), EventState::Normal),
    };
    if event.is_local_echo() && state == EventState::Normal {
        state = match event.send_state() {
            Some(EventSendState::SendingFailed { .. }) => EventState::EchecEnvoi,
            _ => EventState::Local,
        };
        // Pièce jointe en cours d'envoi : progression ; échec : état lisible (jamais l'erreur brute).
        if let Some(vm) = media.as_mut() {
            vm.status = match event.send_state() {
                Some(EventSendState::NotSentYet { progress }) => MediaStatus::Uploading(
                    progress.as_ref().and_then(|p| {
                        let (current, total) = (p.progress.current, p.progress.total);
                        (total > 0).then(|| u8::try_from((current * 100 / total).min(100)).unwrap_or(100))
                    }),
                ),
                Some(EventSendState::SendingFailed { .. }) => {
                    MediaStatus::UploadFailed("envoi échoué".to_owned())
                }
                _ => MediaStatus::Available,
            };
        }
    }

    // Identifiant unique de l'élément de timeline : il ne change pas quand l'écho local devient
    // l'événement confirmé (contrairement à `identifier()`, qui passe de l'id de transaction à l'id
    // d'événement), donc la fusion par id remplace la ligne au lieu de la dupliquer.
    let id = item.unique_id().0.clone();
    // Photo de profil : lue dans le profil déjà joint à l'élément (aucun appel réseau ici) ; les octets sont
    // demandés à `ImageFetcher` sous la clé `avatar:<mxc>`, dédoublonnée par expéditeur et par timeline.
    let sender_avatar = match event.sender_profile() {
        TimelineDetails::Ready(profile) => profile.avatar_url.clone(),
        _ => None,
    };
    if let Some(mxc) = &sender_avatar {
        requests.push(ImageRequest {
            key: avatar_key(mxc.as_str()),
            source: MediaSource::Plain(mxc.clone()),
            thumbnail: None,
            declared_size: None,
        });
    }
    let sender_name = match event.sender_profile() {
        TimelineDetails::Ready(profile) => profile.display_name.clone(),
        _ => None,
    }
    .filter(|name| !name.trim().is_empty())
    .unwrap_or_else(|| localpart(event.sender().as_str()).to_owned());
    let timestamp_ms = u64::from(event.timestamp().0);
    // Id d'événement réel : seulement une fois confirmé (jamais sur un écho local).
    let event_id = if event.is_local_echo() {
        None
    } else {
        event.event_id().map(|id| EventId::from(id.as_str()))
    };
    // Accusés de lecture posés sur ce message par quelqu'un d'autre que moi **et** que son expéditeur.
    let read_by = readers(event.read_receipts().keys().map(|user| &**user), event.sender(), own_user);

    Some(EventVm {
        id: EventId::from(id.as_str()),
        sender_initials: initials(&sender_name),
        sender_avatar: sender_avatar.map(|mxc| mxc.to_string()),
        sender_name,
        timestamp_ms,
        time_label: format_time_label(timestamp_ms, &Local),
        body,
        state,
        event_id,
        is_own: event.is_own(),
        edited,
        read_by,
        media,
    })
}

fn snapshot<'a>(
    items: impl IntoIterator<Item = &'a std::sync::Arc<TimelineItem>>,
    own_user: Option<&SdkUserId>,
) -> (Vec<EventVm>, Vec<ImageRequest>) {
    let mut requests = Vec::new();
    let events = items.into_iter().filter_map(|item| to_event_vm(item, own_user, &mut requests)).collect();
    (events, requests)
}

/// Suit la timeline de `room` jusqu'à ce que `commands` soit fermé (l'UI a changé de salon) ou que la
/// tâche soit abandonnée. `publish` est appelé pour chaque mise à jour ; il doit être non bloquant.
pub async fn run_timeline(
    client: Client,
    room: RoomId,
    mut commands: UnboundedReceiver<TimelineCommand>,
    media_cache: std::sync::Arc<MediaCache>,
    publish: impl Fn(TimelineUpdate),
) {
    let fail = |message: String| publish(TimelineUpdate::Failed { room: room.clone(), message });
    let send_failed = |text: String, message: String| {
        publish(TimelineUpdate::SendFailed { room: room.clone(), text, message })
    };
    let edit_failed = |event_id: String, text: String, message: String| {
        publish(TimelineUpdate::EditFailed {
            room: room.clone(),
            event_id: EventId::from(event_id.as_str()),
            text,
            message,
        })
    };
    let delete_failed = |event_id: String, message: String| {
        publish(TimelineUpdate::DeleteFailed {
            room: room.clone(),
            event_id: EventId::from(event_id.as_str()),
            message,
        })
    };
    let attach_failed = |path: String, message: String| {
        publish(TimelineUpdate::AttachmentFailed { room: room.clone(), path, message })
    };
    let events = |events: Vec<EventVm>, at_start: Option<bool>| {
        publish(TimelineUpdate::Events { room: room.clone(), events, at_start })
    };

    let Ok(room_id) = <&SdkRoomId>::try_from(room.as_str()) else {
        return fail("Identifiant de salon invalide.".to_owned());
    };
    let Some(sdk_room) = client.get_room(room_id) else {
        return fail("Salon introuvable sur ce compte.".to_owned());
    };
    // Le cache d'événements est déjà abonné depuis la connexion ou la restauration de la session (`enable_event_cache`) : sans lui, la
    // pagination ne reçoit rien et les messages arrivés avant l'ouverture du salon manquent (D-W05-1). Cet appel
    // est un filet idempotent : « déjà abonné » est un succès pour le SDK, jamais une erreur.
    if let Err(err) = crate::client::enable_event_cache(&client).await {
        return fail(err.to_string());
    }
    let own_user = client.user_id().map(ToOwned::to_owned);
    let (media_tx, mut media_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut fetcher = ImageFetcher::new(client.clone(), media_cache, media_tx);
    // Instantané → événements affichables + téléchargement des images nouvellement vues.
    macro_rules! emit {
        ($items:expr, $at_start:expr) => {{
            let (vms, requests) = snapshot($items, own_user.as_deref());
            fetcher.request(requests);
            events(vms, $at_start);
        }};
    }
    let (_typing_guard, mut typing_rx) = sdk_room.subscribe_to_typing_notifications();
    let timeline = match sdk_room.timeline().await {
        Ok(timeline) => timeline,
        Err(err) => return fail(MatrixError::Other(err.to_string()).to_string()),
    };

    let (initial, stream) = timeline.subscribe().await;
    let mut stream = Box::pin(stream);
    emit!(initial.iter(), None);

    match timeline.paginate_backwards(PAGE_SIZE).await {
        Ok(hit_start) => emit!(timeline.items().await.iter(), Some(hit_start)),
        Err(err) => fail(MatrixError::Other(err.to_string()).to_string()),
    }

    loop {
        tokio::select! {
            batch = stream.next() => {
                if batch.is_none() {
                    return fail("Timeline interrompue.".to_owned());
                }
                emit!(timeline.items().await.iter(), None);
            }
            Some((key, payload)) = media_rx.recv() => {
                publish(TimelineUpdate::Media { room: room.clone(), key, payload });
            }
            typing = typing_rx.recv() => match typing {
                Ok(users) => publish(TimelineUpdate::Typing {
                    room: room.clone(),
                    users: users.iter().map(|user| localpart(user.as_str()).to_owned()).collect(),
                }),
                // Retard : on attend la prochaine notification, qui contient l'état complet.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
            },
            command = commands.recv() => match command {
                Some(TimelineCommand::Edit { event_id, body }) => {
                    let result = match <&SdkEventId>::try_from(event_id.as_str()) {
                        Ok(id) => {
                            let content = EditedContent::RoomMessage(
                                RoomMessageEventContentWithoutRelation::text_plain(body.clone()),
                            );
                            timeline
                                .edit(&TimelineEventItemId::EventId(id.to_owned()), content)
                                .await
                                .map_err(|err| err.to_string())
                        }
                        Err(_) => Err("identifiant de message invalide".to_owned()),
                    };
                    if let Err(err) = result {
                        edit_failed(event_id, body, format!("Modification impossible : {err}"));
                    }
                }
                Some(TimelineCommand::Redact { event_id }) => {
                    let result = match <&SdkEventId>::try_from(event_id.as_str()) {
                        Ok(id) => timeline
                            .redact(&TimelineEventItemId::EventId(id.to_owned()), None)
                            .await
                            .map_err(|err| err.to_string()),
                        Err(_) => Err("identifiant de message invalide".to_owned()),
                    };
                    if let Err(err) = result {
                        delete_failed(event_id, format!("Suppression impossible : {err}"));
                    }
                }
                Some(TimelineCommand::SendAttachment(path)) => {
                    let shown = path.to_string_lossy().into_owned();
                    match prepare_attachment(&path).await {
                        Ok(prepared) => {
                            let config = AttachmentConfig { info: Some(attachment_info(&prepared)), ..Default::default() };
                            let sent = timeline.send_attachment(path.clone(), prepared.mime, config).await;
                            if let Err(err) = sent {
                                attach_failed(shown, format!("Envoi de la pièce jointe impossible : {err}"));
                            }
                        }
                        Err(message) => attach_failed(shown, message),
                    }
                }
                Some(TimelineCommand::MarkRead) => {
                    // Un accusé de lecture raté n'a pas de conséquence visible : le prochain essai suivra.
                    let _ = timeline.mark_as_read(ReceiptType::Read).await;
                }
                Some(TimelineCommand::Typing(typing)) => {
                    // Une notice de frappe ratée n'est pas fatale, mais elle n'est plus avalée en silence.
                    if let Err(err) = send_typing(&client, &sdk_room, typing).await {
                        eprintln!("waifu-desktop : notice de frappe ({typing}) non envoyée : {err}");
                    }
                }
                None => return,
                Some(TimelineCommand::SendText(body)) => {
                    // La file d'envoi du SDK chiffre si besoin ; l'écho local arrive par le flux.
                    let content = RoomMessageEventContent::text_plain(body.clone());
                    if let Err(err) = timeline.send(content.into()).await {
                        send_failed(body, format!("Envoi impossible : {err}"));
                    }
                }
                Some(TimelineCommand::LoadOlder) => {
                    match timeline.paginate_backwards(PAGE_SIZE).await {
                        Ok(hit_start) => {
                            emit!(timeline.items().await.iter(), Some(hit_start));
                        }
                        Err(err) => fail(MatrixError::Other(err.to_string()).to_string()),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{FixedOffset, Utc};

    use super::*;

    /// PNG minimal en mémoire : signature + chunk IHDR (l'en-tête suffit, rien n'est décodé).
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]); // profondeur, type, compression, filtre, entrelacement, CRC
        bytes
    }

    fn write_temp(name: &str, bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("dossier temporaire");
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).expect("écriture");
        (dir, path)
    }

    #[test]
    fn image_dimensions_are_read_from_the_png_header() {
        let (_dir, path) = write_temp("a.png", &png_header(8, 4));
        assert_eq!(image_dimensions(&path), Some((8, 4)));
    }

    #[test]
    fn unreadable_image_headers_give_no_dimensions() {
        let (_dir, path) = write_temp("b.png", b"ceci n'est pas une image");
        assert_eq!(image_dimensions(&path), None);
        assert_eq!(image_dimensions(std::path::Path::new("/inexistant/c.png")), None);
    }

    #[tokio::test]
    async fn prepare_attachment_reports_mime_size_and_dimensions_of_an_image() {
        let bytes = png_header(8, 4);
        let (_dir, path) = write_temp("d.png", &bytes);
        let prepared = prepare_attachment(&path).await.expect("fichier valide");
        assert_eq!(prepared, PreparedAttachment { mime: mime::IMAGE_PNG, size: bytes.len() as u64, dimensions: Some((8, 4)) });
    }

    #[tokio::test]
    async fn an_image_with_a_broken_header_is_still_sent_with_its_size_only() {
        let (_dir, path) = write_temp("e.png", b"pas un png");
        let prepared = prepare_attachment(&path).await.expect("l'envoi n'est pas bloqué");
        assert_eq!((prepared.size, prepared.dimensions), (10, None));
        match attachment_info(&prepared) {
            AttachmentInfo::Image(info) => {
                assert_eq!(info.size.map(u64::from), Some(10));
                assert_eq!((info.width, info.height), (None, None), "aucune dimension inventée");
            }
            other => panic!("attendu une image, obtenu {other:?}"),
        }
    }

    #[tokio::test]
    async fn prepare_attachment_still_refuses_what_check_upload_refuses() {
        assert!(prepare_attachment(std::path::Path::new("/inexistant/f.png")).await.is_err());
        let dir = tempfile::tempdir().expect("dossier temporaire");
        assert!(prepare_attachment(dir.path()).await.is_err(), "un dossier n'est pas un fichier");
    }

    #[test]
    fn the_info_header_follows_the_mime_type_and_never_invents_a_field() {
        let prepared = |mime: mime::Mime, dimensions| PreparedAttachment { mime, size: 1234, dimensions };
        let size = |value: Option<matrix_sdk::ruma::UInt>| value.map(u64::from);
        let dim = |value: Option<matrix_sdk::ruma::UInt>| value.map(u64::from);

        match attachment_info(&prepared(mime::IMAGE_PNG, Some((8, 4)))) {
            AttachmentInfo::Image(i) => assert_eq!((size(i.size), dim(i.width), dim(i.height)), (Some(1234), Some(8), Some(4))),
            other => panic!("image attendue : {other:?}"),
        }
        // Vidéo : taille seulement (dimensions et durée inconnues, jamais déduites).
        match attachment_info(&prepared("video/mp4".parse().expect("mime"), Some((8, 4)))) {
            AttachmentInfo::Video(i) => {
                assert_eq!((size(i.size), dim(i.width), dim(i.height), i.duration), (Some(1234), None, None, None));
            }
            other => panic!("vidéo attendue : {other:?}"),
        }
        match attachment_info(&prepared("audio/ogg".parse().expect("mime"), None)) {
            AttachmentInfo::Audio(i) => assert_eq!((size(i.size), i.duration), (Some(1234), None)),
            other => panic!("audio attendu : {other:?}"),
        }
        match attachment_info(&prepared(mime::APPLICATION_OCTET_STREAM, None)) {
            AttachmentInfo::File(i) => assert_eq!(size(i.size), Some(1234)),
            other => panic!("fichier attendu : {other:?}"),
        }
    }

    #[test]
    fn time_label_uses_the_given_zone() {
        // 2026-11-15 13:05:00 UTC
        let ts = 1_794_747_900_000;
        assert_eq!(format_time_label(ts, &Utc), "13:05");
        let paris = FixedOffset::east_opt(3600).expect("offset");
        assert_eq!(format_time_label(ts, &paris), "14:05");
    }

    #[test]
    fn time_label_is_empty_when_out_of_range() {
        assert_eq!(format_time_label(u64::MAX, &Utc), "");
    }

    fn user(id: &str) -> matrix_sdk::ruma::OwnedUserId {
        SdkUserId::parse(id).expect("identifiant de test valide")
    }

    #[test]
    fn a_message_seen_only_by_me_and_its_sender_has_no_readers() {
        let (alice, bob) = (user("@alice:localhost"), user("@bob:localhost"));
        // Chez bob : message d'alice, reçus {alice (expéditrice), bob (moi)}.
        assert_eq!(readers([&*alice, &*bob], &alice, Some(&bob)), Vec::<String>::new());
    }

    #[test]
    fn a_third_party_is_the_only_reader_listed() {
        let (alice, bob, carol) = (user("@alice:localhost"), user("@bob:localhost"), user("@carol:localhost"));
        assert_eq!(readers([&*alice, &*bob, &*carol], &alice, Some(&bob)), ["carol"]);
    }

    #[test]
    fn my_own_message_lists_the_others_who_read_it() {
        let (alice, bob) = (user("@alice:localhost"), user("@bob:localhost"));
        // Message de bob (moi), accusés {bob, alice} : alice l'a lu.
        assert_eq!(readers([&*bob, &*alice], &bob, Some(&bob)), ["alice"]);
        // Sans identifiant « moi » connu, l'expéditeur reste exclu.
        assert_eq!(readers([&*bob, &*alice], &bob, None), ["alice"]);
    }

    #[test]
    fn readers_are_sorted_for_a_stable_display() {
        let (alice, bob, carol, dave) = (user("@alice:localhost"), user("@bob:localhost"), user("@carol:localhost"), user("@dave:localhost"));
        assert_eq!(readers([&*dave, &*carol, &*bob], &alice, Some(&alice)), ["bob", "carol", "dave"]);
    }

    #[test]
    fn typing_requests_carry_an_explicit_state_and_a_short_server_timeout() {
        let room = matrix_sdk::ruma::OwnedRoomId::try_from("!r:localhost").expect("salon valide");
        let start = typing_request(user("@bob:localhost"), room.clone(), true);
        match start.state {
            Typing::Yes(info) => assert_eq!(info.timeout, TYPING_SERVER_TIMEOUT),
            Typing::No => panic!("une frappe active doit être `Yes`"),
        }
        let stop = typing_request(user("@bob:localhost"), room, false);
        assert!(matches!(stop.state, Typing::No), "l'arrêt est un `m.typing: false` explicite");
    }

    #[test]
    fn localpart_strips_sigil_and_server() {
        assert_eq!(localpart("@alice:example.org"), "alice");
        assert_eq!(localpart("alice"), "alice");
    }
}
