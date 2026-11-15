//! Vue principale après connexion : barre latérale des salons, zone centrale (sans timeline avant
//! l'étape 5) et modal de clé de récupération. Aucun appel réseau : tout arrive par `set_*`.

use std::cell::RefCell;
use std::fmt;

use domain::{
    validate_recovery_key, EventState, EventVm, KeyStatus, RecoveryKey, RoomId, RoomKind, RoomVm,
    TimelineState, TimelineStatus, TimelineUpdate,
};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Disableable;
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
/// On demande une page plus ancienne quand la vue est à moins de N lignes du haut de la liste.
const PAGINATE_THRESHOLD_ROWS: f32 = 5.0;
/// Sous ce nombre de lignes chargées, la liste ne remplit peut-être pas la fenêtre : on pagine d'office.
const FILL_ROWS: usize = 20;
/// Hauteur réservée au bandeau « chargement… / début de la conversation » (constante, voir plus bas).
const BANNER_HEIGHT: f32 = 24.0;

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
}

pub struct MainView {
    user_label: String,
    rooms: RoomsState,
    timeline: TimelineState,
    scroll: UniformListScrollHandle,
    keys: KeyStatus,
    modal: ModalState,
    key_input: Entity<InputState>,
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
        Self {
            user_label,
            rooms: RoomsState::Syncing,
            timeline: TimelineState::default(),
            scroll: UniformListScrollHandle::new(),
            keys: KeyStatus::Unknown,
            modal: ModalState::default(),
            key_input,
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
        cx.notify();
    }

    /// Échec de synchronisation : n'écrase pas une liste déjà affichée (on garde la dernière bonne).
    pub fn set_sync_failure(&mut self, message: String, cx: &mut Context<Self>) {
        if self.rooms == RoomsState::Syncing {
            self.rooms = RoomsState::Failed(message);
            cx.notify();
        }
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
        cx.notify();
    }

    /// Applique un message de la tâche de timeline. Une réponse d'un autre salon que celui
    /// sélectionné est ignorée ; la position de lecture est ancrée (voir ci-dessous).
    pub fn apply_timeline(&mut self, update: TimelineUpdate, cx: &mut Context<Self>) {
        let was_empty = self.timeline.events().is_empty();
        let at_bottom = self.scroll.is_scrolled_to_end() != Some(false);
        let applied = self.timeline.apply(update);
        if applied.ignored {
            return;
        }
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
        cx.notify();
    }

    /// Après un défilement : proche du haut de la liste ? Alors une page plus ancienne est demandée.
    fn maybe_request_older(&mut self, cx: &mut Context<Self>) {
        let offset = self.scroll.0.borrow().base_handle.offset();
        if offset.y > px(-PAGINATE_THRESHOLD_ROWS * EVENT_ROW_HEIGHT) {
            self.request_older(cx);
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
                    .px_2()
                    .rounded_full()
                    .bg(rgb(ACCENT))
                    .text_xs()
                    .text_color(rgb(TEXT))
                    .child(badge_text)
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

    fn event_row(index: usize, event: &EventVm) -> impl IntoElement {
        let undecryptable = event.state == EventState::Indechiffrable;
        let dim = event.state == EventState::Local;
        div()
            .id(SharedString::from(format!("event-{index}")))
            .h(px(EVENT_ROW_HEIGHT))
            .px_3()
            .flex()
            .items_center()
            .gap_3()
            .opacity(if dim { 0.6 } else { 1.0 })
            .child(
                div()
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
                                    .child(event.time_label.clone()),
                            ),
                    )
                    .child(
                        div()
                            .w_full()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_sm()
                            .text_color(rgb(if undecryptable { ERROR } else { TEXT_SECONDARY }))
                            .child(event.body.clone()),
                    ),
            )
            .test_support()
            .aria_label(SharedString::from(format!("{} : {}", event.sender_name, event.body)))
    }

    fn timeline_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let base = div().flex_1().h_full().flex().flex_col().min_w_0();
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
                    cx.processor(|this, range: std::ops::Range<usize>, _window, _cx| {
                        let end = range.end.min(this.timeline.events().len());
                        let start = range.start.min(end);
                        this.timeline.events()[start..end]
                            .iter()
                            .enumerate()
                            .map(|(offset, event)| Self::event_row(start + offset, event))
                            .collect::<Vec<_>>()
                    }),
                )
                .track_scroll(&self.scroll)
                .size_full();

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
                            .on_scroll(cx.listener(|this, _, _, cx| this.maybe_request_older(cx)))
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .child(div().id("rooms-scroll").flex_1().overflow_y_scroll().child(self.sidebar_body(cx)))
            .child(footer)
            .test_support()
            .aria_label("Salons");

        let center = self.timeline_panel(cx);

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
