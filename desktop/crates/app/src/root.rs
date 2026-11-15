//! Racine de l'application : choisit l'écran (reprise, connexion, session ouverte) et câble
//! les actions utilisateur vers le [`Bridge`].

use domain::Session;
use gpui_kit::*;
use matrix::{Client, SyncUpdate};
use ui::{LoginEvent, LoginView, MainEvent, MainView, RoomsState};

use crate::bridge::{Bridge, SessionResult, SyncHandle};

const BACKGROUND: u32 = 0x0b0b12;
const TEXT_SECONDARY: u32 = 0x8888a8;

enum Screen {
    /// Reprise de session en cours.
    Restoring,
    SignedOut(Entity<LoginView>),
    SignedIn { client: Client, main: Entity<MainView>, _sync: SyncHandle },
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
                Ok(Some((client, session))) => this.enter_session(client, session, window, cx),
                Ok(None) => this.show_login(None, window, cx),
                Err(message) => this.show_login(Some(message), window, cx),
            })
            .ok();
        })
        .detach();
        this
    }

    /// Ouvre l'écran principal : démarre la synchronisation de fond et en écoute les instantanés.
    fn enter_session(
        &mut self,
        client: Client,
        session: Session,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let main = cx.new(|cx| MainView::new(session.user_id.to_string(), window, cx));

        cx.subscribe_in(&main, window, |this, main, event: &MainEvent, window, cx| match event {
            MainEvent::SignOut => this.sign_out(window, cx),
            MainEvent::SubmitRecoveryKey(handoff) => {
                let Screen::SignedIn { client, .. } = &this.screen else {
                    return;
                };
                let Some(key) = handoff.take() else {
                    return;
                };
                let receiver = this.bridge.recover(client.clone(), key);
                let main = main.downgrade();
                cx.spawn_in(window, async move |_, cx| {
                    let outcome =
                        receiver.await.unwrap_or_else(|_| Err("tâche interrompue".to_owned()));
                    main.update_in(cx, |main, window, cx| main.finish_recovery(outcome, window, cx))
                        .ok();
                })
                .detach();
            }
        })
        .detach();

        let (mut updates, sync) = self.bridge.start_sync(client.clone());
        let weak_main = main.downgrade();
        cx.spawn_in(window, async move |_, cx| {
            while let Some(update) = updates.recv().await {
                let alive = weak_main.update(cx, |main, cx| match update {
                    SyncUpdate::Snapshot { rooms, keys } => {
                        main.set_key_status(keys, cx);
                        main.set_rooms(RoomsState::Ready(rooms), cx);
                    }
                    SyncUpdate::Failed(message) => main.set_sync_failure(message, cx),
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();

        self.screen = Screen::SignedIn { client, main, _sync: sync };
        cx.notify();
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
                this.update_in(cx, |this, window, cx| match outcome {
                    Ok((client, session)) => this.enter_session(client, session, window, cx),
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
        // On quitte l'écran principal tout de suite : sa synchronisation est ainsi interrompue.
        let Screen::SignedIn { client, .. } = std::mem::replace(&mut self.screen, Screen::Restoring)
        else {
            return;
        };
        let receiver = self.bridge.logout(client);
        cx.spawn_in(window, async move |this, cx| {
            let outcome = receiver.await.unwrap_or_else(|_| Err("tâche interrompue".to_owned()));
            this.update_in(cx, |this, window, cx| {
                this.show_login(outcome.err(), window, cx);
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

impl Render for AppRoot {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
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
            Screen::SignedIn { main, .. } => {
                base.child(main.clone()).into_any_element()
            }
        }
    }
}
