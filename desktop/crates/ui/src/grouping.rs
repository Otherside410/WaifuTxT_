//! Regroupement des messages consécutifs d'un même expéditeur et règle de visibilité des actions.
//! Fonctions pures : ni GPUI ni état de vue, pour pouvoir les tester sans fenêtre.

use domain::{EventState, EventVm};

/// Écart maximal entre deux messages d'un même groupe (strictement : 5 min exactement reste groupé).
pub const GROUP_WINDOW_MS: u64 = 5 * 60 * 1000;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// Place d'un message dans son groupe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupPosition {
    /// Premier du groupe : porte l'en-tête (avatar, nom, heure).
    Start,
    /// Suite du groupe : corps seul.
    Continue,
}

/// Le message `current` ouvre-t-il un groupe, sachant le message affiché juste avant lui ?
///
/// Nouveau groupe si : pas de message précédent, expéditeur différent (nom **et** « envoyé par moi » : les
/// événements n'ont pas d'identifiant d'expéditeur), écart > 5 min (ou horloge qui recule), changement de jour.
/// Le jour est calculé en UTC sur `timestamp_ms` : la couche Matrix ne fournit que l'heure locale déjà formatée.
pub fn starts_group(previous: Option<&EventVm>, current: &EventVm) -> bool {
    let Some(prev) = previous else { return true };
    prev.sender_name != current.sender_name
        || prev.sender_id != current.sender_id
        || prev.is_own != current.is_own
        || current.timestamp_ms.checked_sub(prev.timestamp_ms).is_none_or(|gap| gap > GROUP_WINDOW_MS)
        || prev.timestamp_ms / DAY_MS != current.timestamp_ms / DAY_MS
}

/// Position de chaque message de la liste dans son groupe.
pub fn group_events(events: &[EventVm]) -> Vec<GroupPosition> {
    events
        .iter()
        .enumerate()
        .map(|(i, event)| {
            if starts_group(i.checked_sub(1).map(|j| &events[j]), event) {
                GroupPosition::Start
            } else {
                GroupPosition::Continue
            }
        })
        .collect()
}

/// Le bouton « Envoyer » est actif seulement si le composeur l'est et que le champ contient autre chose que des
/// espaces — la même condition que `prepare_message` côté envoi, pour qu'un bouton actif ne soit jamais sans effet.
pub fn send_enabled(composer_enabled: bool, value: &str) -> bool {
    composer_enabled && !value.trim().is_empty()
}

/// Hachage FNV-1a 32 bits du nom : stable d'un lancement à l'autre et d'une machine à l'autre (contrairement à
/// `DefaultHasher`, dont la graine peut changer).
pub fn name_hash(name: &str) -> u32 {
    name.bytes().fold(0x811c_9dc5u32, |hash, byte| (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193))
}

/// Case de la palette de repli (initiales) pour cet expéditeur. `slots` doit être > 0 ; 0 renvoie 0.
pub fn avatar_slot(name: &str, slots: usize) -> usize {
    if slots == 0 {
        return 0;
    }
    name_hash(name) as usize % slots
}

/// Les actions Modifier / Supprimer sont-elles visibles **au repos** (souris hors de la ligne) ?
/// Seulement pour le message sélectionné (clic ou clavier) ; au survol, la ligne les révèle toujours.
/// Un message sans action possible n'en montre jamais.
pub fn actions_visible_at_rest(selected: bool, can_act: bool) -> bool {
    selected && can_act
}

/// Les libellés d'état (envoi, échec, modifié, lu par…) d'un message, sans l'heure.
pub fn status_suffix(state: EventState, edited: bool, read: Option<&str>) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    match state {
        EventState::Local => parts.push("envoi…"),
        EventState::EchecEnvoi => parts.push("non envoyé"),
        _ => {}
    }
    if edited {
        parts.push("modifié");
    }
    if let Some(read) = read {
        parts.push(read);
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::EventId;

    const T0: u64 = 1_700_000_000_000;

    fn ev(name: &str, own: bool, ts: u64) -> EventVm {
        EventVm {
            id: EventId::from(format!("$e{ts}").as_str()),
            sender_name: name.to_owned(),
            sender_initials: "XX".to_owned(),
            sender_avatar: None,
            sender_id: String::new(),
            timestamp_ms: ts,
            time_label: "00:00".to_owned(),
            body: "x".to_owned(),
            state: EventState::Normal,
            event_id: None,
            is_own: own,
            edited: false,
            read_by: Vec::new(),
            media: None,
        }
    }

    use GroupPosition::{Continue, Start};

    #[test]
    fn an_empty_list_has_no_group() {
        assert!(group_events(&[]).is_empty());
    }

    #[test]
    fn two_members_with_the_same_display_name_but_different_ids_do_not_merge() {
        let (mut a, mut b) = (ev("Sam", false, T0), ev("Sam", false, T0 + 1000));
        a.sender_id = "@sam:a".into();
        b.sender_id = "@sam:b".into();
        assert_eq!(group_events(&[a, b]), vec![Start, Start]);
    }

    #[test]
    fn the_first_message_always_opens_a_group() {
        assert_eq!(group_events(&[ev("A", false, T0)]), vec![Start]);
    }

    #[test]
    fn a_burst_from_one_sender_is_one_group() {
        let burst: Vec<_> = (0..6).map(|i| ev("A", false, T0 + i * 60_000)).collect();
        let g = group_events(&burst);
        assert_eq!(g.iter().filter(|p| **p == Start).count(), 1);
        assert_eq!(g[0], Start);
    }

    #[test]
    fn exactly_five_minutes_stays_grouped_and_one_millisecond_more_splits() {
        assert_eq!(group_events(&[ev("A", false, T0), ev("A", false, T0 + GROUP_WINDOW_MS)]), vec![Start, Continue]);
        assert_eq!(
            group_events(&[ev("A", false, T0), ev("A", false, T0 + GROUP_WINDOW_MS + 1)]),
            vec![Start, Start]
        );
    }

    #[test]
    fn the_gap_is_measured_between_neighbours_not_from_the_group_start() {
        // 4 min puis 4 min : 8 min depuis le début, mais chaque écart est ≤ 5 min.
        let g = group_events(&[ev("A", false, T0), ev("A", false, T0 + 240_000), ev("A", false, T0 + 480_000)]);
        assert_eq!(g, vec![Start, Continue, Continue]);
    }

    #[test]
    fn a_sender_change_opens_a_group_and_coming_back_opens_another() {
        let g = group_events(&[ev("A", false, T0), ev("B", false, T0 + 1000), ev("A", false, T0 + 2000)]);
        assert_eq!(g, vec![Start, Start, Start]);
    }

    #[test]
    fn same_display_name_but_me_versus_someone_else_does_not_merge() {
        assert_eq!(group_events(&[ev("A", false, T0), ev("A", true, T0 + 1000)]), vec![Start, Start]);
    }

    #[test]
    fn a_day_change_opens_a_group_even_within_five_minutes() {
        let midnight = (T0 / DAY_MS + 1) * DAY_MS;
        assert_eq!(group_events(&[ev("A", false, midnight - 1000), ev("A", false, midnight + 1000)]), vec![Start, Start]);
    }

    #[test]
    fn a_clock_going_backwards_opens_a_group() {
        assert_eq!(group_events(&[ev("A", false, T0), ev("A", false, T0 - 1000)]), vec![Start, Start]);
    }

    #[test]
    fn prepending_older_messages_can_turn_the_former_first_row_into_a_continuation() {
        let newer = [ev("A", false, T0)];
        assert_eq!(group_events(&newer), vec![Start]);
        let both = [ev("A", false, T0 - 60_000), ev("A", false, T0)];
        assert_eq!(group_events(&both), vec![Start, Continue]);
    }

    #[test]
    fn the_fallback_colour_slot_is_deterministic_and_within_range() {
        // Valeurs figées : un changement de fonction de hachage changerait la couleur de tout le monde.
        assert_eq!(name_hash(""), 0x811c_9dc5);
        assert_eq!(name_hash("a"), 0xe40c_292c);
        assert_eq!(avatar_slot("Alice Demo", 6), avatar_slot("Alice Demo", 6));
        for name in ["Alice Demo", "Bob Demo", "Moi (démo)", "", "été"] {
            assert!(avatar_slot(name, 6) < 6);
        }
        assert_eq!(avatar_slot("x", 0), 0);
    }

    #[test]
    fn different_names_may_differ_and_collide_only_when_the_hash_says_so() {
        let slots = 6;
        let names = ["Alice Demo", "Bob Demo", "Moi (démo)", "Chloé", "Dave", "Eve"];
        let used: std::collections::HashSet<_> = names.iter().map(|n| avatar_slot(n, slots)).collect();
        assert!(used.len() > 1, "six noms ne tombent pas tous dans la même case");
        let (a, b) = ("Alice Demo", "Bob Demo");
        assert_eq!(avatar_slot(a, slots) == avatar_slot(b, slots), name_hash(a) as usize % slots == name_hash(b) as usize % slots);
    }

    #[test]
    fn the_send_button_needs_an_enabled_composer_and_non_blank_text() {
        assert!(!send_enabled(true, ""));
        assert!(!send_enabled(true, "  \n\t "));
        assert!(send_enabled(true, "salut"));
        assert!(send_enabled(true, "  salut "));
        assert!(!send_enabled(false, "salut"));
    }

    #[test]
    fn actions_show_at_rest_only_for_the_selected_actionable_message() {
        assert!(!actions_visible_at_rest(false, true));
        assert!(actions_visible_at_rest(true, true));
        assert!(!actions_visible_at_rest(true, false));
        assert!(!actions_visible_at_rest(false, false));
    }

    #[test]
    fn status_labels_keep_pending_failed_edited_and_read_information() {
        assert_eq!(status_suffix(EventState::Normal, false, None), None);
        assert_eq!(status_suffix(EventState::Local, false, None).as_deref(), Some("envoi…"));
        assert_eq!(
            status_suffix(EventState::EchecEnvoi, true, Some("vu par bob")).as_deref(),
            Some("non envoyé · modifié · vu par bob")
        );
    }
}
