//! Écran de connexion : homeserver, identifiant, mot de passe.
//!
//! La vue ne fait aucun appel réseau : elle valide les champs (`domain::validate_login`), émet
//! [`LoginEvent::Submit`] et attend que l'appelant lui dise `set_busy` / `set_error`.

use domain::{validate_login, LoginRequest};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Disableable;
use gpui_kit::*;

/// Homeserver pré-rempli (même défaut que l'app web).
const DEFAULT_HOMESERVER: &str = "matrix.org";

const BACKGROUND: u32 = 0x0b0b12;
const TEXT: u32 = 0xe8e8f0;
const TEXT_SECONDARY: u32 = 0x8888a8;
const ERROR: u32 = 0xff5c7a;

/// Événement émis par [`LoginView`].
pub enum LoginEvent {
    /// Formulaire valide : l'appelant doit lancer la connexion.
    Submit(LoginRequest),
}

pub struct LoginView {
    homeserver: Entity<InputState>,
    username: Entity<InputState>,
    password: Entity<InputState>,
    busy: bool,
    error: Option<SharedString>,
}

impl EventEmitter<LoginEvent> for LoginView {}

impl LoginView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let homeserver = cx.new(|cx| InputState::new(window, cx).placeholder("matrix.org"));
        homeserver.update(cx, |state, cx| state.set_value(DEFAULT_HOMESERVER, window, cx));
        let username = cx.new(|cx| InputState::new(window, cx).placeholder("Identifiant"));
        let password =
            cx.new(|cx| InputState::new(window, cx).placeholder("Mot de passe").masked(true));

        for input in [&homeserver, &username, &password] {
            cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            })
            .detach();
        }

        Self { homeserver, username, password, busy: false, error: None }
    }

    /// Affiche « connexion en cours » : désactive le bouton et les champs.
    pub fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        self.busy = busy;
        for input in [&self.homeserver, &self.username, &self.password] {
            input.update(cx, |state, cx| state.set_disabled(busy, cx));
        }
        cx.notify();
    }

    /// Affiche (ou efface) le message d'erreur.
    pub fn set_error(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.error = error.map(SharedString::from);
        cx.notify();
    }

    fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let homeserver = self.homeserver.read(cx).value();
        let username = self.username.read(cx).value();
        let password = self.password.read(cx).value();
        match validate_login(&homeserver, &username, &password) {
            Ok(request) => {
                self.error = None;
                self.set_busy(true, cx);
                cx.emit(LoginEvent::Submit(request));
            }
            Err(err) => self.set_error(Some(err.to_string()), cx),
        }
    }
}

impl Render for LoginView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let label = |text: &'static str| div().text_sm().text_color(rgb(TEXT_SECONDARY)).child(text);

        let button = Button::new("login-submit")
            .primary()
            .label(if self.busy { "Connexion en cours…" } else { "Se connecter" })
            .loading(self.busy)
            .disabled(self.busy)
            .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)));

        div()
            .size_full()
            .bg(rgb(BACKGROUND))
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .w(px(360.0))
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(div().text_xl().text_color(rgb(TEXT)).child("WaifuChat"))
                    .child(label("Homeserver"))
                    .child(Input::new(&self.homeserver))
                    .child(label("Identifiant"))
                    .child(Input::new(&self.username))
                    .child(label("Mot de passe"))
                    .child(Input::new(&self.password))
                    .children(self.error.clone().map(|message| {
                        div().text_sm().text_color(rgb(ERROR)).child(message)
                    }))
                    .child(button),
            )
    }
}
