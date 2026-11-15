//! Timeline d'un salon (lecture) via `matrix_sdk_ui::timeline::Timeline`.
//!
//! Une tâche par salon sélectionné : chargement initial, pagination vers le haut à la demande, et
//! temps réel (chaque lot de modifications republie un instantané que le domaine fusionne par id).
//! Tout s'exécute sur Tokio ; l'UI ne fait que recevoir des [`TimelineUpdate`].

use chrono::{DateTime, Local, TimeZone};
use domain::{
    initials, EventId, EventState, EventVm, RoomId, TimelineUpdate, REDACTED_PLACEHOLDER,
    UNDECRYPTABLE_PLACEHOLDER,
};
use futures_util::StreamExt;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::events::room::message::{
    RoomMessageEventContent, RoomMessageEventContentWithoutRelation,
};
use matrix_sdk::ruma::{EventId as SdkEventId, RoomId as SdkRoomId, UserId as SdkUserId};
use matrix_sdk::Client;
use matrix_sdk_ui::timeline::{
    EventSendState, MsgLikeKind, RoomExt, TimelineDetails, TimelineEventItemId, TimelineItem,
    TimelineItemContent,
};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::error::MatrixError;

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

fn localpart(user_id: &str) -> &str {
    user_id.trim_start_matches('@').split(':').next().unwrap_or(user_id)
}

/// Convertit un élément du SDK ; `None` pour ce qui n'est pas un message (séparateurs, changements
/// d'état, appartenance…).
fn to_event_vm(item: &TimelineItem, own_user: Option<&SdkUserId>) -> Option<EventVm> {
    let event = item.as_event()?;
    let TimelineItemContent::MsgLike(content) = event.content() else {
        return None;
    };
    let mut edited = false;
    let (body, mut state) = match &content.kind {
        MsgLikeKind::Message(message) => {
            edited = message.is_edited();
            (message.body().to_owned(), EventState::Normal)
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
    }

    // Identifiant unique de l'élément de timeline : il ne change pas quand l'écho local devient
    // l'événement confirmé (contrairement à `identifier()`, qui passe de l'id de transaction à l'id
    // d'événement), donc la fusion par id remplace la ligne au lieu de la dupliquer.
    let id = item.unique_id().0.clone();
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
    // Accusés de lecture des autres membres posés sur ce message.
    let mut read_by: Vec<String> = event
        .read_receipts()
        .keys()
        .filter(|user| Some(user.as_ref()) != own_user)
        .map(|user| localpart(user.as_str()).to_owned())
        .collect();
    read_by.sort();

    Some(EventVm {
        id: EventId::from(id.as_str()),
        sender_initials: initials(&sender_name),
        sender_name,
        timestamp_ms,
        time_label: format_time_label(timestamp_ms, &Local),
        body,
        state,
        event_id,
        is_own: event.is_own(),
        edited,
        read_by,
    })
}

fn snapshot<'a>(
    items: impl IntoIterator<Item = &'a std::sync::Arc<TimelineItem>>,
    own_user: Option<&SdkUserId>,
) -> Vec<EventVm> {
    items.into_iter().filter_map(|item| to_event_vm(item, own_user)).collect()
}

/// Suit la timeline de `room` jusqu'à ce que `commands` soit fermé (l'UI a changé de salon) ou que la
/// tâche soit abandonnée. `publish` est appelé pour chaque mise à jour ; il doit être non bloquant.
pub async fn run_timeline(
    client: Client,
    room: RoomId,
    mut commands: UnboundedReceiver<TimelineCommand>,
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
    let events = |events: Vec<EventVm>, at_start: Option<bool>| {
        publish(TimelineUpdate::Events { room: room.clone(), events, at_start })
    };

    let Ok(room_id) = <&SdkRoomId>::try_from(room.as_str()) else {
        return fail("Identifiant de salon invalide.".to_owned());
    };
    let Some(sdk_room) = client.get_room(room_id) else {
        return fail("Salon introuvable sur ce compte.".to_owned());
    };
    // Sans abonnement du cache d'événements, la pagination ne reçoit rien.
    if let Err(err) = client.event_cache().subscribe() {
        return fail(MatrixError::from(matrix_sdk::Error::from(err)).to_string());
    }
    let own_user = client.user_id().map(ToOwned::to_owned);
    let (_typing_guard, mut typing_rx) = sdk_room.subscribe_to_typing_notifications();
    let timeline = match sdk_room.timeline().await {
        Ok(timeline) => timeline,
        Err(err) => return fail(MatrixError::Other(err.to_string()).to_string()),
    };

    let (initial, stream) = timeline.subscribe().await;
    let mut stream = Box::pin(stream);
    events(snapshot(initial.iter(), own_user.as_deref()), None);

    match timeline.paginate_backwards(PAGE_SIZE).await {
        Ok(hit_start) => events(snapshot(timeline.items().await.iter(), own_user.as_deref()), Some(hit_start)),
        Err(err) => fail(MatrixError::Other(err.to_string()).to_string()),
    }

    loop {
        tokio::select! {
            batch = stream.next() => {
                if batch.is_none() {
                    return fail("Timeline interrompue.".to_owned());
                }
                events(snapshot(timeline.items().await.iter(), own_user.as_deref()), None);
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
                Some(TimelineCommand::MarkRead) => {
                    // Un accusé de lecture raté n'a pas de conséquence visible : le prochain essai suivra.
                    let _ = timeline.mark_as_read(ReceiptType::Read).await;
                }
                Some(TimelineCommand::Typing(typing)) => {
                    // La notice de frappe est opportuniste : une erreur réseau est ignorée.
                    let _ = sdk_room.typing_notice(typing).await;
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
                            events(snapshot(timeline.items().await.iter(), own_user.as_deref()), Some(hit_start));
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

    #[test]
    fn localpart_strips_sigil_and_server() {
        assert_eq!(localpart("@alice:example.org"), "alice");
        assert_eq!(localpart("alice"), "alice");
    }
}
