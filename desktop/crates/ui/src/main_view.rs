//! Vue principale après connexion : barre latérale des salons, zone centrale (sans timeline avant
//! l'étape 5) et modal de clé de récupération. Aucun appel réseau : tout arrive par `set_*`.

use std::cell::RefCell;
use std::fmt;

use std::collections::HashMap;
use std::sync::Arc;

use domain::{
    last_read_marker, ConnectionState, media_display, prepare_message, read_by_label, sniff_image_format,
    typing_label, validate_recovery_key, EventId, EventState, EventVm, FailedAction, ImageKind,
    KeyStatus, MediaDisplay, MediaKind, MediaPayload, MediaStatus, MediaVm, RecoveryKey, RoomId,
    RoomKind, RoomVm, TimelineState, TimelineStatus, TimelineUpdate, TypingThrottle,
    THUMBNAIL_SIDE, TYPING_IDLE_MS,
};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::{Disableable, Sizable};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::demo;
use crate::modal::ModalState;

const BACKGROUND: u32 = 0x0b0b12;
const PANEL: u32 = 0x12121f;
const HOVER: u32 = 0x252540;
const SELECTED: u32 = 0x2e2e50;
const BORDER: u32 = 0x2a2a40;
const TEXT: u32 = 0xe8e8f0;
const TEXT_SECONDARY: u32 = 0x8888a8;
const ACCENT: u32 = 0xff2d78;
const ERROR: u32 = 0xff5c7a;
const SIDEBAR_WIDTH: f32 = 280.0;
/// Hauteur **constante** d'une ligne de message : prérequis de la virtualisation (`uniform_list`).
pub const EVENT_ROW_HEIGHT: f32 = 52.0;
/// Largeur réservée aux boutons Modifier / Supprimer, à droite de chaque ligne.
const ACTIONS_COLUMN_WIDTH: f32 = 150.0;
/// On demande une page plus ancienne quand la vue est à moins de N lignes du haut de la liste.
const PAGINATE_THRESHOLD_ROWS: f32 = 5.0;
/// Sous ce nombre de lignes chargées, la liste ne remplit peut-être pas la fenêtre : on pagine d'office.
const FILL_ROWS: usize = 20;
/// Hauteur réservée au bandeau « chargement… / début de la conversation » (constante, voir plus bas).
const BANNER_HEIGHT: f32 = 24.0;
/// Délai avant la confirmation simulée d'un envoi en mode démonstration.
const DEMO_CONFIRM_DELAY: std::time::Duration = std::time::Duration::from_millis(600);
const COMPOSER_PLACEHOLDER: &str = "Écrire un message… (Entrée : envoyer, Maj+Entrée : saut de ligne)";

/// Ce que la liste de salons affiche.
#[derive(Debug, Clone, PartialEq)]
pub enum RoomsState {
    /// Aucune synchronisation terminée : état « synchronisation… », pas une liste vide trompeuse.
    Syncing,
    Ready(Vec<RoomVm>),
    Failed(String),
}

/// Transfère la clé de récupération à l'application **une seule fois** : un événement GPUI est
/// passé par référence, et `RecoveryKey` ne se clone pas.
pub struct KeyHandoff(RefCell<Option<RecoveryKey>>);

impl KeyHandoff {
    fn new(key: RecoveryKey) -> Self {
        Self(RefCell::new(Some(key)))
    }

    /// Récupère la clé ; `None` si elle a déjà été prise.
    pub fn take(&self) -> Option<RecoveryKey> {
        self.0.borrow_mut().take()
    }
}

impl fmt::Debug for KeyHandoff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeyHandoff(<masquée>)")
    }
}

/// Événements émis vers l'application.
#[derive(Debug)]
pub enum MainEvent {
    SubmitRecoveryKey(KeyHandoff),
    SignOut,
    /// Un salon vient d'être sélectionné (ou sa timeline doit être rechargée) : ouvrir sa timeline.
    SelectRoom(RoomId),
    /// Charger une page plus ancienne du salon sélectionné.
    LoadOlder(RoomId),
    /// Envoyer `body` (texte déjà validé, non vide) dans `room`.
    SendText { room: RoomId, body: String },
    /// Remplacer le texte du message `event_id` par `body`.
    EditText { room: RoomId, event_id: EventId, body: String },
    /// Supprimer (redacter) le message `event_id`.
    Redact { room: RoomId, event_id: EventId },
    /// Marquer le salon comme lu (accusé de lecture jusqu'au dernier message).
    MarkRead(RoomId),
    /// Annoncer (`true`) ou cesser d'annoncer (`false`) que j'écris.
    Typing { room: RoomId, typing: bool },
    /// Envoyer le fichier `path` en pièce jointe (lu et envoyé côté Tokio, jamais par l'UI).
    SendAttachment { room: RoomId, path: String },
}

/// Message affiché quand le sélecteur de fichiers du système ne répond pas.
pub const PICKER_UNAVAILABLE: &str = "Le sélecteur de fichiers du système n'est pas disponible \
    (portail xdg-desktop-portal introuvable ?) : la pièce jointe n'a pas été envoyée.";

/// Issue du sélecteur de fichiers du système.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickResult {
    Chosen(std::path::PathBuf),
    /// L'utilisateur a fermé le sélecteur sans choisir : pas une erreur.
    Cancelled,
    /// Pas de sélecteur (portail absent) ou erreur de la plateforme.
    Unavailable,
}

/// Classe le résultat brut de `prompt_for_paths` (canal, puis résultat de la plateforme, puis choix).
pub fn classify_pick<E1, E2>(
    outcome: Result<Result<Option<Vec<std::path::PathBuf>>, E1>, E2>,
) -> PickResult {
    match outcome {
        Ok(Ok(Some(mut paths))) => paths.pop().map_or(PickResult::Cancelled, PickResult::Chosen),
        Ok(Ok(None)) => PickResult::Cancelled,
        Ok(Err(_)) | Err(_) => PickResult::Unavailable,
    }
}

/// Ce qu'il faut pour dessiner un média dans une ligne (calculé hors de l'arbre d'éléments).
struct MediaRender {
    display: MediaDisplay,
    image: Option<Arc<Image>>,
    /// Taille de l'image dans la boîte de vignette, ratio conservé.
    thumb: (u32, u32),
    /// Texte court de la carte d'un fichier (extension en majuscules).
    card_label: String,
    /// Libellé d'accessibilité : type, nom, état.
    aria: String,
}

impl MediaRender {
    fn of(media: &MediaVm, timeline: &TimelineState, images: &HashMap<String, Arc<Image>>) -> Self {
        let display = media_display(media, &timeline.media_load(&media.key));
        let card_label = std::path::Path::new(&media.filename)
            .extension()
            .map(|ext| ext.to_string_lossy().to_uppercase())
            .filter(|ext| !ext.is_empty() && ext.chars().count() <= 4)
            .unwrap_or_else(|| media.kind.label().to_uppercase().chars().take(4).collect());
        let aria = match &display {
            MediaDisplay::Unavailable(reason) => format!("Média indisponible : {} ({reason})", media.filename),
            MediaDisplay::UploadFailed(_) => format!("Envoi en échec : {}", media.filename),
            MediaDisplay::Uploading(_) => format!("Envoi en cours : {}", media.filename),
            _ => format!("{} : {}", media.kind.label(), media.summary()),
        };
        Self {
            display,
            image: images.get(&media.key).cloned(),
            thumb: media.thumbnail_size(THUMBNAIL_SIDE),
            card_label,
            aria,
        }
    }
}

pub struct MainView {
    user_label: String,
    rooms: RoomsState,
    /// Liaison avec le serveur : bandeau « connexion » / « hors ligne » tant que ce n'est pas `Online`.
    connection: ConnectionState,
    timeline: TimelineState,
    scroll: UniformListScrollHandle,
    /// Suit la zone de la liste (cadre de l'image précédente) : sa hauteur sert à caler la liste sur un
    /// nombre entier de lignes.
    list_frame: ScrollHandle,
    /// Hauteur de la zone de liste au dernier rendu : un changement impose un rendu de plus.
    list_seen: Pixels,
    /// Hauteur vue par le rendu précédent, pour détecter qu'elle a bougé entre deux rendus.
    list_seen_prev: Pixels,
    /// Le prochain rendu est un rendu de vérification de la hauteur.
    list_verifying: bool,
    /// La liste était collée en bas lors du dernier rendu stable (la hauteur n'avait pas bougé).
    list_pinned: bool,
    keys: KeyStatus,
    modal: ModalState,
    key_input: Entity<InputState>,
    /// Zone de saisie des messages : une ligne qui grandit jusqu'à 5.
    composer: Entity<TextareaState>,
    /// Brouillon d'un envoi échoué à remettre dans le champ au prochain rendu.
    pending_restore: Option<String>,
    /// Images décodables des médias prêts, par identifiant logique (construites hors rendu).
    images: HashMap<String, Arc<Image>>,
    /// Ligne sélectionnée (clic) : surlignée, y compris pour une pièce jointe en échec.
    selected_event: Option<EventId>,
    /// Message d'état visible au-dessus de la saisie (ex. sélecteur de fichiers indisponible).
    notice: Option<String>,
    /// Message en cours de modification (son id d'événement) : la saisie est alors en « mode édition ».
    editing: Option<EventId>,
    /// Message dont la suppression attend sa confirmation.
    pending_delete: Option<EventId>,
    /// Limite les notices « j'écris » ; l'horloge est `clock`.
    typing_throttle: TypingThrottle,
    /// Incrémenté à chaque frappe : un minuteur d'inactivité périmé ne fait rien.
    typing_gen: u64,
    clock: std::time::Instant,
    /// Compteur des échos locaux de démonstration.
    demo_sent: u32,
    /// Démonstration : l'écho local n'est jamais confirmé (pour le montrer à l'écran).
    demo_hold_pending: bool,
    /// Mode `--demo-ui` : aucune connexion, la saisie de clé n'est jamais transmise.
    demo: bool,
}

impl EventEmitter<MainEvent> for MainView {}

impl MainView {
    pub fn new(user_label: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let key_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Clé de récupération").masked(true)
        });
        cx.subscribe_in(&key_input, window, |this, _, event: &InputEvent, window, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.submit_key(window, cx);
            }
        })
        .detach();
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 5)
                .placeholder(COMPOSER_PLACEHOLDER)
                .submit_on_enter(true)
        });
        // Désactivée tant qu'aucun salon n'est sélectionné.
        composer.update(cx, |state, cx| state.set_disabled(true, cx));
        cx.subscribe_in(&composer, window, |this, _, event: &InputEvent, window, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => this.submit_composer(window, cx),
            InputEvent::Change => this.on_composer_changed(cx),
            _ => {}
        })
        .detach();
        Self {
            user_label,
            rooms: RoomsState::Syncing,
            connection: ConnectionState::default(),
            timeline: TimelineState::default(),
            scroll: UniformListScrollHandle::new(),
            list_frame: ScrollHandle::new(),
            list_seen: px(0.0),
            list_seen_prev: px(0.0),
            list_verifying: false,
            list_pinned: true,
            keys: KeyStatus::Unknown,
            modal: ModalState::default(),
            key_input,
            composer,
            pending_restore: None,
            images: HashMap::new(),
            selected_event: None,
            notice: None,
            editing: None,
            pending_delete: None,
            typing_throttle: TypingThrottle::default(),
            typing_gen: 0,
            clock: std::time::Instant::now(),
            demo_sent: 0,
            demo_hold_pending: false,
            demo: false,
        }
    }

    /// Écran de démonstration hors ligne : 3 salons factices (espace, salon, DM) et le modal de clé
    /// de récupération ouvert. Aucun client, aucun réseau.
    pub fn demo(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::new("@demo:hors-ligne".to_owned(), window, cx);
        view.rooms = RoomsState::Ready(demo::demo_rooms());
        view.keys = KeyStatus::Needed;
        view.modal.open();
        view.demo = true;
        view
    }

    pub fn set_rooms(&mut self, rooms: RoomsState, cx: &mut Context<Self>) {
        // Une sélection dont le salon a disparu est abandonnée.
        if let (Some(selected), RoomsState::Ready(list)) = (self.timeline.room(), &rooms) {
            if !list.iter().any(|r| &r.id == selected) {
                self.timeline.clear();
            }
        }
        self.rooms = rooms;
        self.keep_open_room_read();
        self.sync_composer(cx);
        cx.notify();
    }

    /// Échec de synchronisation : n'écrase pas une liste déjà affichée (on garde la dernière bonne).
    pub fn set_sync_failure(&mut self, message: String, cx: &mut Context<Self>) {
        if self.rooms == RoomsState::Syncing {
            self.rooms = RoomsState::Failed(message);
            cx.notify();
        }
    }

    /// Instantané initial lu dans le store local, avant toute réponse du serveur : on affiche les salons déjà
    /// connus tout de suite. Un instantané **vide** n'apprend rien (premier démarrage, rien en store) : on garde
    /// « Synchronisation… » plutôt que d'annoncer « aucun salon ». L'état de connexion n'est jamais dégradé par
    /// ce message (une réponse du serveur ou une coupure peut déjà avoir été reçue).
    pub fn apply_local_snapshot(&mut self, rooms: Vec<RoomVm>, keys: KeyStatus, cx: &mut Context<Self>) {
        if !rooms.is_empty() {
            self.set_rooms(RoomsState::Ready(rooms), cx);
        }
        self.set_key_status(keys, cx);
    }

    /// Instantané issu d'une réponse du serveur : liste à jour, connexion rétablie (le bandeau disparaît).
    pub fn apply_server_snapshot(&mut self, rooms: Vec<RoomVm>, keys: KeyStatus, cx: &mut Context<Self>) {
        self.set_rooms(RoomsState::Ready(rooms), cx);
        self.set_key_status(keys, cx);
        self.set_connection(ConnectionState::Online, cx);
    }

    pub fn set_connection(&mut self, connection: ConnectionState, cx: &mut Context<Self>) {
        if self.connection != connection {
            self.connection = connection;
            cx.notify();
        }
    }

    pub fn connection(&self) -> &ConnectionState {
        &self.connection
    }

    pub fn set_key_status(&mut self, keys: KeyStatus, cx: &mut Context<Self>) {
        self.keys = keys;
        cx.notify();
    }

    pub fn open_recovery(&mut self, cx: &mut Context<Self>) {
        self.modal.open();
        cx.notify();
    }

    pub fn close_recovery(&mut self, cx: &mut Context<Self>) {
        self.modal.close();
        cx.notify();
    }

    /// Résultat du déverrouillage : `Ok` ferme le modal et vide le champ, `Err` affiche le message.
    pub fn finish_recovery(
        &mut self,
        outcome: Result<(), String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match outcome {
            Ok(()) => {
                self.modal.succeed();
                self.keys = KeyStatus::NotNeeded;
            }
            Err(message) => self.modal.fail(message),
        }
        self.key_input.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.set_disabled(false, cx);
        });
        cx.notify();
    }

    /// Démonstration centrée sur la timeline : comme [`MainView::demo`], mais le modal est fermé et le
    /// salon « général » (200 messages factices, 50 chargés) est déjà sélectionné.
    pub fn demo_timeline(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::demo(window, cx);
        view.modal.close();
        view.start_timeline(RoomId::from(demo::ROOM_ID), cx);
        // Démonstration : un autre membre est en train d'écrire.
        view.timeline.apply(TimelineUpdate::Typing {
            room: RoomId::from(demo::ROOM_ID),
            users: vec!["Alice Demo".to_owned()],
        });
        view
    }

    /// Démonstration de l'envoi : comme [`MainView::demo_timeline`], avec un message déjà « envoyé » dont
    /// l'écho local n'est jamais confirmé (état `Local` visible à l'écran).
    pub fn demo_send(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::demo_timeline(window, cx);
        view.demo_hold_pending = true;
        if let Some(room) = view.timeline.room().cloned() {
            view.send_body(room, "Bonjour depuis la démo !".to_owned(), window, cx);
        }
        view
    }

    /// Démonstration des médias : comme [`MainView::demo_timeline`], avec des images générées à la volée,
    /// un fichier, une image chiffrée indisponible, un envoi en cours et une pièce jointe en échec.
    pub fn demo_media(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::demo_timeline(window, cx);
        let room = RoomId::from(demo::ROOM_ID);
        let (events, payloads) = demo::media_events();
        view.apply_timeline(
            TimelineUpdate::Events { room: room.clone(), events, at_start: None },
            cx,
        );
        for (key, payload) in payloads {
            view.apply_timeline(TimelineUpdate::Media { room: room.clone(), key, payload }, cx);
        }
        view
    }

    pub fn selected(&self) -> Option<&RoomId> {
        self.timeline.room()
    }

    pub fn modal_is_open(&self) -> bool {
        self.modal.is_open()
    }

    fn submit_key(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.modal.is_busy() || !self.modal.is_open() {
            return;
        }
        let typed = self.key_input.read(cx).value();
        match validate_recovery_key(&typed) {
            Ok(_) if self.demo => {
                self.modal.fail("Mode démonstration : aucune connexion.".to_owned());
            }
            Ok(key) => {
                self.modal.start();
                self.key_input.update(cx, |state, cx| state.set_disabled(true, cx));
                cx.emit(MainEvent::SubmitRecoveryKey(KeyHandoff::new(key)));
            }
            Err(err) => self.modal.fail(err.to_string()),
        }
        cx.notify();
    }

    /// Sélectionne un salon (clic dans la barre latérale) et demande sa timeline.
    pub fn select(&mut self, id: RoomId, cx: &mut Context<Self>) {
        if self.timeline.room() == Some(&id) {
            return;
        }
        self.start_timeline(id, cx);
    }

    fn start_timeline(&mut self, id: RoomId, cx: &mut Context<Self>) {
        // On quitte le salon : plus de modification ni de suppression en attente, plus de « j'écris ».
        self.editing = None;
        self.pending_delete = None;
        self.stop_typing(cx);
        self.timeline.select(id.clone());
        self.scroll = UniformListScrollHandle::new();
        if self.demo {
            let (events, at_start) = demo::initial_page(&id);
            self.apply_timeline(
                TimelineUpdate::Events { room: id, events, at_start: Some(at_start) },
                cx,
            );
        } else {
            cx.emit(MainEvent::SelectRoom(id));
        }
        self.sync_composer(cx);
        cx.notify();
    }

    /// Nouvelle tentative après une erreur de chargement.
    pub fn retry_timeline(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.timeline.room().cloned() {
            self.timeline.retry();
            self.start_timeline_after_retry(id, cx);
        }
    }

    fn start_timeline_after_retry(&mut self, id: RoomId, cx: &mut Context<Self>) {
        self.scroll = UniformListScrollHandle::new();
        if self.demo {
            let (events, at_start) = demo::initial_page(&id);
            self.apply_timeline(
                TimelineUpdate::Events { room: id, events, at_start: Some(at_start) },
                cx,
            );
        } else {
            cx.emit(MainEvent::SelectRoom(id));
        }
        self.sync_composer(cx);
        cx.notify();
    }

    /// Applique un message de la tâche de timeline. Une réponse d'un autre salon que celui
    /// sélectionné est ignorée ; la position de lecture est ancrée (voir ci-dessous).
    pub fn apply_timeline(&mut self, update: TimelineUpdate, cx: &mut Context<Self>) {
        let was_empty = self.timeline.events().is_empty();
        let at_bottom = self.scroll.is_scrolled_to_end() != Some(false);
        // Échec d'envoi : le brouillon retourne dans le champ (au prochain rendu, qui a la fenêtre).
        let mut edit_target: Option<EventId> = None;
        let draft_to_restore = match &update {
            TimelineUpdate::SendFailed { room, text, .. } if self.timeline.room() == Some(room) => {
                Some(text.clone())
            }
            TimelineUpdate::EditFailed { room, event_id, text, .. }
                if self.timeline.room() == Some(room) =>
            {
                // On retourne en mode édition sur le même message, avec la version saisie.
                edit_target = Some(event_id.clone());
                Some(text.clone())
            }
            _ => None,
        };
        let media_key = match &update {
            TimelineUpdate::Media { room, key, payload: MediaPayload::Ready(_) }
                if self.timeline.room() == Some(room) =>
            {
                Some(key.clone())
            }
            _ => None,
        };
        let applied = self.timeline.apply(update);
        if applied.ignored {
            return;
        }
        if let Some(key) = media_key {
            self.ingest_image(&key);
        }
        if draft_to_restore.is_some() {
            self.pending_restore = draft_to_restore;
        }
        if edit_target.is_some() {
            self.editing = edit_target;
        }
        self.sync_composer(cx);
        if was_empty && !self.timeline.events().is_empty() {
            // Premier affichage : on lit les derniers messages.
            self.scroll.scroll_to_bottom();
        } else {
            if applied.merge.prepended > 0 {
                // Page plus ancienne : lignes de hauteur constante, on décale le défilement du même
                // nombre de pixels pour que le message lu reste à la même place.
                let handle = self.scroll.0.borrow().base_handle.clone();
                let mut offset = handle.offset();
                offset.y -= px(applied.merge.prepended as f32 * EVENT_ROW_HEIGHT);
                handle.set_offset(offset);
            }
            if applied.merge.appended > 0 && at_bottom {
                // Message reçu pendant qu'on lisait le bas : la vue reste collée en bas.
                self.scroll.scroll_to_bottom();
            }
        }
        // Peu de lignes : la liste ne remplit pas la fenêtre, donc rien à faire défiler pour déclencher
        // la pagination ; on charge de quoi la remplir.
        if self.timeline.status() == &TimelineStatus::Ready
            && !self.timeline.events().is_empty()
            && self.timeline.events().len() < FILL_ROWS
        {
            self.request_older(cx);
        }
        if self.timeline.needs_read_receipt(at_bottom) {
            self.mark_read(cx);
        }
        cx.notify();
    }

    /// Construit (hors rendu) l'image décodable d'un média dont les octets viennent d'arriver. Le décodage
    /// lui-même est fait par le toolkit au premier affichage ; un format non reconnu a déjà été refusé
    /// par le domaine (`TimelineState` le range en échec).
    fn ingest_image(&mut self, key: &str) {
        let Some(bytes) = self.timeline.media_bytes(key) else {
            return;
        };
        let format = match sniff_image_format(bytes) {
            Some(ImageKind::Png) => ImageFormat::Png,
            Some(ImageKind::Jpeg) => ImageFormat::Jpeg,
            Some(ImageKind::Gif) => ImageFormat::Gif,
            Some(ImageKind::Webp) => ImageFormat::Webp,
            Some(ImageKind::Bmp) => ImageFormat::Bmp,
            None => return,
        };
        self.images.insert(key.to_owned(), Arc::new(Image::from_bytes(format, bytes.as_ref().clone())));
    }

    /// Le salon ouvert et lu jusqu'en bas n'a pas de non-lus. Un compteur publié par une synchronisation est calculé
    /// par le SDK sur des données antérieures à notre accusé de lecture (mesuré : l'événement arrive par la
    /// timeline, `mark_read` remet 0, puis la synchronisation suivante republie « 1 », et le compteur ne retombe
    /// qu'à la synchronisation d'après, ~30 s plus tard) : on ne laisse pas cette valeur écraser le 0 local.
    /// Dès qu'un message plus récent arrive, `is_read_up_to_date` redevient faux jusqu'au nouvel accusé.
    fn keep_open_room_read(&mut self) {
        if !self.timeline.is_read_up_to_date() {
            return;
        }
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        if let RoomsState::Ready(rooms) = &mut self.rooms {
            for entry in rooms.iter_mut().filter(|r| r.id == room) {
                entry.unread = 0;
            }
        }
    }

    /// Accusé de lecture du salon sélectionné : la pastille de non-lus tombe tout de suite (la prochaine
    /// synchronisation confirme la valeur du serveur) ; hors démonstration, la commande part vers le pont.
    fn mark_read(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        if let RoomsState::Ready(rooms) = &mut self.rooms {
            for entry in rooms.iter_mut().filter(|r| r.id == room) {
                entry.unread = 0;
            }
        }
        if !self.demo {
            cx.emit(MainEvent::MarkRead(room));
        }
    }

    /// Après un défilement : proche du haut de la liste ? Alors une page plus ancienne est demandée.
    fn maybe_request_older(&mut self, cx: &mut Context<Self>) {
        let offset = self.scroll.0.borrow().base_handle.offset();
        if offset.y > px(-PAGINATE_THRESHOLD_ROWS * EVENT_ROW_HEIGHT) {
            self.request_older(cx);
        }
        // Arrivé en bas : les derniers messages sont lus.
        let at_bottom = self.scroll.is_scrolled_to_end() != Some(false);
        if self.timeline.needs_read_receipt(at_bottom) {
            self.mark_read(cx);
        }
    }

    /// Demande de page plus ancienne ; en démonstration, servie localement (hors rendu).
    fn request_older(&mut self, cx: &mut Context<Self>) {
        if !self.timeline.begin_older() {
            return;
        }
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        if self.demo {
            cx.spawn(async move |this, cx| {
                this.update(cx, |this, cx| {
                    let Some(oldest) = this.timeline.events().first().map(|e| e.id.clone()) else {
                        return;
                    };
                    let (events, at_start) = demo::older_page(&room, &oldest);
                    this.apply_timeline(
                        TimelineUpdate::Events { room, events, at_start: Some(at_start) },
                        cx,
                    );
                })
                .ok();
            })
            .detach();
        } else {
            cx.emit(MainEvent::LoadOlder(room));
        }
    }

    /// La saisie est active si un salon est sélectionné et que sa timeline n'est pas en erreur.
    fn composer_enabled(&self) -> bool {
        self.timeline.room().is_some() && !matches!(self.timeline.status(), TimelineStatus::Failed(_))
    }

    fn sync_composer(&mut self, cx: &mut Context<Self>) {
        let disabled = !self.composer_enabled();
        self.composer.update(cx, |state, cx| state.set_disabled(disabled, cx));
    }

    /// Entrée : envoie le contenu du champ s'il n'est pas vide (sinon, aucun effet).
    fn submit_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.composer_enabled() {
            return;
        }
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        let typed = self.composer.read(cx).value();
        let Some(body) = prepare_message(&typed) else {
            return;
        };
        match self.editing.clone() {
            Some(event_id) => self.edit_message(room, event_id, body, window, cx),
            None => self.send_body(room, body, window, cx),
        }
    }

    /// Un changement de texte : au plus une notice « j'écris » par fenêtre de temps (voir
    /// [`TypingThrottle`]), et un arrêt automatique après inactivité.
    fn on_composer_changed(&mut self, cx: &mut Context<Self>) {
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        let blank = self.composer.read(cx).value().trim().is_empty();
        if blank {
            self.stop_typing(cx);
            return;
        }
        let now = u64::try_from(self.clock.elapsed().as_millis()).unwrap_or(u64::MAX);
        if let Some(typing) = self.typing_throttle.keystroke(now) {
            self.emit_typing(room, typing, cx);
        }
        self.typing_gen += 1;
        let generation = self.typing_gen;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(TYPING_IDLE_MS))
                .await;
            this.update(cx, |this, cx| {
                // Aucune frappe depuis : on annonce qu'on a cessé d'écrire.
                if this.typing_gen == generation {
                    this.stop_typing(cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn stop_typing(&mut self, cx: &mut Context<Self>) {
        if let (Some(typing), Some(room)) =
            (self.typing_throttle.stop(), self.timeline.room().cloned())
        {
            self.emit_typing(room, typing, cx);
        }
    }

    fn emit_typing(&mut self, room: RoomId, typing: bool, cx: &mut Context<Self>) {
        // En démonstration rien ne part ; sinon la commande passe par le pont.
        if !self.demo {
            cx.emit(MainEvent::Typing { room, typing });
        }
    }

    /// Modification validée : champ vidé, puis commande vers le pont (ou édition locale en démonstration).
    fn edit_message(
        &mut self,
        room: RoomId,
        event_id: EventId,
        body: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.timeline.clear_send_failure();
        self.editing = None;
        self.stop_typing(cx);
        self.composer.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        if self.demo {
            self.timeline.edit_local(&event_id, &body);
        } else {
            cx.emit(MainEvent::EditText { room, event_id, body });
        }
        cx.notify();
    }

    /// Action « modifier » d'une ligne : la saisie est pré-remplie avec le texte du message.
    fn begin_edit(&mut self, event_id: EventId, body: String, window: &mut Window, cx: &mut Context<Self>) {
        self.pending_delete = None;
        self.timeline.clear_send_failure();
        self.editing = Some(event_id);
        self.composer.update(cx, |state, cx| {
            state.set_value(body, window, cx);
            state.focus(window, cx);
        });
        cx.notify();
    }

    fn cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing.take().is_some() {
            self.composer.update(cx, |state, cx| state.set_value("", window, cx));
        }
        cx.notify();
    }

    /// Action « supprimer » d'une ligne : demande une confirmation, ne supprime rien encore.
    fn ask_delete(&mut self, event_id: EventId, cx: &mut Context<Self>) {
        self.pending_delete = Some(event_id);
        cx.notify();
    }

    fn confirm_delete(&mut self, cx: &mut Context<Self>) {
        let (Some(event_id), Some(room)) =
            (self.pending_delete.take(), self.timeline.room().cloned())
        else {
            return;
        };
        self.redact(room, event_id, cx);
    }

    fn redact(&mut self, room: RoomId, event_id: EventId, cx: &mut Context<Self>) {
        self.timeline.clear_send_failure();
        if self.demo {
            self.timeline.redact_local(&event_id);
        } else {
            cx.emit(MainEvent::Redact { room, event_id });
        }
        cx.notify();
    }

    /// Envoi : champ vidé, focus conservé, vue collée en bas, puis commande vers le pont (ou écho
    /// simulé en démonstration). Aucun appel réseau ici.
    fn send_body(&mut self, room: RoomId, body: String, window: &mut Window, cx: &mut Context<Self>) {
        self.timeline.clear_send_failure();
        self.stop_typing(cx);
        self.composer.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        self.scroll.scroll_to_bottom();
        if self.demo {
            self.demo_send_echo(room, body, cx);
        } else {
            cx.emit(MainEvent::SendText { room, body });
        }
        cx.notify();
    }

    /// Nouvelle tentative après un échec : renvoie l'envoi, l'édition ou la suppression mémorisés.
    fn retry_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(room), Some(failure)) =
            (self.timeline.room().cloned(), self.timeline.send_failure().cloned())
        else {
            return;
        };
        match failure.action {
            FailedAction::Send => self.send_body(room, failure.text, window, cx),
            FailedAction::Edit(event_id) => self.edit_message(room, event_id, failure.text, window, cx),
            FailedAction::Delete(event_id) => self.redact(room, event_id, cx),
            FailedAction::Attach(path) => {
                self.timeline.clear_send_failure();
                self.attach_path(std::path::PathBuf::from(path), cx);
            }
        }
    }

    /// Ouvre le sélecteur de fichier du système ; le chemin choisi part ensuite par [`Self::attach_path`].
    fn pick_attachment(&mut self, cx: &mut Context<Self>) {
        if !self.composer_enabled() {
            return;
        }
        self.notice = None;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Joindre".into()),
        });
        cx.spawn(async move |this, cx| {
            let outcome = classify_pick(paths.await);
            this.update(cx, |this, cx| this.picker_result(outcome, cx)).ok();
        })
        .detach();
    }

    /// Suite du sélecteur de fichiers : fichier choisi → envoi ; annulation → rien ; sélecteur absent → message
    /// visible dans l'interface (jamais un échec silencieux).
    pub fn picker_result(&mut self, result: PickResult, cx: &mut Context<Self>) {
        match result {
            PickResult::Chosen(path) => self.attach_path(path, cx),
            PickResult::Cancelled => {}
            PickResult::Unavailable => {
                self.notice = Some(PICKER_UNAVAILABLE.to_owned());
                cx.notify();
            }
        }
    }

    /// Joint un fichier au salon sélectionné. Le chemin est transmis tel quel au pont : la lecture, la
    /// vérification de taille et l'envoi (chiffré par le SDK si le salon l'est) se font sur Tokio.
    pub fn attach_path(&mut self, path: std::path::PathBuf, cx: &mut Context<Self>) {
        if !self.composer_enabled() {
            return;
        }
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        self.notice = None;
        self.timeline.clear_send_failure();
        self.scroll.scroll_to_bottom();
        if self.demo {
            self.demo_attach_echo(room, &path, cx);
        } else {
            cx.emit(MainEvent::SendAttachment { room, path: path.to_string_lossy().into_owned() });
        }
        cx.notify();
    }

    /// Démonstration d'un envoi de pièce jointe : écho local avec progression, puis confirmation.
    fn demo_attach_echo(&mut self, room: RoomId, path: &std::path::Path, cx: &mut Context<Self>) {
        self.demo_sent += 1;
        let name = path
            .file_name()
            .map_or_else(|| "fichier".to_owned(), |n| n.to_string_lossy().into_owned());
        let last_ts = self.timeline.events().last().map_or(0, |e| e.timestamp_ms);
        let media = MediaVm {
            key: format!("local://demo/attach-{}", self.demo_sent),
            kind: MediaKind::File,
            filename: name.clone(),
            size: None,
            mime: None,
            width: None,
            height: None,
            encrypted: false,
            status: MediaStatus::Uploading(Some(40)),
        };
        let echo = EventVm {
            id: EventId::from(format!("$demo-attach-{}", self.demo_sent).as_str()),
            sender_name: "Moi (démo)".to_owned(),
            sender_initials: "MD".to_owned(),
            timestamp_ms: last_ts + 60_000,
            time_label: String::new(),
            body: name,
            state: EventState::Local,
            event_id: None,
            is_own: true,
            edited: false,
            read_by: Vec::new(),
            media: Some(media),
        };
        self.apply_timeline(
            TimelineUpdate::Events { room: room.clone(), events: vec![echo.clone()], at_start: None },
            cx,
        );
        if self.demo_hold_pending {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DEMO_CONFIRM_DELAY).await;
            this.update(cx, |this, cx| {
                let mut confirmed = EventVm {
                    state: EventState::Normal,
                    event_id: Some(EventId::from(format!("$demo-attach-{}-ok", this.demo_sent).as_str())),
                    ..echo
                };
                if let Some(media) = confirmed.media.as_mut() {
                    media.status = MediaStatus::Available;
                }
                this.apply_timeline(
                    TimelineUpdate::Events { room, events: vec![confirmed], at_start: None },
                    cx,
                );
            })
            .ok();
        })
        .detach();
    }

    /// Démonstration : écho local immédiat, confirmé après un délai (sans réseau).
    fn demo_send_echo(&mut self, room: RoomId, body: String, cx: &mut Context<Self>) {
        self.demo_sent += 1;
        let last_ts = self.timeline.events().last().map_or(0, |e| e.timestamp_ms);
        let echo = EventVm {
            id: EventId::from(format!("$demo-local-{}", self.demo_sent).as_str()),
            sender_name: "Moi (démo)".to_owned(),
            sender_initials: "MD".to_owned(),
            timestamp_ms: last_ts + 60_000,
            time_label: String::new(),
            body,
            state: EventState::Local,
            event_id: None,
            is_own: true,
            edited: false,
            read_by: Vec::new(),
            media: None,
        };
        self.apply_timeline(
            TimelineUpdate::Events { room: room.clone(), events: vec![echo.clone()], at_start: None },
            cx,
        );
        if self.demo_hold_pending {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DEMO_CONFIRM_DELAY).await;
            this.update(cx, |this, cx| {
                // Confirmation : même id, état `Normal` (la fusion remplace la ligne).
                let confirmed = EventVm {
                    state: EventState::Normal,
                    event_id: Some(EventId::from(format!("$demo-local-{}-ok", this.demo_sent).as_str())),
                    ..echo
                };
                this.apply_timeline(
                    TimelineUpdate::Events { room, events: vec![confirmed], at_start: None },
                    cx,
                );
            })
            .ok();
        })
        .detach();
    }

    fn composer_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let enabled = self.composer_enabled();
        let failure = self.timeline.send_failure().cloned();
        let typing = typing_label(self.timeline.typing());
        let editing = self.editing.is_some();
        let deleting = self.pending_delete.is_some();
        div()
            .id("composer")
            .flex_none()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .border_t_1()
            .border_color(rgb(BORDER))
            // Indicateur de frappe : hauteur réservée pour ne pas faire sauter la liste.
            .child(
                div()
                    .id("typing-indicator")
                    .h(px(16.0))
                    .text_xs()
                    .text_color(rgb(TEXT_SECONDARY))
                    .children(typing.clone())
                    .test_support()
                    .aria_label(SharedString::from(typing.unwrap_or_default())),
            )
            .children(deleting.then(|| {
                div()
                    .id("delete-confirm-bar")
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .text_sm()
                            .text_color(rgb(TEXT))
                            .child("Supprimer ce message ? Cette action est définitive."),
                    )
                    .child(
                        Button::new("delete-cancel")
                            .label("Annuler")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.pending_delete = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("delete-confirm")
                            .primary()
                            .label("Supprimer")
                            .on_click(cx.listener(|this, _, _, cx| this.confirm_delete(cx))),
                    )
                    .test_support()
                    .aria_label("Confirmer la suppression")
            }))
            .children(editing.then(|| {
                div()
                    .id("edit-banner")
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .flex_1()
                            .text_sm()
                            .text_color(rgb(TEXT_SECONDARY))
                            .child("Modification du message (Entrée : valider)"),
                    )
                    .child(
                        Button::new("edit-cancel")
                            .label("Annuler")
                            .on_click(cx.listener(|this, _, window, cx| this.cancel_edit(window, cx))),
                    )
                    .test_support()
                    .aria_label("Modification en cours")
            }))
            .children(self.notice.clone().map(|message| {
                let label = SharedString::from(message.clone());
                div()
                    .id("composer-notice")
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().flex_1().min_w_0().text_sm().text_color(rgb(ERROR)).child(message))
                    .child(
                        Button::new("composer-notice-dismiss")
                            .label("Fermer")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.notice = None;
                                cx.notify();
                            })),
                    )
                    .test_support()
                    .aria_label(label)
            }))
            .children(failure.map(|failure| {
                let label = SharedString::from(failure.message.clone());
                div()
                    .id("composer-error")
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(div().flex_1().min_w_0().text_sm().text_color(rgb(ERROR)).child(failure.message))
                    .child(
                        Button::new("composer-retry")
                            .label("Réessayer")
                            .on_click(cx.listener(|this, _, window, cx| this.retry_send(window, cx))),
                    )
                    .test_support()
                    .aria_label(label)
            }))
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap_2()
                    .child(
                        div().flex_1().child(
                            Textarea::new(&self.composer)
                                .accessibility_id("composer-input")
                                .disabled(!enabled)
                                .aria_label("Message"),
                        ),
                    )
                    .child(
                        Button::new("attach-button")
                            .label("Joindre")
                            .disabled(!enabled)
                            .on_click(cx.listener(|this, _, _, cx| this.pick_attachment(cx))),
                    ),
            )
            // Glisser-déposer d'un fichier sur la zone de saisie.
            .on_drop(cx.listener(|this, dropped: &ExternalPaths, _, cx| {
                if let Some(path) = dropped.paths().first() {
                    this.attach_path(path.clone(), cx);
                }
            }))
            .test_support()
            .aria_label("Zone de saisie")
    }

    fn room_row(&self, index: usize, room: &RoomVm, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.timeline.room() == Some(&room.id);
        let id = room.id.clone();
        let row_id = SharedString::from(format!("room-{index}"));
        let accessible_name = SharedString::from(room.name.clone());
        let badge_text = if room.unread > 99 { "99+".to_owned() } else { room.unread.to_string() };

        div()
            .id(row_id)
            .flex()
            .items_center()
            .gap_2()
            .px_2()
            .py_1()
            .rounded_md()
            .cursor_pointer()
            .bg(rgb(if selected { SELECTED } else { PANEL }))
            .hover(|style| style.bg(rgb(if selected { SELECTED } else { HOVER })))
            .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
            .child(
                div()
                    .size(px(32.0))
                    .rounded(px(if room.kind == RoomKind::Space { 8.0 } else { 16.0 }))
                    .bg(rgb(BORDER))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(rgb(TEXT))
                    .child(room.avatar_initials.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .text_sm()
                    .text_color(rgb(if room.unread > 0 { TEXT } else { TEXT_SECONDARY }))
                    .child(room.name.clone()),
            )
            .children((room.unread > 0).then(|| {
                div()
                    .id(SharedString::from(format!("unread-{index}")))
                    .px_2()
                    .rounded_full()
                    .bg(rgb(ACCENT))
                    .text_xs()
                    .text_color(rgb(TEXT))
                    .child(badge_text.clone())
                    .test_support()
                    .aria_label(SharedString::from(format!("{badge_text} non lus")))
            }))
            .test_support()
            .aria_label(accessible_name)
    }

    fn section_title(label: &'static str) -> impl IntoElement {
        div().px_2().pt_3().pb_1().text_xs().text_color(rgb(TEXT_SECONDARY)).child(label)
    }

    fn sidebar_body(&self, cx: &mut Context<Self>) -> AnyElement {
        match &self.rooms {
            RoomsState::Syncing => div()
                .id("rooms-state")
                .p_3()
                .text_sm()
                .text_color(rgb(TEXT_SECONDARY))
                .child("Synchronisation…")
                .test_support()
                .aria_label("Synchronisation…")
                .into_any_element(),
            RoomsState::Failed(message) => div()
                .p_3()
                .text_sm()
                .text_color(rgb(ERROR))
                .child(message.clone())
                .into_any_element(),
            RoomsState::Ready(rooms) if rooms.is_empty() => div()
                .p_3()
                .text_sm()
                .text_color(rgb(TEXT_SECONDARY))
                .child("Aucun salon pour l'instant.")
                .into_any_element(),
            RoomsState::Ready(rooms) => {
                let mut column = div().flex().flex_col().gap_1().p_2();
                let mut last_kind = None;
                for (index, room) in rooms.iter().enumerate() {
                    if last_kind != Some(room.kind) {
                        column = column.child(Self::section_title(match room.kind {
                            RoomKind::Space => "ESPACES",
                            RoomKind::Room => "SALONS",
                            RoomKind::Dm => "MESSAGES DIRECTS",
                        }));
                        last_kind = Some(room.kind);
                    }
                    column = column.child(self.room_row(index, room, cx));
                }
                column.into_any_element()
            }
        }
    }

    /// Contenu de la boîte de vignette d'un média : de taille **fixe** (`THUMBNAIL_SIDE`) quel que soit
    /// l'état, donc aucun saut de mise en page entre « chargement », image décodée et échec.
    fn media_box(index: usize, media: &MediaRender) -> impl IntoElement {
        let side = px(THUMBNAIL_SIDE as f32);
        let (inner_w, inner_h) = media.thumb;
        let glyph = |text: String| div().text_xs().text_color(rgb(TEXT_SECONDARY)).child(text);
        let content: AnyElement = match (&media.display, &media.image) {
            (MediaDisplay::Thumbnail, Some(image)) => div()
                .w(px(inner_w as f32))
                .h(px(inner_h as f32))
                .overflow_hidden()
                .child(img(image.clone()).size_full().object_fit(ObjectFit::Contain))
                .into_any_element(),
            // Octets pas encore là (ou image refusée) : espace réservé de même taille.
            (MediaDisplay::Thumbnail | MediaDisplay::Loading, _) => glyph("…".to_owned()).into_any_element(),
            (MediaDisplay::Unavailable(_), _) => glyph("?".to_owned()).into_any_element(),
            (MediaDisplay::Card, _) => glyph(media.card_label.clone()).into_any_element(),
            (MediaDisplay::Uploading(percent), _) => {
                glyph(percent.map_or_else(|| "↑".to_owned(), |p| format!("{p} %"))).into_any_element()
            }
            (MediaDisplay::UploadFailed(_), _) => {
                div().text_xs().text_color(rgb(ERROR)).child("!").into_any_element()
            }
        };
        div()
            .id(SharedString::from(format!("media-{index}")))
            .size(side)
            .flex_none()
            .rounded_md()
            .overflow_hidden()
            .bg(rgb(BORDER))
            .flex()
            .items_center()
            .justify_center()
            .child(content)
            .test_support()
            .aria_label(SharedString::from(media.aria.clone()))
    }

    fn event_row(
        index: usize,
        event: &EventVm,
        read_label: Option<String>,
        media: Option<MediaRender>,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let undecryptable = event.state == EventState::Indechiffrable;
        let media_failed = matches!(
            media.as_ref().map(|m| &m.display),
            Some(MediaDisplay::Unavailable(_) | MediaDisplay::UploadFailed(_))
        );
        let failed = event.state == EventState::EchecEnvoi || media_failed;
        let deleted = event.state == EventState::Supprime;
        let dim = event.state == EventState::Local || deleted;
        let mut time_label = match event.state {
            EventState::Local => "envoi…".to_owned(),
            EventState::EchecEnvoi => "non envoyé".to_owned(),
            _ => event.time_label.clone(),
        };
        if event.edited {
            time_label.push_str(" · modifié");
        }
        if let Some(read) = &read_label {
            time_label.push_str(" · ");
            time_label.push_str(read);
        }
        // Deuxième ligne : le texte, ou le résumé du média (nom · taille · dimensions · type).
        let body_text = match (&event.media, media.as_ref().map(|m| &m.display)) {
            (Some(m), Some(MediaDisplay::Unavailable(reason))) => format!("{reason} — {}", m.filename),
            (Some(m), Some(MediaDisplay::UploadFailed(_))) => format!("Envoi échoué : {}", m.filename),
            (Some(m), Some(MediaDisplay::Uploading(percent))) => match percent {
                Some(p) => format!("Envoi de {} : {p} %", m.filename),
                None => format!("Envoi de {}…", m.filename),
            },
            (Some(m), _) => m.summary(),
            (None, _) => event.body.clone(),
        };
        let actions = event.can_edit_or_delete().then(|| {
            let event_id = event.event_id.clone();
            let body = event.body.clone();
            let (edit_id, delete_id) = (event_id.clone(), event_id);
            div()
                .flex_none()
                .flex()
                .gap_1()
                // Un média n'a pas de texte à modifier : seule la suppression est proposée.
                .children(event.media.is_none().then(|| {
                    Button::new(SharedString::from(format!("edit-{index}")))
                        .label("Modifier")
                        .xsmall()
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(id) = edit_id.clone() {
                                this.begin_edit(id, body.clone(), window, cx);
                            }
                        }))
                }))
                .child(
                    Button::new(SharedString::from(format!("delete-{index}")))
                        .label("Supprimer")
                        .xsmall()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(id) = delete_id.clone() {
                                this.ask_delete(id, cx);
                            }
                        })),
                )
        });
        let row_id = event.id.clone();
        let media_aria = media.as_ref().map(|m| m.aria.clone());
        div()
            .id(SharedString::from(format!("event-{index}")))
            .w_full()
            .h(px(EVENT_ROW_HEIGHT))
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .bg(rgb(if selected { SELECTED } else { BACKGROUND }))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_event = Some(row_id.clone());
                cx.notify();
            }))
            .child(
                div()
                    .opacity(if dim { 0.6 } else { 1.0 })
                    .size(px(32.0))
                    .flex_none()
                    .rounded(px(16.0))
                    .bg(rgb(BORDER))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(rgb(TEXT))
                    .child(event.sender_initials.clone()),
            )
            .child(
                div()
                    .opacity(if dim { 0.6 } else { 1.0 })
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .items_baseline()
                            .child(div().text_sm().text_color(rgb(TEXT)).child(event.sender_name.clone()))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(TEXT_SECONDARY))
                                    .child(time_label),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_sm()
                            .when(deleted, |row| row.italic())
                            .text_color(rgb(if undecryptable || failed { ERROR } else { TEXT_SECONDARY }))
                            .child(body_text.clone()),
                    ),
            )
            .child(
                // Colonne de droite à bords fixes : la vignette et les boutons gardent la même
                // abscisse d'une ligne à l'autre, quelle que soit la longueur du texte.
                div()
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap_2()
                    .child(
                        div()
                            .w(px(THUMBNAIL_SIDE as f32))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .children(media.as_ref().map(|m| Self::media_box(index, m))),
                    )
                    .child(
                        div()
                            .w(px(ACTIONS_COLUMN_WIDTH))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .children(actions),
                    ),
            )
            .test_support()
            .aria_label(SharedString::from(format!(
                "{} : {}{}{}{}{}{}",
                event.sender_name,
                media_aria.as_deref().map_or(body_text.clone(), |_| body_text.clone()),
                match event.state {
                    EventState::Local => " [envoi en cours]",
                    EventState::EchecEnvoi => " [non envoyé]",
                    _ => "",
                },
                if event.edited { " [modifié]" } else { "" },
                read_label.map(|r| format!(" [{r}]")).unwrap_or_default(),
                if selected { " [sélectionné]" } else { "" },
                match &event.media {
                    Some(_) if media_failed => " [média en échec]",
                    _ => "",
                },
            )))
    }

    fn timeline_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let base = div().flex_1().min_h_0().flex().flex_col().min_w_0();
        let message = |id: &'static str, text: String, color: u32| {
            div()
                .id(id)
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_color(rgb(color))
                .child(text.clone())
                .test_support()
                .aria_label(SharedString::from(text))
        };

        let Some(room) = self.timeline.room().cloned() else {
            return base
                .child(message("timeline-placeholder", "Sélectionne un salon".to_owned(), TEXT_SECONDARY))
                .into_any_element();
        };
        let title = match &self.rooms {
            RoomsState::Ready(rooms) => rooms.iter().find(|r| r.id == room).map(|r| r.name.clone()),
            _ => None,
        }
        .unwrap_or_else(|| room.to_string());
        let header = div()
            .id("timeline-header")
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(rgb(BORDER))
            .text_color(rgb(TEXT))
            .child(title.clone())
            .test_support()
            .aria_label(SharedString::from(title));

        match self.timeline.status().clone() {
            TimelineStatus::Idle | TimelineStatus::Loading => base
                .child(header)
                .child(message("timeline-loading", "Chargement des messages…".to_owned(), TEXT_SECONDARY))
                .into_any_element(),
            TimelineStatus::Failed(error) => base
                .child(header)
                .child(
                    div()
                        .id("timeline-error")
                        .flex_1()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_3()
                        .child(
                            div()
                                .text_color(rgb(ERROR))
                                .child(format!("Impossible de charger les messages : {error}")),
                        )
                        .child(
                            Button::new("timeline-retry")
                                .label("Réessayer")
                                .on_click(cx.listener(|this, _, _, cx| this.retry_timeline(cx))),
                        )
                        .test_support()
                        .aria_label("Erreur de chargement"),
                )
                .into_any_element(),
            TimelineStatus::Ready if self.timeline.events().is_empty() => base
                .child(header)
                .child(message("timeline-empty", "Aucun message dans ce salon.".to_owned(), TEXT_SECONDARY))
                .into_any_element(),
            TimelineStatus::Ready => {
                let count = self.timeline.events().len();
                let list = uniform_list(
                    "timeline",
                    count,
                    cx.processor(|this, range: std::ops::Range<usize>, _window, cx| {
                        let end = range.end.min(this.timeline.events().len());
                        let start = range.start.min(end);
                        let marker = last_read_marker(this.timeline.events());
                        this.timeline.events()[start..end]
                            .iter()
                            .enumerate()
                            .map(|(offset, event)| {
                                let index = start + offset;
                                // L'état de lecture n'est affiché que sur le dernier message concerné.
                                let read = (marker == Some(index))
                                    .then(|| read_by_label(&event.read_by))
                                    .flatten();
                                let media = event.media.as_ref().map(|m| MediaRender::of(
                                    m,
                                    &this.timeline,
                                    &this.images,
                                ));
                                let selected = this.selected_event.as_ref() == Some(&event.id);
                                Self::event_row(index, event, read, media, selected, cx)
                            })
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.scroll);
                // Calage : la zone visible de la liste vaut un nombre entier de lignes, l'écart restant en
                // haut (marge), sans quoi la ligne du haut est rognée et le bas de ses boutons dépasse.
                // La liste garde `flex_1` (comme avant) : seule la marge du conteneur varie.
                let row = px(EVENT_ROW_HEIGHT);
                let frame = self.list_frame.bounds().size.height;
                let slack = if frame > row * count as f32 { px(0.0) } else { frame - row * (frame / row).floor() };
                // La hauteur mesurée date de la trame précédente : un changement de mise en page (barre de
                // suppression qui se ferme, fenêtre redimensionnée) n'est vu qu'au rendu suivant. Chaque rendu
                // est donc suivi d'un rendu de vérification ; il en redemande un autre seulement si la hauteur
                // a bougé, ce qui garantit l'arrêt.
                let verifying = std::mem::take(&mut self.list_verifying);
                if frame != self.list_seen {
                    // Une fois la zone rétrécie, la liste n'est plus « en bas » : on se fie à `list_pinned`.
                    if self.list_pinned {
                        self.scroll.scroll_to_bottom();
                    }
                    self.list_seen = frame;
                }
                if frame != self.list_seen_prev || !verifying {
                    self.list_seen_prev = frame;
                    self.list_verifying = true;
                    let id = cx.entity_id();
                    cx.defer(move |cx| cx.notify(id));
                }
                let list = div().flex_1().min_h_0().w_full().child(list.size_full());

                let banner = if self.timeline.is_loading_older() {
                    Some(("timeline-older", "Chargement de messages plus anciens…"))
                } else if self.timeline.at_start() {
                    Some(("timeline-start", "Début de la conversation"))
                } else {
                    None
                };
                // Bandeau de hauteur fixe, toujours présent : s'il apparaissait/disparaissait, la liste
                // se décalerait et la lecture « sauterait » à chaque page chargée.
                let banner_slot = div()
                    .h(px(BANNER_HEIGHT))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_xs()
                    .text_color(rgb(TEXT_SECONDARY))
                    .children(banner.map(|(id, text)| {
                        div().id(id).child(text).test_support().aria_label(text)
                    }));
                base.child(header)
                    .child(banner_slot)
                    .child(
                        // La pagination est déclenchée par la molette (jamais depuis le rendu).
                        div()
                            .id("timeline-list")
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .pt(slack)
                            .track_scroll(&self.list_frame)
                            .on_scroll(cx.listener(|this, _, _, cx| {
                                // Seul l'utilisateur détache la liste du bas (molette) ou l'y ramène.
                                this.list_pinned = this.scroll.is_scrolled_to_end() != Some(false);
                                this.maybe_request_older(cx)
                            }))
                            .child(list)
                            .test_support()
                            .aria_label("Messages"),
                    )
                    .into_any_element()
            }
        }
    }

    fn recovery_modal(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let ModalState::Open { busy, error } = &self.modal else {
            return None;
        };
        let busy = *busy;
        let error = error.clone();
        Some(
            div()
                .id("recovery-modal")
                .absolute()
                .size_full()
                .bg(rgba(0x000000b0))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .w(px(420.0))
                        .flex()
                        .flex_col()
                        .gap_3()
                        .p_4()
                        .rounded_lg()
                        .bg(rgb(PANEL))
                        .border_1()
                        .border_color(rgb(BORDER))
                        .child(div().text_lg().text_color(rgb(TEXT)).child("Restaurer les clés"))
                        .child(div().text_sm().text_color(rgb(TEXT_SECONDARY)).child(
                            "Saisis ta clé de récupération pour déchiffrer l'historique de tes salons. \
                             Elle n'est jamais enregistrée.",
                        ))
                        .child(Input::new(&self.key_input).id("recovery-key"))
                        .children(
                            error.map(|m| div().text_sm().text_color(rgb(ERROR)).child(m)),
                        )
                        .child(
                            div()
                                .flex()
                                .justify_end()
                                .gap_2()
                                .child(
                                    Button::new("recovery-cancel")
                                        .label("Annuler")
                                        .disabled(busy)
                                        .on_click(cx.listener(|this, _, _, cx| this.close_recovery(cx))),
                                )
                                .child(
                                    Button::new("recovery-submit")
                                        .primary()
                                        .label(if busy { "Déverrouillage…" } else { "Déverrouiller" })
                                        .loading(busy)
                                        .disabled(busy)
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.submit_key(window, cx)
                                        })),
                                ),
                        ),
                )
                .test_support()
                .aria_label("Restaurer les clés")
                .into_any_element(),
        )
    }
}

impl Render for MainView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(draft) = self.pending_restore.take() {
            let composer = self.composer.clone();
            composer.update(cx, |state, cx| {
                // On ne piétine pas ce que l'utilisateur a déjà retapé entre-temps.
                if state.value().is_empty() {
                    state.set_value(draft, window, cx);
                }
            });
        }
        let header = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .border_b_1()
            .border_color(rgb(BORDER))
            .child(div().text_color(rgb(TEXT)).child("WaifuChat"))
            .child(div().text_xs().text_color(rgb(TEXT_SECONDARY)).child(self.user_label.clone()))
            .children((self.keys == KeyStatus::Needed).then(|| {
                Button::new("recovery-open")
                    .primary()
                    .label("Restaurer les clés")
                    .on_click(cx.listener(|this, _, _, cx| this.open_recovery(cx)))
            }));

        let footer = div().p_2().border_t_1().border_color(rgb(BORDER)).child(
            Button::new("sign-out")
                .label("Se déconnecter")
                .on_click(cx.listener(|_, _, _, cx| cx.emit(MainEvent::SignOut))),
        );

        let sidebar = div()
            .id("sidebar")
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(PANEL))
            .border_r_1()
            .border_color(rgb(BORDER))
            .child(header)
            .children(self.connection.banner().map(|text| {
                let offline = matches!(self.connection, ConnectionState::Offline(_));
                div()
                    .id("connection-banner")
                    .px_3()
                    .py_1()
                    .text_xs()
                    .text_color(rgb(if offline { ERROR } else { TEXT_SECONDARY }))
                    .child(text.clone())
                    .test_support()
                    .aria_label(SharedString::from(text))
            }))
            .child(div().id("rooms-scroll").flex_1().overflow_y_scroll().child(self.sidebar_body(cx)))
            .child(footer)
            .test_support()
            .aria_label("Salons");

        let timeline = self.timeline_panel(cx);
        let center = div()
            .flex_1()
            .h_full()
            .min_w_0()
            .flex()
            .flex_col()
            .child(timeline)
            .child(self.composer_panel(cx));

        div()
            .size_full()
            .relative()
            .bg(rgb(BACKGROUND))
            .flex()
            .child(sidebar)
            .child(center)
            .children(self.recovery_modal(cx))
    }
}
