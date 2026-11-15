//! Données factices du mode `--demo-ui` : aucune connexion, mêmes types que le flux réel.

use domain::{EventId, EventState, EventVm, RoomId, RoomKind, RoomVm, UNDECRYPTABLE_PLACEHOLDER};

/// Taille d'une page de la timeline de démonstration.
pub const DEMO_PAGE: usize = 50;
/// Nombre de messages du salon « général » de démonstration.
pub const DEMO_MESSAGES: usize = 200;
/// Rang (0 = plus ancien) du message indéchiffrable de démonstration.
pub const DEMO_UNDECRYPTABLE_AT: usize = DEMO_MESSAGES - 3;

pub const SPACE_ID: &str = "!demo-space:demo";
pub const ROOM_ID: &str = "!demo-room:demo";
pub const DM_ID: &str = "!demo-dm:demo";

/// Salons factices : un espace, un salon, un DM.
pub fn demo_rooms() -> Vec<RoomVm> {
    let room =
        |id: &str, name: &str, kind, unread| RoomVm::new(RoomId::from(id), name, kind, unread);
    vec![
        room(SPACE_ID, "Démo Serveur", RoomKind::Space, 0),
        room(ROOM_ID, "général", RoomKind::Room, 3),
        room(DM_ID, "Alice Demo", RoomKind::Dm, 1),
    ]
}

fn demo_event(rank: usize) -> EventVm {
    // Un message sur quatre est de moi : ceux-là peuvent être modifiés ou supprimés.
    let own = rank % 4 == 3;
    let (name, initials) = if own {
        ("Moi (démo)", "MD")
    } else if rank.is_multiple_of(2) {
        ("Alice Demo", "AD")
    } else {
        ("Bob Demo", "BD")
    };
    let minutes = rank % (24 * 60);
    let undecryptable = rank == DEMO_UNDECRYPTABLE_AT;
    EventVm {
        id: EventId::from(format!("$demo-{rank:04}").as_str()),
        sender_name: name.to_owned(),
        sender_initials: initials.to_owned(),
        timestamp_ms: 1_700_000_000_000 + rank as u64 * 60_000,
        time_label: format!("{:02}:{:02}", minutes / 60, minutes % 60),
        body: if undecryptable {
            UNDECRYPTABLE_PLACEHOLDER.to_owned()
        } else {
            format!("Message de démonstration n°{rank}")
        },
        state: if undecryptable { EventState::Indechiffrable } else { EventState::Normal },
        event_id: Some(EventId::from(format!("$demo-ev-{rank:04}").as_str())),
        is_own: own,
        edited: false,
        // Le dernier message a été lu par deux autres membres.
        read_by: if rank + 1 == DEMO_MESSAGES {
            vec!["alice".to_owned(), "bob".to_owned()]
        } else {
            Vec::new()
        },
    }
}

/// Historique complet d'un salon de démonstration (le DM et l'espace sont vides).
fn history(room: &RoomId) -> Vec<EventVm> {
    if room.as_str() == ROOM_ID {
        (0..DEMO_MESSAGES).map(demo_event).collect()
    } else {
        Vec::new()
    }
}

/// Dernière page du salon : `(événements, début atteint)`.
pub fn initial_page(room: &RoomId) -> (Vec<EventVm>, bool) {
    let all = history(room);
    let start = all.len().saturating_sub(DEMO_PAGE);
    (all[start..].to_vec(), start == 0)
}

/// Page précédant l'événement `oldest` (le plus ancien déjà chargé) : `(événements, début atteint)`.
pub fn older_page(room: &RoomId, oldest: &EventId) -> (Vec<EventVm>, bool) {
    let all = history(room);
    let end = all.iter().position(|e| &e.id == oldest).unwrap_or(0);
    let start = end.saturating_sub(DEMO_PAGE);
    (all[start..end].to_vec(), start == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_history_pages_cover_everything_without_overlap() {
        let room = RoomId::from(ROOM_ID);
        let (mut loaded, mut at_start) = initial_page(&room);
        assert_eq!(loaded.len(), DEMO_PAGE);
        while !at_start {
            let (page, start) = older_page(&room, &loaded[0].id);
            let mut merged = page;
            merged.extend(loaded);
            loaded = merged;
            at_start = start;
        }
        assert_eq!(loaded.len(), DEMO_MESSAGES);
        let mut ids: Vec<_> = loaded.iter().map(|e| e.id.as_str()).collect();
        ids.dedup();
        assert_eq!(ids.len(), DEMO_MESSAGES);
    }

    #[test]
    fn dm_and_space_are_empty() {
        for id in [DM_ID, SPACE_ID] {
            assert_eq!(initial_page(&RoomId::from(id)), (Vec::new(), true));
        }
    }
}
