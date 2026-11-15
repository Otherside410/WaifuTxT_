//! Racine de l'application : choisit l'écran (reprise, connexion, session ouverte) et câble
//! les actions utilisateur vers le [`Bridge`].

use domain::Session;
use gpui_kit::component::button::Button;
use gpui_kit::*;
use matrix::Client;
use ui::{LoginEvent, LoginView};

use crate::bridge::{Bridge, SessionResult};

const BACKGROUND: u32 = 0x0b0b12;
const TEXT: u32 = 0xe8e8f0;
const TEXT_SECONDARY: u32 = 0x8888a8;

enum Screen {
    /// Reprise de session en cours.
    Restoring,
    SignedOut(Entity<LoginView>),
    SignedIn { session: Session, client: Client },
}

pub struct AppRoot {
    bridge: Bridge,
    screen: Screen,
}

impl AppRoot {
    pub fn new(bridge: Bridge, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let this = Self { bridge, screen: Screen::Restoring };
        let receiver = this.bridge.resume();
        cx.spawn_in(window, async move |this, cx| {
            let outcome = receiver.await.unwrap_or_else(|_| Err("tâche interrompue".to_owned()));
            this.update_in(cx, |this, window, cx| match outcome {
                Ok(Some((client, session))) => this.screen = Screen::SignedIn { session, client },
                Ok(None) => this.show_login(None, window, cx),
                Err(message) => this.show_login(Some(message), window, cx),
            })
            .ok();
        })
        .detach();
        this
    }

    fn show_login(&mut self, error: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let login = cx.new(|cx| LoginView::new(window, cx));
        if error.is_some() {
            login.update(cx, |view, cx| view.set_error(error, cx));
        }
        cx.subscribe_in(&login, window, |this, login, event: &LoginEvent, window, cx| {
            let LoginEvent::Submit(request) = event;
            let receiver = this.bridge.sign_in(request.clone());
            let login = login.clone();
            cx.spawn_in(window, async move |this, cx| {
                let outcome: SessionResult =
                    receiver.await.unwrap_or_else(|_| Err("tâche interrompue".to_owned()));
                this.update(cx, |this, cx| match outcome {
                    Ok((client, session)) => {
                        this.screen = Screen::SignedIn { session, client };
                        cx.notify();
                    }
                    Err(message) => login.update(cx, |view, cx| {
                        view.set_busy(false, cx);
                        view.set_error(Some(message), cx);
                    }),
                })
                .ok();
            })
            .detach();
        })
        .detach();
        self.screen = Screen::SignedOut(login);
        cx.notify();
    }

    fn sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Screen::SignedIn { client, .. } = &self.screen else {
            return;
        };
        let receiver = self.bridge.logout(client.clone());
        cx.spawn_in(window, async move |this, cx| {
            let outcome = receiver.await.unwrap_or_else(|_| Err("tâche interrompue".to_owned()));
            this.update_in(cx, |this, window, cx| {
                this.show_login(outcome.err(), window, cx);
            })
            .ok();
        })
        .detach();
    }
}

impl Render for AppRoot {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let base = div().size_full().bg(rgb(BACKGROUND));
        match &self.screen {
            Screen::Restoring => base
                .flex()
                .items_center()
                .justify_center()
                .text_color(rgb(TEXT_SECONDARY))
                .child("Chargement…")
                .into_any_element(),
            Screen::SignedOut(login) => base.child(login.clone()).into_any_element(),
            Screen::SignedIn { session, .. } => base
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap_3()
                .text_color(rgb(TEXT))
                .child(format!("Connecté : {}", session.user_id))
                .child(
                    Button::new("sign-out")
                        .label("Se déconnecter")
                        .on_click(cx.listener(|this, _, window, cx| this.sign_out(window, cx))),
                )
                .into_any_element(),
        }
    }
}
