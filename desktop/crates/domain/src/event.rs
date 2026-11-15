//! Événements de timeline vus par l'UI, fusion de pages et état d'une timeline.
//!
//! L'UI ne manipule jamais un type du SDK : la couche Matrix convertit en [`EventVm`].

use std::collections::HashMap;

use crate::media::{sniff_image_format, MediaLoad, MediaPayload, MediaVm};
use crate::{EventId, RoomId};

/// État d'affichage d'un message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventState {
    Normal,
    /// Message chiffré dont la clé manque : affiché avec un placeholder explicite.
    Indechiffrable,
    /// Écho local pas encore confirmé par le serveur.
    Local,
    /// Envoi refusé ou échoué côté serveur : le message n'est pas parti.
    EchecEnvoi,
    /// Message supprimé (redaction) : espace réservé, la ligne garde sa hauteur.
    Supprime,
}

/// Texte de l'espace réservé d'un message supprimé.
pub const REDACTED_PLACEHOLDER: &str = "Message supprimé";

/// Placeholder affiché à la place d'un corps de message indéchiffrable.
pub const UNDECRYPTABLE_PLACEHOLDER: &str =
    "Message chiffré : clé manquante (utilise « Restaurer les clés »)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventVm {
    /// Identifiant **stable pendant toute la vie du message** : il ne change pas quand un écho local est
    /// confirmé par le serveur (la couche Matrix utilise l'identifiant unique de l'élément de timeline,
    /// pas l'id d'événement, qui n'existe qu'après l'envoi).
    pub id: EventId,
    pub sender_name: String,
    pub sender_initials: String,
    /// Horodatage en millisecondes Unix : sert à l'ordre chronologique.
    pub timestamp_ms: u64,
    /// Heure locale déjà formatée (ex. `14:05`), calculée par la couche Matrix.
    pub time_label: String,
    pub body: String,
    pub state: EventState,
    /// Identifiant d'événement **réel** (pour éditer/supprimer) : `None` sur un écho local, rempli une fois
    /// le message confirmé par le serveur. Ne sert pas de clé de fusion (voir `id`).
    pub event_id: Option<EventId>,
    /// Message envoyé par moi.
    pub is_own: bool,
    /// Message modifié après coup (mention « modifié »).
    pub edited: bool,
    /// Membres (autres que moi) dont l'accusé de lecture pointe sur ce message, par nom court.
    pub read_by: Vec<String>,
    /// Média joint (image, fichier, audio, vidéo) ; `None` pour un message texte.
    pub media: Option<MediaVm>,
}

impl EventVm {
    /// Peut-on modifier ou supprimer ce message ? Le mien, confirmé par le serveur, ni supprimé ni en échec.
    pub fn can_edit_or_delete(&self) -> bool {
        self.is_own && self.event_id.is_some() && self.state == EventState::Normal
    }
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

/// Applique une édition au message `target` (par id d'événement) : nouveau texte, mention « modifié », aucune
/// nouvelle ligne. `false` si le message n'existe pas (ou est supprimé).
pub fn apply_edit(events: &mut [EventVm], target: &EventId, new_body: &str) -> bool {
    match events.iter_mut().find(|e| e.event_id.as_ref() == Some(target)) {
        Some(event) if event.state != EventState::Supprime => {
            event.body = new_body.to_owned();
            event.edited = true;
            true
        }
        _ => false,
    }
}

/// Supprime (redaction) le message `target` : la ligne devient un espace réservé de même hauteur.
pub fn redact_event(events: &mut [EventVm], target: &EventId) -> bool {
    match events.iter_mut().find(|e| e.event_id.as_ref() == Some(target)) {
        Some(event) => {
            event.body = REDACTED_PLACEHOLDER.to_owned();
            event.state = EventState::Supprime;
            event.edited = false;
            true
        }
        None => false,
    }
}

/// Indice du **dernier** message sur lequel au moins un autre membre a posé son accusé de lecture.
pub fn last_read_marker(events: &[EventVm]) -> Option<usize> {
    events.iter().rposition(|e| !e.read_by.is_empty())
}

/// Libellé « vu par … » sobre : deux noms au plus, puis un compteur.
pub fn read_by_label(names: &[String]) -> Option<String> {
    match names {
        [] => None,
        [a] => Some(format!("vu par {a}")),
        [a, b] => Some(format!("vu par {a}, {b}")),
        [a, b, rest @ ..] => Some(format!("vu par {a}, {b} +{}", rest.len())),
    }
}

/// Libellé de l'indicateur de frappe ; `None` si personne n'écrit.
pub fn typing_label(users: &[String]) -> Option<String> {
    match users {
        [] => None,
        [a] => Some(format!("{a} écrit…")),
        [a, b] => Some(format!("{a} et {b} écrivent…")),
        many => Some(format!("{} personnes écrivent…", many.len())),
    }
}

/// Limite l'envoi des `typing_notice` : une notice au début de la frappe, une relance toutes les
/// [`TYPING_RESEND_MS`] tant qu'on tape, et un arrêt après [`TYPING_IDLE_MS`] d'inactivité ou à l'envoi.
/// Logique pure : l'horloge (millisecondes) est fournie par l'appelant.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TypingThrottle {
    active: bool,
    last_notice_ms: u64,
    last_key_ms: u64,
}

/// Intervalle de relance d'une notice « je tape » (le serveur l'expire seul au bout de ~30 s).
pub const TYPING_RESEND_MS: u64 = 20_000;
/// Inactivité au bout de laquelle on annonce qu'on ne tape plus.
pub const TYPING_IDLE_MS: u64 = 4_000;

impl TypingThrottle {
    /// Une frappe à l'instant `now_ms` : `Some(true)` si une notice doit partir.
    pub fn keystroke(&mut self, now_ms: u64) -> Option<bool> {
        self.last_key_ms = now_ms;
        if !self.active || now_ms.saturating_sub(self.last_notice_ms) >= TYPING_RESEND_MS {
            self.active = true;
            self.last_notice_ms = now_ms;
            Some(true)
        } else {
            None
        }
    }

    /// Passage du temps : `Some(false)` quand l'inactivité justifie d'annoncer qu'on a cessé d'écrire.
    pub fn tick(&mut self, now_ms: u64) -> Option<bool> {
        if self.active && now_ms.saturating_sub(self.last_key_ms) >= TYPING_IDLE_MS {
            self.active = false;
            Some(false)
        } else {
            None
        }
    }

    /// Arrêt immédiat (message envoyé, champ vidé, changement de salon).
    pub fn stop(&mut self) -> Option<bool> {
        if self.active {
            self.active = false;
            Some(false)
        } else {
            None
        }
    }
}

/// Message d'une tâche de timeline vers l'UI.
#[derive(Debug, Clone, PartialEq)]
pub enum TimelineUpdate {
    /// Page ou instantané d'événements pour `room` ; `at_start` indique si le début du salon est atteint.
    Events { room: RoomId, events: Vec<EventVm>, at_start: Option<bool> },
    Failed { room: RoomId, message: String },
    /// L'envoi d'un message n'a pas pu être mis en file : `text` est le brouillon à restituer.
    SendFailed { room: RoomId, text: String, message: String },
    /// L'édition de `event_id` a échoué : `text` est la version saisie, à restituer.
    EditFailed { room: RoomId, event_id: EventId, text: String, message: String },
    /// La suppression de `event_id` a échoué.
    DeleteFailed { room: RoomId, event_id: EventId, message: String },
    /// Membres qui écrivent actuellement dans le salon (moi exclu), par nom court.
    Typing { room: RoomId, users: Vec<String> },
    /// Octets d'un média téléchargé (ou échec) pour l'identifiant logique `key`.
    Media { room: RoomId, key: String, payload: MediaPayload },
    /// L'envoi de la pièce jointe `path` a échoué (fichier illisible, trop gros, réseau…).
    AttachmentFailed { room: RoomId, path: String, message: String },
}

impl TimelineUpdate {
    pub fn room(&self) -> &RoomId {
        match self {
            Self::Events { room, .. }
            | Self::Failed { room, .. }
            | Self::SendFailed { room, .. }
            | Self::EditFailed { room, .. }
            | Self::DeleteFailed { room, .. }
            | Self::Typing { room, .. }
            | Self::Media { room, .. }
            | Self::AttachmentFailed { room, .. } => room,
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

/// Action qui a échoué, pour la relancer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailedAction {
    Send,
    /// Envoi d'une pièce jointe depuis le chemin donné.
    Attach(String),
    Edit(EventId),
    Delete(EventId),
}

/// Action échouée (envoi, édition ou suppression) avec la raison affichable ; `text` est le brouillon à
/// restituer (vide pour une suppression).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendFailure {
    pub text: String,
    pub message: String,
    pub action: FailedAction,
}

/// Texte à envoyer pour la saisie `raw` : `None` si elle est vide ou ne contient que des espaces (rien
/// ne part, aucun effet). Les espaces de bord sont retirés, les sauts de ligne internes conservés.
pub fn prepare_message(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Timeline du salon sélectionné. Une réponse tardive d'un ancien salon est ignorée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineState {
    room: Option<RoomId>,
    status: TimelineStatus,
    events: Vec<EventVm>,
    at_start: bool,
    loading_older: bool,
    send_failure: Option<SendFailure>,
    typing: Vec<String>,
    read_marked: Option<EventId>,
    media: HashMap<String, MediaPayload>,
}

impl Default for TimelineState {
    fn default() -> Self {
        Self {
            room: None,
            status: TimelineStatus::Idle,
            events: Vec::new(),
            at_start: false,
            loading_older: false,
            send_failure: None,
            typing: Vec::new(),
            read_marked: None,
            media: HashMap::new(),
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
    /// Dernier envoi échoué du salon sélectionné, tant que l'utilisateur ne l'a pas relancé.
    pub fn send_failure(&self) -> Option<&SendFailure> {
        self.send_failure.as_ref()
    }
    pub fn clear_send_failure(&mut self) {
        self.send_failure = None;
    }
    /// Avancement du téléchargement des octets du média `key`.
    pub fn media_load(&self, key: &str) -> MediaLoad {
        match self.media.get(key) {
            None => MediaLoad::Loading,
            Some(MediaPayload::Ready(_)) => MediaLoad::Ready,
            Some(MediaPayload::Failed(reason)) => MediaLoad::Failed(reason.clone()),
        }
    }

    /// Octets d'un média prêt.
    pub fn media_bytes(&self, key: &str) -> Option<&std::sync::Arc<Vec<u8>>> {
        match self.media.get(key) {
            Some(MediaPayload::Ready(bytes)) => Some(bytes),
            _ => None,
        }
    }

    /// Membres qui écrivent dans le salon sélectionné.
    pub fn typing(&self) -> &[String] {
        &self.typing
    }

    /// Faut-il envoyer un accusé de lecture ? Oui une seule fois par dernier message distant, quand la
    /// timeline est prête et que la lecture est collée en bas ; jamais pour un écho local (sans `event_id`).
    pub fn needs_read_receipt(&mut self, at_bottom: bool) -> bool {
        if self.status != TimelineStatus::Ready || !at_bottom {
            return false;
        }
        let Some(last) = self.events.last() else {
            return false;
        };
        if last.event_id.is_none() || self.read_marked.as_ref() == Some(&last.id) {
            return false;
        }
        self.read_marked = Some(last.id.clone());
        true
    }

    /// Édition appliquée localement (mode démonstration) : voir [`apply_edit`].
    pub fn edit_local(&mut self, target: &EventId, new_body: &str) -> bool {
        apply_edit(&mut self.events, target, new_body)
    }

    /// Suppression appliquée localement (mode démonstration) : voir [`redact_event`].
    pub fn redact_local(&mut self, target: &EventId) -> bool {
        redact_event(&mut self.events, target)
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
            TimelineUpdate::SendFailed { text, message, .. } => {
                self.send_failure = Some(SendFailure { text, message, action: FailedAction::Send });
                Applied::default()
            }
            TimelineUpdate::EditFailed { event_id, text, message, .. } => {
                self.send_failure =
                    Some(SendFailure { text, message, action: FailedAction::Edit(event_id) });
                Applied::default()
            }
            TimelineUpdate::DeleteFailed { event_id, message, .. } => {
                self.send_failure = Some(SendFailure {
                    text: String::new(),
                    message,
                    action: FailedAction::Delete(event_id),
                });
                Applied::default()
            }
            TimelineUpdate::Typing { users, .. } => {
                self.typing = users;
                Applied::default()
            }
            TimelineUpdate::Media { key, payload, .. } => {
                // Des octets qui ne sont pas une image reconnue deviennent un échec lisible, jamais un
                // décodage tenté sur n'importe quoi.
                let stored = match payload {
                    MediaPayload::Ready(bytes) if sniff_image_format(&bytes).is_none() => {
                        MediaPayload::Failed("format d'image non pris en charge".to_owned())
                    }
                    other => other,
                };
                self.media.insert(key, stored);
                Applied::default()
            }
            TimelineUpdate::AttachmentFailed { path, message, .. } => {
                let name = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_owned();
                self.send_failure = Some(SendFailure {
                    text: name,
                    message,
                    action: FailedAction::Attach(path),
                });
                Applied::default()
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
            event_id: Some(EventId::from(id)),
            is_own: false,
            edited: false,
            read_by: Vec::new(),
            media: None,
        }
    }

    fn own(id: &str, ts: u64) -> EventVm {
        EventVm { is_own: true, ..ev(id, ts) }
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
    fn a_local_echo_confirmed_by_the_server_replaces_the_row_without_duplicate() {
        let mut list = vec![ev("$1", 10)];
        let mut echo = ev("$local", 100);
        echo.state = EventState::Local;
        merge_events(&mut list, vec![echo]);
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].state, EventState::Local);

        // Confirmation : même id stable, état et horodatage serveur mis à jour.
        let mut confirmed = ev("$local", 105);
        confirmed.state = EventState::Normal;
        let out = merge_events(&mut list, vec![confirmed]);
        assert_eq!(ids(&list), ["$1", "$local"]);
        assert_eq!(list[1].state, EventState::Normal);
        assert_eq!(list[1].timestamp_ms, 105);
        assert_eq!(out, MergeOutcome::default(), "rien de nouveau : une mise à jour");
    }

    #[test]
    fn a_confirmed_echo_keeps_its_place_when_the_server_time_reorders_it() {
        let mut list = vec![ev("$a", 10)];
        let mut echo = ev("$local", 100);
        echo.state = EventState::Local;
        merge_events(&mut list, vec![echo, ev("$b", 102)]);
        assert_eq!(ids(&list), ["$a", "$local", "$b"]);
        // Le serveur date le message après $b : la ligne bouge, sans être dupliquée.
        merge_events(&mut list, vec![ev("$local", 103)]);
        assert_eq!(ids(&list), ["$a", "$b", "$local"]);
    }

    #[test]
    fn empty_or_blank_text_is_not_sent() {
        assert_eq!(prepare_message(""), None);
        assert_eq!(prepare_message("   "), None);
        assert_eq!(prepare_message("\n\t \n"), None);
    }

    #[test]
    fn text_is_trimmed_but_inner_newlines_are_kept() {
        assert_eq!(prepare_message("  bonjour  "), Some("bonjour".to_owned()));
        assert_eq!(prepare_message("a\nb\n"), Some("a\nb".to_owned()));
    }

    #[test]
    fn a_send_failure_keeps_the_draft_and_is_scoped_to_the_selected_room() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(events_update("!a:x", vec![ev("$1", 1)], Some(false)));
        let late = TimelineUpdate::SendFailed {
            room: RoomId::from("!autre:x"),
            text: "ancien".into(),
            message: "x".into(),
        };
        assert!(state.apply(late).ignored);
        assert_eq!(state.send_failure(), None);

        let failed = TimelineUpdate::SendFailed {
            room: RoomId::from("!a:x"),
            text: "mon brouillon".into(),
            message: "réseau coupé".into(),
        };
        state.apply(failed);
        let failure = state.send_failure().expect("échec mémorisé");
        assert_eq!(failure.text, "mon brouillon");
        assert_eq!(failure.message, "réseau coupé");
        assert_eq!(state.status(), &TimelineStatus::Ready, "la timeline affichée n'est pas détruite");
        state.clear_send_failure();
        assert_eq!(state.send_failure(), None);
    }

    #[test]
    fn selecting_another_room_drops_a_pending_send_failure() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(TimelineUpdate::SendFailed {
            room: RoomId::from("!a:x"),
            text: "t".into(),
            message: "m".into(),
        });
        state.select(RoomId::from("!b:x"));
        assert_eq!(state.send_failure(), None);
    }


    #[test]
    fn event_id_is_none_on_a_local_echo_and_filled_on_confirmation() {
        let mut list = Vec::new();
        let mut echo = own("local-1", 100);
        echo.state = EventState::Local;
        echo.event_id = None;
        merge_events(&mut list, vec![echo.clone()]);
        assert_eq!(list[0].event_id, None);
        assert!(!list[0].can_edit_or_delete(), "un écho local ne se modifie pas");

        // Confirmation : même clé de fusion (`id`), l'id d'événement réel apparaît.
        let confirmed = EventVm {
            state: EventState::Normal,
            event_id: Some(EventId::from("$vrai")),
            ..echo
        };
        merge_events(&mut list, vec![confirmed]);
        assert_eq!(list.len(), 1, "aucun doublon");
        assert_eq!(list[0].event_id, Some(EventId::from("$vrai")));
        assert!(list[0].can_edit_or_delete());
    }

    #[test]
    fn only_my_confirmed_normal_messages_can_be_edited_or_deleted() {
        assert!(own("$a", 1).can_edit_or_delete());
        assert!(!ev("$a", 1).can_edit_or_delete(), "pas le mien");
        let deleted = EventVm { state: EventState::Supprime, ..own("$a", 1) };
        assert!(!deleted.can_edit_or_delete());
        let failed = EventVm { state: EventState::EchecEnvoi, ..own("$a", 1) };
        assert!(!failed.can_edit_or_delete());
    }

    #[test]
    fn an_edit_updates_the_text_in_place_without_a_new_row() {
        let mut list = vec![ev("$1", 1), own("$2", 2), ev("$3", 3)];
        assert!(apply_edit(&mut list, &EventId::from("$2"), "version corrigée"));
        assert_eq!(list.len(), 3);
        assert_eq!(ids(&list), ["$1", "$2", "$3"]);
        assert_eq!(list[1].body, "version corrigée");
        assert!(list[1].edited, "mention « modifié »");
        assert!(!apply_edit(&mut list, &EventId::from("$absent"), "x"));
    }

    #[test]
    fn an_edit_arriving_through_the_merge_replaces_the_row() {
        let mut list = vec![own("$2", 2)];
        let edited = EventVm { body: "édité".into(), edited: true, ..own("$2", 2) };
        merge_events(&mut list, vec![edited]);
        assert_eq!(list.len(), 1);
        assert!(list[0].edited);
    }

    #[test]
    fn redaction_turns_the_row_into_a_placeholder_of_the_same_row() {
        let mut list = vec![ev("$1", 1), own("$2", 2)];
        list[1].edited = true;
        assert!(redact_event(&mut list, &EventId::from("$2")));
        assert_eq!(list.len(), 2, "la ligne reste (hauteur de défilement conservée)");
        assert_eq!(list[1].body, REDACTED_PLACEHOLDER);
        assert_eq!(list[1].state, EventState::Supprime);
        assert!(!list[1].edited);
        assert!(!list[1].can_edit_or_delete());
        assert!(!apply_edit(&mut list, &EventId::from("$2"), "ressuscité"), "un message supprimé ne s'édite pas");
        assert!(!redact_event(&mut list, &EventId::from("$absent")));
    }

    #[test]
    fn the_read_marker_is_on_the_last_message_with_readers() {
        let mut list = vec![ev("$1", 1), ev("$2", 2), ev("$3", 3)];
        assert_eq!(last_read_marker(&list), None);
        list[0].read_by = vec!["alice".into()];
        list[1].read_by = vec!["alice".into(), "bob".into()];
        assert_eq!(last_read_marker(&list), Some(1), "le dernier concerné, pas le dernier message");
        list[2].read_by = vec!["bob".into()];
        assert_eq!(last_read_marker(&list), Some(2));
    }

    #[test]
    fn read_by_label_is_sober() {
        assert_eq!(read_by_label(&[]), None);
        assert_eq!(read_by_label(&["alice".into()]).as_deref(), Some("vu par alice"));
        assert_eq!(read_by_label(&["alice".into(), "bob".into()]).as_deref(), Some("vu par alice, bob"));
        let many: Vec<String> = ["a", "b", "c", "d"].iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(read_by_label(&many).as_deref(), Some("vu par a, b +2"));
    }

    #[test]
    fn typing_label_handles_one_two_and_many() {
        assert_eq!(typing_label(&[]), None);
        assert_eq!(typing_label(&["Alice".into()]).as_deref(), Some("Alice écrit…"));
        assert_eq!(typing_label(&["Alice".into(), "Bob".into()]).as_deref(), Some("Alice et Bob écrivent…"));
        let three: Vec<String> = ["a", "b", "c"].iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(typing_label(&three).as_deref(), Some("3 personnes écrivent…"));
    }

    #[test]
    fn typing_sends_one_notice_per_window_not_one_per_keystroke() {
        let mut throttle = TypingThrottle::default();
        assert_eq!(throttle.keystroke(1_000), Some(true), "première frappe : notice");
        for t in (1_100..5_000).step_by(100) {
            assert_eq!(throttle.keystroke(t), None, "frappe à {t} ms : pas de nouvelle notice");
        }
        // Toujours en train de taper après la fenêtre de relance : une seule relance.
        assert_eq!(throttle.keystroke(1_000 + TYPING_RESEND_MS), Some(true));
        assert_eq!(throttle.keystroke(1_000 + TYPING_RESEND_MS + 50), None);
    }

    #[test]
    fn typing_stops_after_idle_and_on_demand() {
        let mut throttle = TypingThrottle::default();
        assert_eq!(throttle.tick(10_000), None, "rien à arrêter si on n'a pas commencé");
        throttle.keystroke(1_000);
        assert_eq!(throttle.tick(1_000 + TYPING_IDLE_MS - 1), None, "pas encore inactif");
        assert_eq!(throttle.tick(1_000 + TYPING_IDLE_MS), Some(false));
        assert_eq!(throttle.tick(1_000 + TYPING_IDLE_MS + 1), None, "un seul arrêt");
        // Reprise : nouvelle notice.
        assert_eq!(throttle.keystroke(20_000), Some(true));
        assert_eq!(throttle.stop(), Some(false));
        assert_eq!(throttle.stop(), None);
    }

    #[test]
    fn a_read_receipt_is_requested_once_per_last_remote_message_when_at_the_bottom() {
        let mut state = TimelineState::default();
        assert!(!state.needs_read_receipt(true), "rien sans salon");
        state.select(RoomId::from("!a:x"));
        assert!(!state.needs_read_receipt(true), "pas avant le chargement");
        state.apply(events_update("!a:x", vec![ev("$1", 1), ev("$2", 2)], Some(false)));
        assert!(!state.needs_read_receipt(false), "pas en bas : pas d'accusé");
        assert!(state.needs_read_receipt(true));
        assert!(!state.needs_read_receipt(true), "déjà envoyé pour ce dernier message");
        state.apply(events_update("!a:x", vec![ev("$3", 3)], None));
        assert!(state.needs_read_receipt(true), "nouveau dernier message");
    }

    #[test]
    fn no_read_receipt_for_a_local_echo() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        let mut echo = own("local", 5);
        echo.event_id = None;
        echo.state = EventState::Local;
        state.apply(events_update("!a:x", vec![echo], Some(true)));
        assert!(!state.needs_read_receipt(true));
    }

    #[test]
    fn edit_and_delete_failures_keep_what_is_needed_to_retry() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(TimelineUpdate::EditFailed {
            room: RoomId::from("!a:x"),
            event_id: EventId::from("$2"),
            text: "ma version".into(),
            message: "réseau".into(),
        });
        let failure = state.send_failure().expect("échec d'édition");
        assert_eq!(failure.action, FailedAction::Edit(EventId::from("$2")));
        assert_eq!(failure.text, "ma version");

        state.apply(TimelineUpdate::DeleteFailed {
            room: RoomId::from("!a:x"),
            event_id: EventId::from("$2"),
            message: "refusé".into(),
        });
        assert_eq!(state.send_failure().map(|f| f.action.clone()), Some(FailedAction::Delete(EventId::from("$2"))));
    }

    #[test]
    fn typing_users_are_scoped_to_the_selected_room_and_reset_on_selection() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        let late = TimelineUpdate::Typing { room: RoomId::from("!autre:x"), users: vec!["z".into()] };
        assert!(state.apply(late).ignored);
        assert!(state.typing().is_empty());
        state.apply(TimelineUpdate::Typing { room: RoomId::from("!a:x"), users: vec!["alice".into()] });
        assert_eq!(state.typing(), ["alice"]);
        state.select(RoomId::from("!b:x"));
        assert!(state.typing().is_empty());
    }

    #[test]
    fn media_bytes_are_scoped_to_the_selected_room_and_must_be_a_known_image() {
        use crate::media::{MediaLoad, MediaPayload};
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        assert_eq!(state.media_load("mxc://s/i"), MediaLoad::Loading, "pas encore reçu");

        let png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        let late = TimelineUpdate::Media {
            room: RoomId::from("!autre:x"),
            key: "mxc://s/i".into(),
            payload: MediaPayload::Ready(std::sync::Arc::new(png.clone())),
        };
        assert!(state.apply(late).ignored, "octets d'un autre salon ignorés");
        assert_eq!(state.media_load("mxc://s/i"), MediaLoad::Loading);

        state.apply(TimelineUpdate::Media {
            room: RoomId::from("!a:x"),
            key: "mxc://s/i".into(),
            payload: MediaPayload::Ready(std::sync::Arc::new(png)),
        });
        assert_eq!(state.media_load("mxc://s/i"), MediaLoad::Ready);
        assert!(state.media_bytes("mxc://s/i").is_some());

        // Des octets qui ne sont pas une image reconnue deviennent un échec lisible, jamais décodés.
        state.apply(TimelineUpdate::Media {
            room: RoomId::from("!a:x"),
            key: "mxc://s/bad".into(),
            payload: MediaPayload::Ready(std::sync::Arc::new(b"<svg onload=...>".to_vec())),
        });
        assert!(matches!(state.media_load("mxc://s/bad"), MediaLoad::Failed(_)));
        assert!(state.media_bytes("mxc://s/bad").is_none());

        state.select(RoomId::from("!b:x"));
        assert_eq!(state.media_load("mxc://s/i"), MediaLoad::Loading, "reset au changement de salon");
    }

    #[test]
    fn an_attachment_failure_keeps_the_path_to_retry() {
        let mut state = TimelineState::default();
        state.select(RoomId::from("!a:x"));
        state.apply(TimelineUpdate::AttachmentFailed {
            room: RoomId::from("!a:x"),
            path: "/home/u/Images/photo.png".into(),
            message: "Fichier trop volumineux (60,0 Mo, limite 50,0 Mo).".into(),
        });
        let failure = state.send_failure().expect("échec mémorisé");
        assert_eq!(failure.action, FailedAction::Attach("/home/u/Images/photo.png".into()));
        assert_eq!(failure.text, "photo.png");
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
