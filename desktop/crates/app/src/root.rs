//! Racine de l'application : choisit l'écran (reprise, connexion, session ouverte) et câble
//! les actions utilisateur vers le [`Bridge`].

use domain::{KeyStatus, RoomId, RoomKind, RoomVm, Session};
use gpui_kit::*;
use matrix::{Client, SyncUpdate};
use ui::{LoginEvent, LoginView, MainEvent, MainView, RoomsState};

use crate::bridge::{Bridge, SessionResult, SyncHandle};

const BACKGROUND: u32 = 0x0b0b12;
const TEXT_SECONDARY: u32 = 0x8888a8;

/// Aperçu sans compte (build debug seulement, variable `WAIFU_PREVIEW`) : sert à vérifier l'écran
/// principal quand aucun identifiant n'est disponible. Aucune donnée réelle, aucun réseau.
#[derive(Clone, Copy)]
pub enum Preview {
    /// Écran principal, liste en « Synchronisation… ».
    Syncing,
    /// Idem + modal de clé de récupération ouvert.
    Recovery,
    /// Liste de salons fictifs, un salon sélectionné.
    Rooms,
}

impl Preview {
    pub fn from_env() -> Option<Self> {
        if !cfg!(debug_assertions) {
            return None;
        }
        match std::env::var("WAIFU_PREVIEW").ok()?.as_str() {
            "syncing" => Some(Self::Syncing),
            "recovery" => Some(Self::Recovery),
            "rooms" => Some(Self::Rooms),
            _ => None,
        }
    }
}

fn demo_rooms() -> Vec<RoomVm> {
    let room = |id: &str, name: &str, kind, unread| RoomVm::new(RoomId::from(id), name, kind, unread);
    vec![
        room("!demo-s1:demo", "Démo Serveur", RoomKind::Space, 0),
        room("!demo-r1:demo", "général", RoomKind::Room, 3),
        room("!demo-r2:demo", "musique", RoomKind::Room, 0),
        room("!demo-r3:demo", "annonces importantes", RoomKind::Room, 120),
        room("!demo-d1:demo", "Alice Demo", RoomKind::Dm, 1),
    ]
}

enum Screen {
    /// Reprise de session en cours.
    Restoring,
    SignedOut(Entity<LoginView>),
    SignedIn { client: Client, main: Entity<MainView>, _sync: SyncHandle },
    /// Aperçu sans client (voir [`Preview`]).
    Preview(Entity<MainView>),
}

pub struct AppRoot {
    bridge: Bridge,
    screen: Screen,
}

impl AppRoot {
    pub fn new(
        bridge: Bridge,
        preview: Option<Preview>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let this = Self { bridge, screen: Screen::Restoring };
        if let Some(preview) = preview {
            return Self { screen: Self::preview_screen(preview, window, cx), ..this };
        }
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

    fn preview_screen(preview: Preview, window: &mut Window, cx: &mut Context<Self>) -> Screen {
        let main = cx.new(|cx| MainView::new("@demo:aperçu (aperçu)".to_owned(), window, cx));
        main.update(cx, |view, cx| match preview {
            Preview::Syncing => {}
            Preview::Recovery => {
                view.set_key_status(KeyStatus::Needed, cx);
                view.open_recovery(cx);
            }
            Preview::Rooms => {
                view.set_key_status(KeyStatus::Needed, cx);
                view.set_rooms(RoomsState::Ready(demo_rooms()), cx);
                view.select(RoomId::from("!demo-r1:demo"), cx);
            }
        });
        Screen::Preview(main)
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
            Screen::SignedIn { main, .. } | Screen::Preview(main) => {
                base.child(main.clone()).into_any_element()
            }
        }
    }
}
