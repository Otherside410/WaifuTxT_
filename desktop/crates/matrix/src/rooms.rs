//! Liste des salons lue sur l'état **déjà synchronisé** (aucun appel réseau).

use domain::{sort_rooms, RoomId, RoomKind, RoomVm};
use matrix_sdk::{Client, RoomDisplayName};

/// Nom affiché quand le SDK n'a aucun nom exploitable.
const UNNAMED_ROOM: &str = "Salon sans nom";

fn display_name(name: Option<RoomDisplayName>) -> String {
    match name {
        Some(
            RoomDisplayName::Named(n)
            | RoomDisplayName::Aliased(n)
            | RoomDisplayName::Calculated(n)
            | RoomDisplayName::EmptyWas(n),
        ) if !n.trim().is_empty() => n,
        _ => UNNAMED_ROOM.to_owned(),
    }
}

/// Salons rejoints, triés espaces → salons → DMs. À l'intérieur d'une catégorie, l'ordre est celui du
/// nom (insensible à la casse) puis de l'identifiant : le SDK ne définit pas d'ordre, celui-ci est
/// déterministe d'une synchronisation à l'autre.
pub async fn room_list(client: &Client) -> Vec<RoomVm> {
    let mut rooms = Vec::new();
    for room in client.joined_rooms() {
        let kind = if room.is_space() {
            RoomKind::Space
        } else if room.is_direct().await.unwrap_or(false) {
            RoomKind::Dm
        } else {
            RoomKind::Room
        };
        let unread = u32::try_from(room.num_unread_notifications()).unwrap_or(u32::MAX);
        rooms.push(RoomVm::new(
            RoomId::from(room.room_id().as_str()),
            display_name(room.cached_display_name()),
            kind,
            unread,
        ));
    }
    rooms.sort_by(|a, b| {
        a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.id.cmp(&b.id))
    });
    sort_rooms(&mut rooms);
    rooms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_uses_any_named_variant() {
        assert_eq!(display_name(Some(RoomDisplayName::Named("Général".into()))), "Général");
        assert_eq!(display_name(Some(RoomDisplayName::Aliased("#a:b".into()))), "#a:b");
        assert_eq!(display_name(Some(RoomDisplayName::Calculated("Alice".into()))), "Alice");
    }

    #[test]
    fn display_name_falls_back_when_empty() {
        assert_eq!(display_name(None), UNNAMED_ROOM);
        assert_eq!(display_name(Some(RoomDisplayName::Empty)), UNNAMED_ROOM);
        assert_eq!(display_name(Some(RoomDisplayName::Named("  ".into()))), UNNAMED_ROOM);
    }
}
