//! Timeline d'un salon (lecture) via `matrix_sdk_ui::timeline::Timeline`.
//!
//! Une tâche par salon sélectionné : chargement initial, pagination vers le haut à la demande, et
//! temps réel (chaque lot de modifications republie un instantané que le domaine fusionne par id).
//! Tout s'exécute sur Tokio ; l'UI ne fait que recevoir des [`TimelineUpdate`].

use chrono::{DateTime, Local, TimeZone};
use domain::{
    initials, EventId, EventState, EventVm, RoomId, TimelineUpdate, UNDECRYPTABLE_PLACEHOLDER,
};
use futures_util::StreamExt;
use matrix_sdk::ruma::RoomId as SdkRoomId;
use matrix_sdk::Client;
use matrix_sdk_ui::timeline::{
    MsgLikeKind, RoomExt, TimelineDetails, TimelineEventItemId, TimelineItem, TimelineItemContent,
};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::error::MatrixError;

/// Taille d'une page (chargement initial et pagination).
pub const PAGE_SIZE: u16 = 50;

/// Demande de l'UI à la tâche de timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimelineCommand {
    /// Charger une page plus ancienne.
    LoadOlder,
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
fn to_event_vm(item: &TimelineItem) -> Option<EventVm> {
    let event = item.as_event()?;
    let TimelineItemContent::MsgLike(content) = event.content() else {
        return None;
    };
    let (body, mut state) = match &content.kind {
        MsgLikeKind::Message(message) => (message.body().to_owned(), EventState::Normal),
        MsgLikeKind::UnableToDecrypt(_) => {
            (UNDECRYPTABLE_PLACEHOLDER.to_owned(), EventState::Indechiffrable)
        }
        MsgLikeKind::Redacted => ("Message supprimé".to_owned(), EventState::Normal),
        MsgLikeKind::Sticker(_) => ("[autocollant]".to_owned(), EventState::Normal),
        MsgLikeKind::Poll(_) => ("[sondage]".to_owned(), EventState::Normal),
        _ => ("[contenu non pris en charge]".to_owned(), EventState::Normal),
    };
    if event.is_local_echo() && state == EventState::Normal {
        state = EventState::Local;
    }

    let id = match event.identifier() {
        TimelineEventItemId::EventId(id) => id.to_string(),
        TimelineEventItemId::TransactionId(id) => id.to_string(),
    };
    let sender_name = match event.sender_profile() {
        TimelineDetails::Ready(profile) => profile.display_name.clone(),
        _ => None,
    }
    .filter(|name| !name.trim().is_empty())
    .unwrap_or_else(|| localpart(event.sender().as_str()).to_owned());
    let timestamp_ms = u64::from(event.timestamp().0);

    Some(EventVm {
        id: EventId::from(id.as_str()),
        sender_initials: initials(&sender_name),
        sender_name,
        timestamp_ms,
        time_label: format_time_label(timestamp_ms, &Local),
        body,
        state,
    })
}

fn snapshot<'a>(items: impl IntoIterator<Item = &'a std::sync::Arc<TimelineItem>>) -> Vec<EventVm> {
    items.into_iter().filter_map(|item| to_event_vm(item)).collect()
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
    let timeline = match sdk_room.timeline().await {
        Ok(timeline) => timeline,
        Err(err) => return fail(MatrixError::Other(err.to_string()).to_string()),
    };

    let (initial, stream) = timeline.subscribe().await;
    let mut stream = Box::pin(stream);
    events(snapshot(initial.iter()), None);

    match timeline.paginate_backwards(PAGE_SIZE).await {
        Ok(hit_start) => events(snapshot(timeline.items().await.iter()), Some(hit_start)),
        Err(err) => fail(MatrixError::Other(err.to_string()).to_string()),
    }

    loop {
        tokio::select! {
            batch = stream.next() => {
                if batch.is_none() {
                    return fail("Timeline interrompue.".to_owned());
                }
                events(snapshot(timeline.items().await.iter()), None);
            }
            command = commands.recv() => match command {
                None => return,
                Some(TimelineCommand::LoadOlder) => {
                    match timeline.paginate_backwards(PAGE_SIZE).await {
                        Ok(hit_start) => {
                            events(snapshot(timeline.items().await.iter()), Some(hit_start));
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
