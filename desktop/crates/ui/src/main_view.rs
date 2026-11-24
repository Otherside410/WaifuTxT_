//! Vue principale après connexion : barre latérale des salons, zone centrale (sans timeline avant
//! l'étape 5) et modal de clé de récupération. Aucun appel réseau : tout arrive par `set_*`.

use std::cell::RefCell;
use std::fmt;

use std::collections::HashMap;
use std::sync::Arc;

use domain::{
    avatar_key, Presence,
    last_read_marker, ConnectionState, media_display, prepare_message, read_by_label, sniff_image_format,
    remember_recent_emoji, typing_label, validate_recovery_key, EventId, EventState, EventVm, FailedAction, ImageKind,
    KeyStatus, MediaDisplay, MediaKind, MediaPayload, MediaStatus, MediaVm, ReactionVm, RecoveryKey, RoomId,
    RoomKind, RoomVm, TimelineState, TimelineStatus, TimelineUpdate, TypingThrottle,
    QUICK_EMOJIS, THUMBNAIL_SIDE, TYPING_IDLE_MS,
};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Disableable, Sizable};
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

use crate::demo;
use crate::grouping::{actions_visible_at_rest, avatar_slot, send_enabled, starts_group, status_suffix};
use crate::modal::ModalState;
use crate::theme_gpui::Palette;

const SIDEBAR_WIDTH: f32 = 280.0;
/// Hauteur **constante** d'une ligne de message : prérequis de la virtualisation (`uniform_list`).
pub const EVENT_ROW_HEIGHT: f32 = 48.0;
/// Avatar de l'en-tête de groupe.
const AVATAR_SIZE: f32 = 32.0;
/// Diamètre de la pastille de présence (hors anneau de 1 px).
const PRESENCE_DOT: f32 = 8.0;
/// Échelle typographique de la timeline : corps 13 px, métadonnées 11 px.
const BODY_TEXT_SIZE: f32 = 13.0;
const META_TEXT_SIZE: f32 = 11.0;
/// Bande de légende de la visionneuse, sous l'image.
const VIEWER_CAPTION_HEIGHT: f32 = 20.0;
/// On demande une page plus ancienne quand la vue est à moins de N lignes du haut de la liste.
const PAGINATE_THRESHOLD_ROWS: f32 = 5.0;
/// Sous ce nombre de lignes chargées, la liste ne remplit peut-être pas la fenêtre : on pagine d'office.
const FILL_ROWS: usize = 20;
/// Hauteur réservée au bandeau « chargement… / début de la conversation » (constante, voir plus bas).
const BANNER_HEIGHT: f32 = 24.0;
/// Délai avant la confirmation simulée d'un envoi en mode démonstration.
const DEMO_CONFIRM_DELAY: std::time::Duration = std::time::Duration::from_millis(600);
/// Pastille de réaction : hauteur fixe, glissée sous le corps du message dans les 48 px de la ligne.
/// Largeur du sélecteur : huit cellules de 28 px et le remplissage.
const PICKER_WIDTH: f32 = 8.0 * 28.0 + 16.0;
const REACTION_CHIP_HEIGHT: f32 = 18.0;
/// Hauteur et interligne des deux lignes de texte d'un message **qui porte des réactions** (13 px de corps) :
/// 15 + 15 + 18 (pastilles) = 48 px, quelle que soit la police. Sans réaction, rien n'est touché.
const REACTION_TEXT_LINE_HEIGHT: f32 = 15.0;
/// Un clic sur « Réagir » moins de ce délai après la fermeture du sélecteur par un clic extérieur n'ouvre rien : le
/// même geste a déjà fermé le panneau (le bouton se comporte alors en bascule).
const PICKER_REOPEN_GUARD: std::time::Duration = std::time::Duration::from_millis(1500);
/// Écart maximal entre le clic qui a fermé le sélecteur et celui reçu par le bouton pour y voir un seul geste.
const PICKER_SAME_GESTURE: f32 = 24.0;
const COMPOSER_PLACEHOLDER: &str = "Écrire un message…";
/// Aide clavier, affichée en 11 px sous le champ (elle ne tient plus dans le placeholder).
const COMPOSER_HINT: &str = "Entrée : envoyer · Maj+Entrée : saut de ligne";

/// En-tête d'une ligne de message : ouvre-t-elle un groupe, et la photo de l'expéditeur si ses octets sont en cache.
struct RowHead {
    starts_group: bool,
    avatar: Option<Arc<Image>>,
    /// Présence de l'expéditeur : pastille sur l'avatar sauf si `Unknown`.
    presence: Presence,
    /// Réactions du message (table latérale), vide : aucune rangée.
    reactions: Vec<ReactionVm>,
    /// Le sélecteur d'émojis de ce message est ouvert, avec les récents de la session et le focus du panneau.
    picker: Option<PickerRender>,
}

/// Ce qu'il faut pour dessiner le sélecteur rapide d'un message.
struct PickerRender {
    recent: Vec<String>,
    focus: FocusHandle,
}

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
    /// Ajouter ou retirer ma réaction `key` sur le message `event_id` (le SDK décide selon l'état courant).
    ToggleReaction { room: RoomId, event_id: EventId, key: String },
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
    /// Clé du média (identifie l'image à agrandir).
    key: String,
    /// Nom de fichier, pour le libellé de la visionneuse.
    filename: String,
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
            key: media.key.clone(),
            filename: media.filename.clone(),
            card_label,
            aria,
        }
    }
}

/// Couleur de la pastille ; `None` pour `Unknown` (aucun élément dessiné).
fn presence_color(presence: Presence, p: &Palette) -> Option<Hsla> {
    match presence {
        Presence::Online => Some(p.presence_online),
        Presence::Unavailable => Some(p.presence_away),
        Presence::Offline => Some(p.presence_offline),
        Presence::Unknown => None,
    }
}

/// Gestionnaire de clic d'une vignette décodée.
type OpenViewer = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// Image agrandie dans la visionneuse : clé dans `images` et nom affiché.
struct ViewerState {
    key: String,
    title: String,
}

impl MediaRender {
    /// Seule une image **décodée** s'agrandit : ni chargement, ni échec, ni fichier, ni envoi en cours.
    fn viewable(&self) -> bool {
        matches!(self.display, MediaDisplay::Thumbnail) && self.image.is_some()
    }
}

pub struct MainView {
    /// Visionneuse plein écran ouverte (`None` : fermée) et son focus, pris à l'ouverture pour que Échap la ferme.
    viewer: Option<ViewerState>,
    viewer_focus: FocusHandle,
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
    /// Message dont le sélecteur d'émojis est ouvert, et son focus (pris à l'ouverture pour que Échap le ferme).
    reaction_picker: Option<EventId>,
    picker_focus: FocusHandle,
    /// Dernière fermeture par clic extérieur (message, instant, position du clic), voir [`PICKER_REOPEN_GUARD`].
    picker_dismissed: Option<(EventId, std::time::Instant, Point<Pixels>)>,
    /// Émojis récents de la session, le plus récent en tête (rien n'est persisté).
    recent_emojis: Vec<String>,
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
            viewer: None,
            viewer_focus: cx.focus_handle(),
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
            reaction_picker: None,
            picker_focus: cx.focus_handle(),
            picker_dismissed: None,
            recent_emojis: Vec::new(),
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
        // Photo d'Alice fournie en mémoire (aucun téléchargement).
        let (key, payload) = demo::demo_avatar_payload();
        view.apply_timeline(TimelineUpdate::Media { room: RoomId::from(demo::ROOM_ID), key, payload }, cx);
        // Démonstration : un message avec trois réactions dont une de moi (n°196) et le n°198 avec une seule.
        let reactions = |key: &str, senders: &[&str]| ReactionVm {
            key: key.to_owned(),
            count: senders.len(),
            reacted_by_me: senders.contains(&"moi"),
            senders: senders.iter().map(|name| (*name).to_owned()).collect(),
        };
        view.timeline.apply(TimelineUpdate::Reactions {
            room: RoomId::from(demo::ROOM_ID),
            reactions: vec![
                (
                    EventId::from("$demo-ev-0196"),
                    vec![reactions("👍", &["alice", "bob", "moi"]), reactions("🎉", &["alice"]), reactions("❤️", &["bob", "alice"])],
                ),
                (EventId::from("$demo-ev-0198"), vec![reactions("😂", &["bob"])]),
            ],
        });
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

    /// Démonstration de la visionneuse : comme [`MainView::demo_media`], avec la première image déjà agrandie.
    pub fn demo_viewer(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::demo_media(window, cx);
        if let Some(key) = demo::media_events().1.into_iter().map(|(key, _)| key).next() {
            view.open_viewer(key, "paysage.bmp".to_owned(), window, cx);
        }
        view
    }

    /// Démonstration de la présence : `--demo-timeline` avec les trois états (Alice en ligne, Bob absent, moi hors
    /// ligne), injectés en mémoire comme le ferait `SyncUpdate::Presence` ; sans ce drapeau, aucune pastille.
    pub fn demo_presence(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::demo_timeline(window, cx);
        view.apply_presence(demo::DEMO_ALICE, Presence::Online, cx);
        view.apply_presence(demo::DEMO_BOB, Presence::Unavailable, cx);
        view.apply_presence(demo::DEMO_ME, Presence::Offline, cx);
        view
    }

    /// Démonstration du sélecteur : `--demo-timeline` avec deux récents et le sélecteur ouvert sur le dernier message.
    pub fn demo_picker(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::demo_timeline(window, cx);
        remember_recent_emoji(&mut view.recent_emojis, QUICK_EMOJIS[6]);
        remember_recent_emoji(&mut view.recent_emojis, QUICK_EMOJIS[2]);
        view.reaction_picker = view.timeline.events().last().and_then(|event| event.event_id.clone());
        view.selected_event = view.timeline.events().last().map(|event| event.id.clone());
        window.focus(&view.picker_focus, cx);
        view
    }

    /// Présence d'un seul utilisateur : ne redessine que si elle a changé (pas de rechargement de la timeline).
    pub fn apply_presence(&mut self, user_id: &str, state: Presence, cx: &mut Context<Self>) {
        if self.timeline.set_presence(user_id, state) {
            cx.notify();
        }
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
        self.reaction_picker = None;
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
        // Le bouton « Envoyer » dépend du contenu : on redessine à chaque changement.
        cx.notify();
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

    /// Ouvre (ou ferme) le sélecteur d'émojis du message `event_id` ; le focus passe au panneau pour que Échap le ferme.
    fn toggle_picker(&mut self, event_id: EventId, click: &ClickEvent, window: &mut Window, cx: &mut Context<Self>) {
        // Même geste que le clic extérieur qui vient de fermer ce sélecteur : le bouton se comporte en bascule.
        let near = |a: Point<Pixels>, b: Point<Pixels>| {
            f32::from((a.x - b.x).abs()) <= PICKER_SAME_GESTURE && f32::from((a.y - b.y).abs()) <= PICKER_SAME_GESTURE
        };
        let recently_dismissed = matches!(
            (&self.picker_dismissed, click.mouse_position()),
            (Some((id, at, down)), Some(up)) if *id == event_id && at.elapsed() < PICKER_REOPEN_GUARD && near(*down, up)
        );
        self.picker_dismissed = None;
        if self.reaction_picker.as_ref() == Some(&event_id) || recently_dismissed {
            self.reaction_picker = None;
        } else {
            self.reaction_picker = Some(event_id);
            window.focus(&self.picker_focus, cx);
        }
        cx.notify();
    }

    fn close_picker(&mut self, cx: &mut Context<Self>) {
        if self.reaction_picker.take().is_some() {
            cx.notify();
        }
    }

    /// Réaction `key` (ajout ou retrait, décidé par le SDK) sur `event_id` : le sélecteur se ferme, l'émoji passe en
    /// tête des récents, puis commande vers le pont (ou bascule locale en démonstration). Aucun appel réseau ici.
    fn react(&mut self, event_id: EventId, key: String, cx: &mut Context<Self>) {
        let Some(room) = self.timeline.room().cloned() else {
            return;
        };
        self.timeline.clear_send_failure();
        self.reaction_picker = None;
        remember_recent_emoji(&mut self.recent_emojis, &key);
        if self.demo {
            self.timeline.toggle_reaction_local(&event_id, &key, "moi");
        } else {
            cx.emit(MainEvent::ToggleReaction { room, event_id, key });
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
            FailedAction::React(event_id, key) => self.react(event_id, key, cx),
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
            sender_avatar: None,
            sender_id: String::new(),
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
            sender_avatar: None,
            sender_id: String::new(),
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
        let p = Palette::of(cx);
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
            .border_color(p.border)
            // Indicateur de frappe : hauteur réservée pour ne pas faire sauter la liste.
            .child(
                div()
                    .id("typing-indicator")
                    .h(px(16.0))
                    .text_xs()
                    .text_color(p.text_secondary)
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
                            .text_color(p.text)
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
                            .text_color(p.text_secondary)
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
                    .child(div().flex_1().min_w_0().text_sm().text_color(p.error).child(message))
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
                    .child(div().flex_1().min_w_0().text_sm().text_color(p.error).child(failure.message))
                    .child(
                        Button::new("composer-retry")
                            .label("Réessayer")
                            .on_click(cx.listener(|this, _, window, cx| this.retry_send(window, cx))),
                    )
                    .test_support()
                    .aria_label(label)
            }))
            // Bloc de saisie arrondi : champ transparent, puis une barre (aide clavier à gauche, Joindre et Envoyer à droite).
            .child(
                div()
                    .id("composer-box")
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_2()
                    .rounded_lg()
                    .bg(p.panel)
                    .border_1()
                    .border_color(p.border)
                    .test_support()
                    .aria_label("Bloc de saisie")
                    .child(
                        Textarea::new(&self.composer)
                            .appearance(false)
                            .accessibility_id("composer-input")
                            .disabled(!enabled)
                            .aria_label("Message"),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .text_size(px(META_TEXT_SIZE))
                                    .text_color(p.text_secondary)
                                    .child(COMPOSER_HINT),
                            )
                            .child(
                                Button::new("attach-button")
                                    .label("Joindre")
                                    .small()
                                    .disabled(!enabled)
                                    .on_click(cx.listener(|this, _, _, cx| this.pick_attachment(cx))),
                            )
                            .child(
                                // Même chemin que la touche Entrée : `submit_composer`, sans logique propre.
                                Button::new("send-button")
                                    .primary()
                                    .label("Envoyer")
                                    .small()
                                    .disabled(!send_enabled(enabled, &self.composer.read(cx).value()))
                                    .on_click(cx.listener(|this, _, window, cx| this.submit_composer(window, cx))),
                            ),
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
        let p = Palette::of(cx);
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
            .bg(if selected { p.selected } else { p.panel })
            .hover(|style| style.bg(if selected { p.selected } else { p.hover }))
            .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
            .child(
                div()
                    .size(px(32.0))
                    .rounded(px(if room.kind == RoomKind::Space { 8.0 } else { 16.0 }))
                    .bg(p.border)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(p.text)
                    .child(room.avatar_initials.clone()),
            )
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .text_sm()
                    .text_color(if room.unread > 0 { p.text } else { p.text_secondary })
                    .child(room.name.clone()),
            )
            .children((room.unread > 0).then(|| {
                div()
                    .id(SharedString::from(format!("unread-{index}")))
                    .px_2()
                    .rounded_full()
                    .bg(p.accent)
                    .text_xs()
                    .text_color(p.text)
                    .child(badge_text.clone())
                    .test_support()
                    .aria_label(SharedString::from(format!("{badge_text} non lus")))
            }))
            .test_support()
            .aria_label(accessible_name)
    }

    fn section_title(label: &'static str, p: Palette) -> impl IntoElement {
        div().px_2().pt_3().pb_1().text_xs().text_color(p.text_secondary).child(label)
    }

    fn sidebar_body(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::of(cx);
        match &self.rooms {
            RoomsState::Syncing => div()
                .id("rooms-state")
                .p_3()
                .text_sm()
                .text_color(p.text_secondary)
                .child("Synchronisation…")
                .test_support()
                .aria_label("Synchronisation…")
                .into_any_element(),
            RoomsState::Failed(message) => div()
                .p_3()
                .text_sm()
                .text_color(p.error)
                .child(message.clone())
                .into_any_element(),
            RoomsState::Ready(rooms) if rooms.is_empty() => div()
                .p_3()
                .text_sm()
                .text_color(p.text_secondary)
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
                        }, p));
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
    fn media_box(index: usize, media: &MediaRender, p: Palette, open: Option<OpenViewer>) -> impl IntoElement {
        let side = px(THUMBNAIL_SIDE as f32);
        let glyph = |text: String| div().text_xs().text_color(p.text_secondary).child(text);
        // Clic : ouvre la visionneuse ; le bouton enfoncé ne remonte pas, donc la ligne n'est pas sélectionnée.
        let boxed = div()
            .id(SharedString::from(format!("media-{index}")))
            .size(side)
            .flex_none()
            .when_some(open, |this, open| {
                this.cursor_pointer()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(open)
            });
        let content: AnyElement = match (&media.display, &media.image) {
            // L'image remplit la boîte (recadrage centré, ratio conservé) et porte elle-même l'arrondi : le
            // recadrage rectangulaire d'`overflow_hidden` ne suit pas les coins.
            (MediaDisplay::Thumbnail, Some(image)) => {
                return boxed
                    .child(
                        img(image.clone())
                            .id(SharedString::from(format!("media-image-{index}")))
                            .size(side)
                            .rounded_md()
                            .object_fit(ObjectFit::Cover)
                            .test_support()
                            .aria_label(SharedString::from(media.aria.clone())),
                    )
                    .test_support()
                    .aria_label(SharedString::from(media.aria.clone()));
            }
            // Octets pas encore là (ou image refusée) : espace réservé de même taille.
            (MediaDisplay::Thumbnail | MediaDisplay::Loading, _) => glyph("…".to_owned()).into_any_element(),
            (MediaDisplay::Unavailable(_), _) => glyph("?".to_owned()).into_any_element(),
            (MediaDisplay::Card, _) => glyph(media.card_label.clone()).into_any_element(),
            (MediaDisplay::Uploading(percent), _) => {
                glyph(percent.map_or_else(|| "↑".to_owned(), |p| format!("{p} %"))).into_any_element()
            }
            (MediaDisplay::UploadFailed(_), _) => {
                div().text_xs().text_color(p.error).child("!").into_any_element()
            }
        };
        boxed
            .rounded_md()
            .overflow_hidden()
            .bg(p.border)
            .flex()
            .items_center()
            .justify_center()
            .child(content)
            .test_support()
            .aria_label(SharedString::from(media.aria.clone()))
    }

    /// Ouvre la visionneuse sur une image décodée et prend le focus (pour que Échap la ferme).
    fn open_viewer(&mut self, key: String, title: String, window: &mut Window, cx: &mut Context<Self>) {
        self.viewer = Some(ViewerState { key, title });
        window.focus(&self.viewer_focus, cx);
        cx.notify();
    }

    fn close_viewer(&mut self, cx: &mut Context<Self>) {
        if self.viewer.take().is_some() {
            cx.notify();
        }
    }

    /// Visionneuse plein écran : voile `p.background` à 90 %, image entière (`Contain`) ; Échap ou un clic hors
    /// de l'image la ferme.
    fn media_viewer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = Palette::of(cx);
        let viewer = self.viewer.as_ref()?;
        let image = self.images.get(&viewer.key)?.clone();
        let label = SharedString::from(format!("Visionneuse d'image : {}", viewer.title));
        Some(
            div()
                .id("media-viewer")
                .track_focus(&self.viewer_focus)
                .absolute()
                .size_full()
                .bg(p.background.opacity(0.9))
                .flex()
                .flex_col()
                .items_center()
                .px_8()
                .pt_8()
                .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                    if event.keystroke.key == "escape" {
                        this.close_viewer(cx);
                    }
                }))
                .on_click(cx.listener(|this, _, _, cx| this.close_viewer(cx)))
                .child(
                    // Un clic sur l'image ne ferme pas : on coupe la propagation du bouton enfoncé.
                    div()
                        .id("media-viewer-frame")
                        .w_full()
                        .flex_1()
                        .min_h_0()
                        // Cadre positionné + découpe : l'image, en absolu, prend la taille *résolue* du cadre
                        // (en `size_full` d'un enfant flex, la hauteur en % restait indéfinie et `Contain`
                        // dimensionnait l'image sur la largeur seule : 9 px de peinture sous le cadre).
                        .relative()
                        .overflow_hidden()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            img(image)
                                .id("media-viewer-image")
                                .absolute()
                                .top_0()
                                .left_0()
                                .size_full()
                                .rounded_md()
                                .object_fit(ObjectFit::Contain)
                                .test_support()
                                .aria_label(label.clone()),
                        )
                        .test_support()
                        .aria_label("Cadre de l'image"),
                )
                .child(
                    // Légende dans sa propre bande sous l'image (jamais posée dessus) : la zone image vaut
                    // « fenêtre − bande », l'image reste entière (`Contain`).
                    div()
                        .id("media-viewer-caption")
                        .w_full()
                        .h(px(VIEWER_CAPTION_HEIGHT))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(p.background.opacity(0.9))
                        .text_size(px(META_TEXT_SIZE))
                        .text_color(p.text_secondary)
                        .child(format!("{} · Échap ou clic hors de l'image pour fermer", viewer.title))
                        .test_support()
                        .aria_label(SharedString::from(format!("Légende : {}", viewer.title))),
                )
                .test_support()
                .aria_label(label)
                .into_any_element(),
        )
    }

    /// Sélecteur rapide ancré au bouton « Réagir » : récents de la session (8 max, le plus récent en tête) puis
    /// grille fixe de 16 émojis. Échap, un clic extérieur ou un choix le ferme.
    fn reaction_picker(
        target: &Option<EventId>,
        picker: PickerRender,
        p: Palette,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let PickerRender { recent, focus } = picker;
        let cell = |id: String, emoji: &str, target: &Option<EventId>, cx: &mut Context<Self>| {
            let (event_id, key) = (target.clone(), emoji.to_owned());
            Button::new(SharedString::from(id))
                .ghost()
                .xsmall()
                .label(emoji.to_owned())
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(id) = event_id.clone() {
                        this.react(id, key.clone(), cx);
                    }
                }))
        };
        let recents = (!recent.is_empty()).then(|| {
            div()
                .id("reaction-picker-recent")
                .flex()
                .flex_col()
                .gap_1()
                .child(div().text_size(px(META_TEXT_SIZE)).text_color(p.text_secondary).child("Récents"))
                .child(div().flex().flex_wrap().children(
                    recent.iter().enumerate().map(|(n, emoji)| cell(format!("picker-recent-{n}"), emoji, target, cx)),
                ))
                .test_support()
                .aria_label("Émojis récents")
        });
        div()
            .absolute()
            .top_full()
            .right_0()
            .child(deferred(
                anchored().anchor(Anchor::TopRight).snap_to_window_with_margin(px(8.0)).child(
                    div()
                        .id("reaction-picker")
                        .track_focus(&focus)
                        .w(px(PICKER_WIDTH))
                        .p_2()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .rounded_md()
                        .bg(p.panel)
                        .border_1()
                        .border_color(p.border)
                        .shadow_md()
                        .occlude()
                        .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                            if event.keystroke.key == "escape" {
                                this.close_picker(cx);
                            }
                        }))
                        .on_mouse_down_out(cx.listener(|this, event: &MouseDownEvent, _, cx| {
                            if let Some(id) = this.reaction_picker.take() {
                                this.picker_dismissed = Some((id, std::time::Instant::now(), event.position));
                                cx.notify();
                            }
                        }))
                        .children(recents)
                        .child(div().flex().flex_wrap().children(
                            QUICK_EMOJIS.iter().enumerate().map(|(n, emoji)| cell(format!("picker-emoji-{n}"), emoji, target, cx)),
                        ))
                        .test_support()
                        .aria_label("Choisir une réaction"),
                ),
            ))
    }

    fn event_row(
        index: usize,
        event: &EventVm,
        read_label: Option<String>,
        media: Option<MediaRender>,
        selected: bool,
        head: RowHead,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = Palette::of(cx);
        let RowHead { starts_group, avatar, presence, reactions, picker } = head;
        let has_reactions = !reactions.is_empty();
        let undecryptable = event.state == EventState::Indechiffrable;
        let media_failed = matches!(
            media.as_ref().map(|m| &m.display),
            Some(MediaDisplay::Unavailable(_) | MediaDisplay::UploadFailed(_))
        );
        let failed = event.state == EventState::EchecEnvoi || media_failed;
        let deleted = event.state == EventState::Supprime;
        let dim = event.state == EventState::Local || deleted;
        // Libellés d'état : en en-tête avec l'heure, sinon (suite de groupe) à la suite du corps.
        let status = status_suffix(event.state, event.edited, read_label.as_deref());
        let time_label = match &status {
            Some(status) => format!("{} · {status}", event.time_label),
            None => event.time_label.clone(),
        };
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
        // « Réagir » : tout message confirmé et sain, le mien ou non ; modifier/supprimer : le mien seulement.
        let actions = event.event_id.clone().filter(|_| event.state == EventState::Normal).map(|event_id| {
            let body = event.body.clone();
            let own = event.can_edit_or_delete();
            let picker_open = picker.is_some();
            let (edit_id, delete_id, react_id) = (event_id.clone(), event_id.clone(), event_id);
            let react_button = Button::new(SharedString::from(format!("react-{index}")))
                .label("Réagir")
                .xsmall()
                .on_click(cx.listener(move |this, click, window, cx| this.toggle_picker(react_id.clone(), click, window, cx)));
            let panel = picker.map(|picker| {
                Self::reaction_picker(&event.event_id, picker, p, cx)
            });
            div()
                .id(SharedString::from(format!("actions-{index}")))
                .absolute()
                .right_3()
                .top_1()
                .flex_none()
                .flex()
                .gap_1()
                .p_1()
                .rounded_md()
                .bg(p.panel)
                .border_1()
                .border_color(p.border)
                // Invisibles au repos, révélées au survol de la ligne ; le message sélectionné les garde
                // visibles (accès sans souris : sélection puis Tab vers les boutons), de même tant que le
                // sélecteur est ouvert (il est ancré à la barre).
                .opacity(if picker_open || actions_visible_at_rest(selected, true) { 1.0 } else { 0.0 })
                .group_hover("event-row", |style| style.opacity(1.0))
                .test_support()
                .aria_label("Actions du message")
                .child(div().relative().child(react_button).children(panel))
                // Un média n'a pas de texte à modifier : seule la suppression est proposée.
                .children((own && event.media.is_none()).then(|| {
                    Button::new(SharedString::from(format!("edit-{index}")))
                        .label("Modifier")
                        .xsmall()
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.begin_edit(edit_id.clone(), body.clone(), window, cx);
                        }))
                }))
                .children(own.then(|| {
                    Button::new(SharedString::from(format!("delete-{index}")))
                        .label("Supprimer")
                        .xsmall()
                        .on_click(cx.listener(move |this, _, _, cx| this.ask_delete(delete_id.clone(), cx)))
                }))
        });
        let row_id = event.id.clone();
        let media_aria = media.as_ref().map(|m| m.aria.clone());
        let opacity = if dim { 0.6 } else { 1.0 };
        let body_color = if undecryptable || failed { p.error } else { p.text_secondary };
        let body = div()
            .w_full()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .text_size(px(BODY_TEXT_SIZE))
            .when(has_reactions, |line| line.h(px(REACTION_TEXT_LINE_HEIGHT)).line_height(px(REACTION_TEXT_LINE_HEIGHT)))
            .when(deleted, |row| row.italic())
            .text_color(body_color)
            .child(body_text.clone());
        // Rangée de pastilles **sous** le corps : jamais à sa place, hauteur fixe, dans les 48 px de la ligne.
        let chips = has_reactions.then(|| {
            div()
                .id(SharedString::from(format!("reactions-{index}")))
                .w_full()
                .h(px(REACTION_CHIP_HEIGHT))
                .flex_none()
                .flex()
                .items_center()
                .gap_1()
                .overflow_hidden()
                .test_support()
                .aria_label("Réactions")
                .children(reactions.iter().map(|reaction| {
                    let (event_id, key) = (event.event_id.clone(), reaction.key.clone());
                    let senders = SharedString::from(reaction.senders.join(", "));
                    let mine = reaction.reacted_by_me;
                    div()
                        .id(SharedString::from(format!("reaction-{index}-{}", reaction.key)))
                        .h(px(REACTION_CHIP_HEIGHT))
                        .flex_none()
                        .px(px(6.0))
                        .flex()
                        .items_center()
                        .gap(px(3.0))
                        .rounded(px(REACTION_CHIP_HEIGHT / 2.0))
                        .border_1()
                        .border_color(if mine { p.accent } else { p.border })
                        .bg(if mine { p.accent.opacity(0.18) } else { p.panel })
                        .hover(|style| style.bg(if mine { p.accent.opacity(0.28) } else { p.hover }))
                        .text_size(px(META_TEXT_SIZE))
                        .text_color(if mine { p.text } else { p.text_secondary })
                        .cursor_pointer()
                        .child(reaction.key.clone())
                        .child(reaction.count.to_string())
                        .tooltip(move |window, cx| Tooltip::new(senders.clone()).build(window, cx))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(id) = event_id.clone() {
                                this.react(id, key.clone(), cx);
                            }
                        }))
                        .test_support()
                        .aria_label(SharedString::from(reaction.aria_label()))
                }))
        });
        let text_column = if starts_group {
            div()
                .opacity(opacity)
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .id(SharedString::from(format!("event-header-{index}")))
                        .flex()
                        .gap_2()
                        .items_baseline()
                        .when(has_reactions, |line| line.h(px(REACTION_TEXT_LINE_HEIGHT)).line_height(px(REACTION_TEXT_LINE_HEIGHT)))
                        .child(div().text_size(px(BODY_TEXT_SIZE)).text_color(p.text).child(event.sender_name.clone()))
                        .child(div().text_size(px(META_TEXT_SIZE)).text_color(p.text_secondary).child(time_label))
                        .test_support()
                        .aria_label(SharedString::from(format!("{} {}", event.sender_name, event.time_label))),
                )
                .child(body)
                .children(chips)
        } else {
            let line = div()
                .flex()
                .items_baseline()
                .gap_2()
                .child(div().min_w_0().flex_1().child(body))
                .children(
                    status.map(|status| div().flex_none().text_size(px(META_TEXT_SIZE)).text_color(p.text_secondary).child(status)),
                );
            match chips {
                Some(chips) => div().opacity(opacity).flex_1().min_w_0().flex().flex_col().child(line.w_full()).child(chips),
                None => line.opacity(opacity).flex_1().min_w_0(),
            }
        };
        div()
            .id(SharedString::from(format!("event-{index}")))
            .group("event-row")
            .relative()
            .w_full()
            .h(px(EVENT_ROW_HEIGHT))
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .bg(if selected { p.selected } else { p.background })
            .on_click(cx.listener(move |this, _, _, cx| {
                this.selected_event = Some(row_id.clone());
                cx.notify();
            }))
            .child(if starts_group {
                let background = if selected { p.selected } else { p.background };
                let badge = presence_color(presence, &p).map(|color| {
                    // Pastille de 8 px cerclée de 1 px à la couleur du fond de ligne, en bas à droite de l'avatar.
                    div()
                        .id(SharedString::from(format!("presence-{index}")))
                        .absolute()
                        .right(px(-2.0))
                        .bottom(px(-2.0))
                        .size(px(PRESENCE_DOT + 2.0))
                        .rounded(px((PRESENCE_DOT + 2.0) / 2.0))
                        .bg(background)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(div().size(px(PRESENCE_DOT)).rounded(px(PRESENCE_DOT / 2.0)).bg(color))
                        .test_support()
                        .aria_label(presence.label().unwrap_or_default())
                });
                let avatar_element = {
                match avatar {
                    // Photo de profil ronde ; sans octets (pas de photo, téléchargement en cours ou échec) : initiales.
                    Some(image) => div()
                        .opacity(opacity)
                        .id(SharedString::from(format!("avatar-{index}")))
                        .size(px(AVATAR_SIZE))
                        .flex_none()
                        .child(
                            img(image)
                                .size(px(AVATAR_SIZE))
                                .rounded(px(AVATAR_SIZE / 2.0))
                                .object_fit(ObjectFit::Cover),
                        )
                        .test_support()
                        .aria_label(SharedString::from(format!("Photo de {}", event.sender_name)))
                        .into_any_element(),
                    None => div()
                        .opacity(opacity)
                        .id(SharedString::from(format!("avatar-{index}")))
                        .size(px(AVATAR_SIZE))
                        .flex_none()
                        .rounded(px(AVATAR_SIZE / 2.0))
                        .bg(p.avatar_fallbacks[avatar_slot(&event.sender_name, p.avatar_fallbacks.len())])
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_size(px(META_TEXT_SIZE))
                        .text_color(p.background)
                        .child(event.sender_initials.clone())
                        .test_support()
                        .aria_label(SharedString::from(format!("Initiales de {}", event.sender_name)))
                        .into_any_element(),
                }
                };
                div().relative().size(px(AVATAR_SIZE)).flex_none().child(avatar_element).children(badge).into_any_element()
            } else {
                // Suite de groupe : l'espace de l'avatar est conservé pour aligner les corps.
                div().size(px(AVATAR_SIZE)).flex_none().into_any_element()
            })
            .child(text_column)
            .children(
                // Vignette à droite ; les actions flottent par-dessus la ligne (aucune colonne réservée).
                media.as_ref().map(|m| {
                    let open: Option<OpenViewer> = m.viewable().then(|| {
                        let (key, title) = (m.key.clone(), m.filename.clone());
                        Box::new(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_viewer(key.clone(), title.clone(), window, cx);
                        })) as OpenViewer
                    });
                    div()
                        .w(px(THUMBNAIL_SIDE as f32))
                        .flex_none()
                        .flex()
                        .justify_end()
                        .child(Self::media_box(index, m, p, open))
                }),
            )
            .children(actions)
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
        let p = Palette::of(cx);
        let base = div().flex_1().min_h_0().flex().flex_col().min_w_0();
        let message = |id: &'static str, text: String, color: Hsla| {
            div()
                .id(id)
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_color(color)
                .child(text.clone())
                .test_support()
                .aria_label(SharedString::from(text))
        };

        let Some(room) = self.timeline.room().cloned() else {
            return base
                .child(message("timeline-placeholder", "Sélectionne un salon".to_owned(), p.text_secondary))
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
            .border_color(p.border)
            .text_color(p.text)
            .child(title.clone())
            .test_support()
            .aria_label(SharedString::from(title));

        match self.timeline.status().clone() {
            TimelineStatus::Idle | TimelineStatus::Loading => base
                .child(header)
                .child(message("timeline-loading", "Chargement des messages…".to_owned(), p.text_secondary))
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
                                .text_color(p.error)
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
                .child(message("timeline-empty", "Aucun message dans ce salon.".to_owned(), p.text_secondary))
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
                                let events = this.timeline.events();
                                let starts = starts_group(index.checked_sub(1).map(|j| &events[j]), event);
                                let presence = this.timeline.presence_of(&event.sender_id);
                                let avatar = event
                                    .sender_avatar
                                    .as_deref()
                                    .and_then(|mxc| this.images.get(&avatar_key(mxc)))
                                    .cloned();
                                let reactions = event
                                    .event_id
                                    .as_ref()
                                    .map(|id| this.timeline.reactions_of(id).to_vec())
                                    .unwrap_or_default();
                                let picker = (event.event_id.is_some() && this.reaction_picker == event.event_id).then(|| {
                                    PickerRender { recent: this.recent_emojis.clone(), focus: this.picker_focus.clone() }
                                });
                                Self::event_row(index, event, read, media, selected, RowHead { starts_group: starts, avatar, presence, reactions, picker }, cx)
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
                    .text_color(p.text_secondary)
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
        let p = Palette::of(cx);
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
                .bg(p.scrim)
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
                        .bg(p.panel)
                        .border_1()
                        .border_color(p.border)
                        .child(div().text_lg().text_color(p.text).child("Restaurer les clés"))
                        .child(div().text_sm().text_color(p.text_secondary).child(
                            "Saisis ta clé de récupération pour déchiffrer l'historique de tes salons. \
                             Elle n'est jamais enregistrée.",
                        ))
                        .child(Input::new(&self.key_input).id("recovery-key").bg(p.field))
                        .children(
                            error.map(|m| div().text_sm().text_color(p.error).child(m)),
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
        let p = Palette::of(cx);
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
            .border_color(p.border)
            .child(div().text_color(p.text).child("WaifuChat"))
            .child(div().text_xs().text_color(p.text_secondary).child(self.user_label.clone()))
            .children((self.keys == KeyStatus::Needed).then(|| {
                Button::new("recovery-open")
                    .primary()
                    .label("Restaurer les clés")
                    .on_click(cx.listener(|this, _, _, cx| this.open_recovery(cx)))
            }));

        let footer = div().p_2().border_t_1().border_color(p.border).child(
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
            .bg(p.panel)
            .border_r_1()
            .border_color(p.border)
            .child(header)
            .children(self.connection.banner().map(|text| {
                let offline = matches!(self.connection, ConnectionState::Offline(_));
                div()
                    .id("connection-banner")
                    .px_3()
                    .py_1()
                    .text_xs()
                    .text_color(if offline { p.error } else { p.text_secondary })
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
            .bg(p.background)
            .flex()
            .child(sidebar)
            .child(center)
            .children(self.recovery_modal(cx))
            .children(self.media_viewer(cx))
    }
}
