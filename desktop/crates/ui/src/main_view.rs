//! Vue principale après connexion : barre latérale des salons, zone centrale (sans timeline avant
//! l'étape 5) et modal de clé de récupération. Aucun appel réseau : tout arrive par `set_*`.

use std::cell::RefCell;
use std::fmt;

use domain::{validate_recovery_key, KeyStatus, RecoveryKey, RoomId, RoomKind, RoomVm};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Disableable;
use gpui_kit::*;

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
}

pub struct MainView {
    user_label: String,
    rooms: RoomsState,
    selected: Option<RoomId>,
    keys: KeyStatus,
    modal: ModalState,
    key_input: Entity<InputState>,
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
            selected: None,
            keys: KeyStatus::Unknown,
            modal: ModalState::default(),
            key_input,
        }
    }

    pub fn set_rooms(&mut self, rooms: RoomsState, cx: &mut Context<Self>) {
        // Une sélection dont le salon a disparu est abandonnée.
        if let (Some(selected), RoomsState::Ready(list)) = (&self.selected, &rooms) {
            if !list.iter().any(|r| &r.id == selected) {
                self.selected = None;
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

    pub fn selected(&self) -> Option<&RoomId> {
        self.selected.as_ref()
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
            Ok(key) => {
                self.modal.start();
                self.key_input.update(cx, |state, cx| state.set_disabled(true, cx));
                cx.emit(MainEvent::SubmitRecoveryKey(KeyHandoff::new(key)));
            }
            Err(err) => self.modal.fail(err.to_string()),
        }
        cx.notify();
    }

    /// Sélectionne un salon (clic dans la barre latérale ou aperçu).
    pub fn select(&mut self, id: RoomId, cx: &mut Context<Self>) {
        self.selected = Some(id);
        cx.notify();
    }

    fn room_row(&self, index: usize, room: &RoomVm, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.selected.as_ref() == Some(&room.id);
        let id = room.id.clone();
        let badge_text = if room.unread > 99 { "99+".to_owned() } else { room.unread.to_string() };

        div()
            .id(("room", index))
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
    }

    fn section_title(label: &'static str) -> impl IntoElement {
        div().px_2().pt_3().pb_1().text_xs().text_color(rgb(TEXT_SECONDARY)).child(label)
    }

    fn sidebar_body(&self, cx: &mut Context<Self>) -> AnyElement {
        match &self.rooms {
            RoomsState::Syncing => div()
                .p_3()
                .text_sm()
                .text_color(rgb(TEXT_SECONDARY))
                .child("Synchronisation…")
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

    fn recovery_modal(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let ModalState::Open { busy, error } = &self.modal else {
            return None;
        };
        let busy = *busy;
        let error = error.clone();
        Some(
            div()
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
                        .child(Input::new(&self.key_input))
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
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(PANEL))
            .border_r_1()
            .border_color(rgb(BORDER))
            .child(header)
            .child(div().id("rooms-scroll").flex_1().overflow_y_scroll().child(self.sidebar_body(cx)))
            .child(footer);

        let selected_name = match (&self.selected, &self.rooms) {
            (Some(id), RoomsState::Ready(rooms)) => {
                rooms.iter().find(|r| &r.id == id).map(|r| r.name.clone())
            }
            _ => None,
        };
        let center = div()
            .flex_1()
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .text_color(rgb(TEXT_SECONDARY))
            .child(match selected_name {
                Some(name) => format!("{name} — la timeline arrive à l'étape 5"),
                None => "Sélectionne un salon".to_owned(),
            });

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
