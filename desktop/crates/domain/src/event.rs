//! Événements de timeline vus par l'UI, fusion de pages et état d'une timeline.
//!
//! L'UI ne manipule jamais un type du SDK : la couche Matrix convertit en [`EventVm`].

use std::collections::HashMap;

use crate::{EventId, RoomId};

/// État d'affichage d'un message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventState {
    Normal,
    /// Message chiffré dont la clé manque : affiché avec un placeholder explicite.
    Indechiffrable,
    /// Écho local pas encore confirmé par le serveur.
    Local,
}

/// Placeholder affiché à la place d'un corps de message indéchiffrable.
pub const UNDECRYPTABLE_PLACEHOLDER: &str =
    "Message chiffré : clé manquante (utilise « Restaurer les clés »)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventVm {
    /// Identifiant stable (id d'événement, ou identifiant de transaction pour un écho local).
    pub id: EventId,
    pub sender_name: String,
    pub sender_initials: String,
    /// Horodatage en millisecondes Unix : sert à l'ordre chronologique.
    pub timestamp_ms: u64,
    /// Heure locale déjà formatée (ex. `14:05`), calculée par la couche Matrix.
    pub time_label: String,
    pub body: String,
    pub state: EventState,
}

/// Résultat d'une fusion : de quoi ancrer le défilement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MergeOutcome {
    /// Événements nouveaux placés **avant** le premier événement qui existait déjà.
    pub prepended: usize,
    /// Événements nouveaux placés après (ou entre) les existants.
    pub appended: usize,
}

/// Fusionne `incoming` dans `existing` : par id (un événement déjà présent est mis à jour, jamais
/// dupliqué), ordre chronologique **stable** (à horodatage égal, l'ordre existant puis l'ordre
/// d'arrivée sont conservés), aucun doublon, y compris au sein de `incoming`.
pub fn merge_events(existing: &mut Vec<EventVm>, incoming: Vec<EventVm>) -> MergeOutcome {
    if incoming.is_empty() {
        return MergeOutcome::default();
    }
    let first_existing = existing.first().map(|e| e.id.clone());
    let mut index: HashMap<EventId, usize> =
        existing.iter().enumerate().map(|(i, e)| (e.id.clone(), i)).collect();
    let before = existing.len();

    for event in incoming {
        match index.get(&event.id) {
            Some(&i) => existing[i] = event,
            None => {
                index.insert(event.id.clone(), existing.len());
                existing.push(event);
            }
        }
    }
    // `sort_by_key` est stable : à horodatage égal, l'ordre actuel est conservé.
    existing.sort_by_key(|e| e.timestamp_ms);

    let added = existing.len() - before;
    let prepended = match first_existing {
        Some(id) => existing.iter().position(|e| e.id == id).unwrap_or(0),
        None => 0,
    };
    // Si aucun ancien événement n'existait, tout est « nouveau » mais rien n'est « avant » une ancre.
    MergeOutcome { prepended: prepended.min(added), appended: added - prepended.min(added) }
}

/// Message d'une tâche de timeline vers l'UI.
#[derive(Debug, Clone, PartialEq)]
pub enum TimelineUpdate {
    /// Page ou instantané d'événements pour `room` ; `at_start` indique si le début du salon est atteint.
    Events { room: RoomId, events: Vec<EventVm>, at_start: Option<bool> },
    Failed { room: RoomId, message: String },
}

impl TimelineUpdate {
    pub fn room(&self) -> &RoomId {
        match self {
            Self::Events { room, .. } | Self::Failed { room, .. } => room,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimelineStatus {
    /// Aucun salon sélectionné.
    Idle,
    /// Salon sélectionné, rien reçu encore.
    Loading,
    Ready,
    Failed(String),
}

/// Effet d'une mise à jour appliquée à [`TimelineState`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Applied {
    /// Mise à jour d'un autre salon que celui sélectionné : ignorée.
    pub ignored: bool,
    pub merge: MergeOutcome,
}

/// Timeline du salon sélectionné. Une réponse tardive d'un ancien salon est ignorée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineState {
    room: Option<RoomId>,
    status: TimelineStatus,
    events: Vec<EventVm>,
    at_start: bool,
    loading_older: bool,
}

impl Default for TimelineState {
    fn default() -> Self {
        Self {
            room: None,
            status: TimelineStatus::Idle,
            events: Vec::new(),
            at_start: false,
            loading_older: false,
        }
    }
}

impl TimelineState {
    pub fn room(&self) -> Option<&RoomId> {
        self.room.as_ref()
    }
    pub fn status(&self) -> &TimelineStatus {
        &self.status
    }
    pub fn events(&self) -> &[EventVm] {
        &self.events
    }
    pub fn at_start(&self) -> bool {
        self.at_start
    }
    pub fn is_loading_older(&self) -> bool {
        self.loading_older
    }

    /// Sélectionne un salon : l'état précédent est abandonné.
    pub fn select(&mut self, room: RoomId) {
        *self = Self { room: Some(room), status: TimelineStatus::Loading, ..Self::default() };
    }

    /// Oublie le salon (ex. déconnexion).
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// Repasse en chargement pour une nouvelle tentative, en gardant le salon.
    pub fn retry(&mut self) {
        if let Some(room) = self.room.clone() {
            self.select(room);
        }
    }

    /// Faut-il demander une page plus ancienne ? Marque la demande comme en cours si oui.
    pub fn begin_older(&mut self) -> bool {
        if self.status == TimelineStatus::Ready && !self.at_start && !self.loading_older {
            self.loading_older = true;
            true
        } else {
            false
        }
    }

    pub fn apply(&mut self, update: TimelineUpdate) -> Applied {
        if self.room.as_ref() != Some(update.room()) {
            return Applied { ignored: true, merge: MergeOutcome::default() };
        }
        match update {
            TimelineUpdate::Events { events, at_start, .. } => {
                let merge = merge_events(&mut self.events, events);
                if let Some(at_start) = at_start {
                    self.at_start = at_start;
                }
                self.loading_older = false;
                self.status = TimelineStatus::Ready;
                Applied { ignored: false, merge }
            }
            TimelineUpdate::Failed { message, .. } => {
                self.loading_older = false;
                // Une erreur de pagination ne détruit pas ce qui est déjà affiché.
                if self.status != TimelineStatus::Ready {
                    self.status = TimelineStatus::Failed(message);
                }
                Applied::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, ts: u64) -> EventVm {
        EventVm {
            id: EventId::from(id),
            sender_name: "Alice".into(),
            sender_initials: "A".into(),
            timestamp_ms: ts,
            time_label: String::new(),
            body: format!("msg {id}"),
            state: EventState::Normal,
        }
    }

    fn ids(events: &[EventVm]) -> Vec<&str> {
        events.iter().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn merges_an_older_page_at_the_top() {
        let mut list = vec![ev("$3", 30), ev("$4", 40)];
        let out = merge_events(&mut list, vec![ev("$1", 10), ev("$2", 20)]);
        assert_eq!(ids(&list), ["$1", "$2", "$3", "$4"]);
        assert_eq!(out, MergeOutcome { prepended: 2, appended: 0 });
    }

    #[test]
    fn merges_new_events_at_the_bottom() {
        let mut list = vec![ev("$1", 10), ev("$2", 20)];
        let out = merge_events(&mut list, vec![ev("$3", 30)]);
        assert_eq!(ids(&list), ["$1", "$2", "$3"]);
        assert_eq!(out, MergeOutcome { prepended: 0, appended: 1 });
    }

    #[test]
    fn partial_overlap_adds_only_new_events_without_duplicates() {
        let mut list = vec![ev("$2", 20), ev("$3", 30), ev("$4", 40)];
        let out = merge_events(&mut list, vec![ev("$1", 10), ev("$2", 20), ev("$3", 30), ev("$5", 50)]);
        assert_eq!(ids(&list), ["$1", "$2", "$3", "$4", "$5"]);
        assert_eq!(out, MergeOutcome { prepended: 1, appended: 1 });
    }

    #[test]
    fn an_event_already_present_is_updated_not_duplicated() {
        let mut list = vec![ev("$1", 10), ev("$2", 20)];
        let mut updated = ev("$2", 20);
        updated.body = "édité".into();
        updated.state = EventState::Indechiffrable;
        let out = merge_events(&mut list, vec![updated]);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].body, "édité");
        assert_eq!(list[1].state, EventState::Indechiffrable);
        assert_eq!(out, MergeOutcome::default());
    }

    #[test]
    fn duplicates_inside_the_incoming_page_are_collapsed() {
        let mut list = Vec::new();
        merge_events(&mut list, vec![ev("$1", 10), ev("$1", 10), ev("$2", 20)]);
        assert_eq!(ids(&list), ["$1", "$2"]);
    }

    #[test]
    fn order_is_chronological_and_stable_on_equal_timestamps() {
        let mut list = vec![ev("$b", 20), ev("$a", 20)];
        merge_events(&mut list, vec![ev("$z", 5), ev("$c", 20)]);
        assert_eq!(ids(&list), ["$z", "$b", "$a", "$c"]);
    }

    #[test]
    fn merging_the_same_page_twice_changes_nothing() {
        let mut list = vec![ev("$1", 10), ev("$2", 20)];
        let page = vec![ev("$1", 10), ev("$2", 20)];
        merge_events(&mut list, page.clone());
        let snapshot = list.clone();
        let out = merge_events(&mut list, page);
        assert_eq!(list, snapshot);
        assert_eq!(out, MergeOutcome::default());
    }

    #[test]
    fn first_page_into_an_empty_list_prepends_nothing() {
        let mut list = Vec::new();
        let out = merge_events(&mut list, vec![ev("$1", 10), ev("$2", 20)]);
        assert_eq!(out.prepended, 0);
        assert_eq!(list.len(), 2);
    }

    fn events_update(room: &str, events: Vec<EventVm>, at_start: Option<bool>) -> TimelineUpdate {
        TimelineUpdate::Events { room: RoomId::from(room), events, at_start }
    }

    #[test]
    fn a_late_answer_from_the_previous_room_is_ignored() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!old:x"));
        state.select(RoomId::from("!new:x"));
        let late = events_update("!old:x", vec![ev("$old", 1)], Some(true));
        assert!(state.apply(late).ignored);
        assert!(state.events().is_empty());
        assert_eq!(state.status(), &TimelineStatus::Loading);
        assert!(!state.at_start());

        let fresh = events_update("!new:x", vec![ev("$new", 2)], Some(false));
        assert!(!state.apply(fresh).ignored);
        assert_eq!(ids(state.events()), ["$new"]);
        assert_eq!(state.status(), &TimelineStatus::Ready);
    }

    #[test]
    fn a_late_failure_from_the_previous_room_is_ignored() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!old:x"));
        state.select(RoomId::from("!new:x"));
        let applied =
            state.apply(TimelineUpdate::Failed { room: RoomId::from("!old:x"), message: "x".into() });
        assert!(applied.ignored);
        assert_eq!(state.status(), &TimelineStatus::Loading);
    }

    #[test]
    fn selecting_a_room_drops_the_previous_events() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(events_update("!a:x", vec![ev("$1", 1)], Some(false)));
        state.select(RoomId::from("!b:x"));
        assert!(state.events().is_empty());
        assert_eq!(state.room(), Some(&RoomId::from("!b:x")));
    }

    #[test]
    fn older_pages_are_requested_once_until_answered_and_never_past_the_start() {
        let mut state = TimelineState::default();
        assert!(!state.begin_older(), "rien à paginer sans salon");
        state.select(RoomId::from("!a:x"));
        assert!(!state.begin_older(), "pas avant le chargement initial");
        state.apply(events_update("!a:x", vec![ev("$5", 50)], Some(false)));
        assert!(state.begin_older());
        assert!(!state.begin_older(), "une seule demande à la fois");
        state.apply(events_update("!a:x", vec![ev("$4", 40)], Some(true)));
        assert!(!state.begin_older(), "début du salon atteint");
    }

    #[test]
    fn a_failed_older_page_keeps_the_events_and_allows_another_try() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(events_update("!a:x", vec![ev("$5", 50)], Some(false)));
        assert!(state.begin_older());
        state.apply(TimelineUpdate::Failed { room: RoomId::from("!a:x"), message: "réseau".into() });
        assert_eq!(state.status(), &TimelineStatus::Ready);
        assert_eq!(state.events().len(), 1);
        assert!(state.begin_older());
    }

    #[test]
    fn initial_failure_is_shown_and_retry_resets_to_loading() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(TimelineUpdate::Failed { room: RoomId::from("!a:x"), message: "réseau".into() });
        assert_eq!(state.status(), &TimelineStatus::Failed("réseau".into()));
        state.retry();
        assert_eq!(state.status(), &TimelineStatus::Loading);
        assert_eq!(state.room(), Some(&RoomId::from("!a:x")));
    }

    #[test]
    fn an_empty_room_is_ready_with_no_events() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(events_update("!a:x", vec![], Some(true)));
        assert_eq!(state.status(), &TimelineStatus::Ready);
        assert!(state.events().is_empty());
    }
}
