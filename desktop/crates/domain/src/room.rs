//! Vue d'un salon pour l'UI : l'UI ne voit jamais un identifiant ou un type `matrix-sdk` brut.

use crate::RoomId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RoomKind {
    Space,
    Room,
    Dm,
}

impl RoomKind {
    /// Rang d'affichage : espaces, puis salons, puis messages directs.
    fn rank(self) -> u8 {
        match self {
            Self::Space => 0,
            Self::Room => 1,
            Self::Dm => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomVm {
    pub id: RoomId,
    pub name: String,
    pub kind: RoomKind,
    pub unread: u32,
    pub avatar_initials: String,
}

impl RoomVm {
    pub fn new(id: RoomId, name: impl Into<String>, kind: RoomKind, unread: u32) -> Self {
        let name = name.into();
        let avatar_initials = initials(&name);
        Self { id, name, kind, unread, avatar_initials }
    }
}

/// Jusqu'à deux initiales (première lettre des deux premiers mots), en majuscules ; `?` si le nom
/// ne contient aucun caractère alphanumérique. Les `#`, `@` et autres préfixes sont ignorés.
fn initials(name: &str) -> String {
    let letters: String = name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .filter_map(|word| word.chars().next())
        .take(2)
        .flat_map(char::to_uppercase)
        .collect();
    if letters.is_empty() {
        "?".to_owned()
    } else {
        letters
    }
}

/// Tri d'affichage **stable** : espaces, puis salons, puis DMs. À l'intérieur d'une catégorie,
/// l'ordre d'entrée (celui que fournit la couche Matrix) est conservé.
pub fn sort_rooms(rooms: &mut [RoomVm]) {
    rooms.sort_by_key(|room| room.kind.rank());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(id: &str, name: &str, kind: RoomKind) -> RoomVm {
        RoomVm::new(RoomId::from(id), name, kind, 0)
    }

    fn ids(rooms: &[RoomVm]) -> Vec<&str> {
        rooms.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn sorts_spaces_then_rooms_then_dms() {
        let mut rooms = vec![
            room("!dm", "Alice", RoomKind::Dm),
            room("!r1", "général", RoomKind::Room),
            room("!s1", "Serveur", RoomKind::Space),
        ];
        sort_rooms(&mut rooms);
        assert_eq!(ids(&rooms), ["!s1", "!r1", "!dm"]);
    }

    #[test]
    fn sort_is_stable_within_a_kind() {
        let mut rooms = vec![
            room("!r3", "c", RoomKind::Room),
            room("!s2", "z", RoomKind::Space),
            room("!r1", "a", RoomKind::Room),
            room("!s1", "y", RoomKind::Space),
            room("!r2", "b", RoomKind::Room),
        ];
        sort_rooms(&mut rooms);
        assert_eq!(ids(&rooms), ["!s2", "!s1", "!r3", "!r1", "!r2"]);
    }

    #[test]
    fn sort_is_idempotent() {
        let mut rooms = vec![room("!a", "a", RoomKind::Dm), room("!b", "b", RoomKind::Space)];
        sort_rooms(&mut rooms);
        let once = rooms.clone();
        sort_rooms(&mut rooms);
        assert_eq!(rooms, once);
    }

    #[test]
    fn initials_come_from_first_two_words() {
        assert_eq!(initials("Waifu Chat Dev"), "WC");
        assert_eq!(initials("général"), "G");
        assert_eq!(initials("#salon-test"), "ST");
        assert_eq!(initials("@alice:example.org"), "AE");
    }

    #[test]
    fn initials_fall_back_when_name_has_no_letters() {
        assert_eq!(initials(""), "?");
        assert_eq!(initials("  --  "), "?");
    }

    #[test]
    fn new_fills_initials() {
        assert_eq!(room("!x", "Mon Salon", RoomKind::Room).avatar_initials, "MS");
    }
}
