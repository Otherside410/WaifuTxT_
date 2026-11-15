//! Écran de connexion : homeserver, identifiant, mot de passe.
//!
//! La vue ne fait aucun appel réseau : elle valide les champs (`domain::validate_login`), émet
//! [`LoginEvent::Submit`] et attend que l'appelant lui dise `set_busy` / `set_error`.

use domain::{validate_login, LoginRequest};
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::Disableable;
use gpui_kit::*;

/// Homeserver pré-rempli sur un écran neuf : **aucun**. Un domaine public codé en dur ferait partir identifiant
/// et mot de passe vers un serveur que l'utilisateur n'a pas choisi dès qu'il valide sans y penser.
pub const DEFAULT_HOMESERVER: &str = "";

/// Valeur initiale du champ homeserver : le dernier homeserver utilisé (lu dans le store local par l'appelant)
/// s'il existe et n'est pas vide, sinon [`DEFAULT_HOMESERVER`] (vide).
pub fn initial_homeserver(last_used: Option<&str>) -> String {
    last_used
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map_or_else(|| DEFAULT_HOMESERVER.to_owned(), str::to_owned)
}

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
    /// `last_homeserver` : dernier homeserver utilisé (store local), proposé à la place d'un champ vide.
    pub fn new(window: &mut Window, cx: &mut Context<Self>, last_homeserver: Option<&str>) -> Self {
        let homeserver =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://mon-homeserver.exemple"));
        let initial = initial_homeserver(last_homeserver);
        if !initial.is_empty() {
            homeserver.update(cx, |state, cx| state.set_value(initial, window, cx));
        }
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
                    .child(Input::new(&self.homeserver).id("login-homeserver"))
                    .child(label("Identifiant"))
                    .child(Input::new(&self.username).id("login-username"))
                    .child(label("Mot de passe"))
                    .child(Input::new(&self.password).id("login-password"))
                    .children(self.error.clone().map(|message| {
                        div().text_sm().text_color(rgb(ERROR)).child(message)
                    }))
                    .child(button),
            )
    }
}

#[cfg(test)]
mod tests {
    // Imports nominatifs : `use super::*` ramènerait le `test` de gpui_kit, qui masque `#[test]`.
    use super::{initial_homeserver, DEFAULT_HOMESERVER};

    /// Domaines publics qui ne doivent jamais redevenir un défaut du formulaire.
    const PUBLIC_HOMESERVERS: [&str; 4] = ["matrix.org", "matrix-client.matrix.org", "element.io", "tchncs.de"];

    #[test]
    fn there_is_no_default_homeserver() {
        assert!(DEFAULT_HOMESERVER.is_empty(), "un défaut public est réapparu : {DEFAULT_HOMESERVER:?}");
        for public in PUBLIC_HOMESERVERS {
            assert!(!DEFAULT_HOMESERVER.contains(public), "défaut public : {public}");
        }
    }

    #[test]
    fn an_empty_store_proposes_an_empty_field() {
        let initial = initial_homeserver(None);
        assert!(initial.is_empty(), "{initial:?}");
        for public in PUBLIC_HOMESERVERS {
            assert!(!initial.contains(public));
        }
        assert!(initial_homeserver(Some("")).is_empty());
        assert!(initial_homeserver(Some("   \n")).is_empty());
    }

    #[test]
    fn the_last_used_homeserver_is_proposed_as_is() {
        assert_eq!(initial_homeserver(Some("http://localhost:8008")), "http://localhost:8008");
        assert_eq!(initial_homeserver(Some("  http://localhost:8008\n")), "http://localhost:8008");
    }
}
