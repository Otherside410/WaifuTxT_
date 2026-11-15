//! Racine de l'application : choisit l'écran (reprise, connexion, session ouverte) et câble
//! les actions utilisateur vers le [`Bridge`].

use domain::{Session, TimelineUpdate};
use gpui_kit::*;
use matrix::{Client, SyncUpdate, TimelineCommand};
use ui::{LoginEvent, LoginView, MainEvent, MainView, RoomsState};

use crate::bridge::{Bridge, SessionResult, SyncHandle, TimelineHandle};

const BACKGROUND: u32 = 0x0b0b12;
const TEXT_SECONDARY: u32 = 0x8888a8;

enum Screen {
    /// Reprise de session en cours.
    Restoring,
    SignedOut(Entity<LoginView>),
    SignedIn {
        client: Client,
        main: Entity<MainView>,
        _sync: SyncHandle,
        /// Timeline du salon sélectionné (une seule à la fois).
        timeline: Option<TimelineHandle>,
    },
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
            MainEvent::SelectRoom(room) => this.open_timeline(main, room.clone(), window, cx),
            MainEvent::SendText { room, body } => {
                let queued = match &this.screen {
                    Screen::SignedIn { timeline: Some(timeline), .. } => {
                        timeline.send_text(body.clone())
                    }
                    _ => false,
                };
                if !queued {
                    // Pas de timeline active : on rend le brouillon à l'utilisateur au lieu de le perdre.
                    let update = TimelineUpdate::SendFailed {
                        room: room.clone(),
                        text: body.clone(),
                        message: "Envoi impossible : la conversation n'est pas prête.".to_owned(),
                    };
                    main.update(cx, |main, cx| main.apply_timeline(update, cx));
                }
            }
            MainEvent::EditText { room, event_id, body } => {
                let queued = this.with_timeline(|t| {
                    t.command(TimelineCommand::Edit {
                        event_id: event_id.to_string(),
                        body: body.clone(),
                    })
                });
                if queued != Some(true) {
                    let update = TimelineUpdate::EditFailed {
                        room: room.clone(),
                        event_id: event_id.clone(),
                        text: body.clone(),
                        message: "Modification impossible : la conversation n'est pas prête.".to_owned(),
                    };
                    main.update(cx, |main, cx| main.apply_timeline(update, cx));
                }
            }
            MainEvent::Redact { room, event_id } => {
                let queued = this.with_timeline(|t| {
                    t.command(TimelineCommand::Redact { event_id: event_id.to_string() })
                });
                if queued != Some(true) {
                    let update = TimelineUpdate::DeleteFailed {
                        room: room.clone(),
                        event_id: event_id.clone(),
                        message: "Suppression impossible : la conversation n'est pas prête.".to_owned(),
                    };
                    main.update(cx, |main, cx| main.apply_timeline(update, cx));
                }
            }
            MainEvent::SendAttachment { room, path } => {
                let queued = this.with_timeline(|t| {
                    t.command(TimelineCommand::SendAttachment(std::path::PathBuf::from(path)))
                });
                if queued != Some(true) {
                    let update = TimelineUpdate::AttachmentFailed {
                        room: room.clone(),
                        path: path.clone(),
                        message: "Envoi impossible : la conversation n'est pas prête.".to_owned(),
                    };
                    main.update(cx, |main, cx| main.apply_timeline(update, cx));
                }
            }
            MainEvent::MarkRead(_) => {
                this.with_timeline(|t| t.command(TimelineCommand::MarkRead));
            }
            MainEvent::Typing { typing, .. } => {
                this.with_timeline(|t| t.command(TimelineCommand::Typing(*typing)));
            }
            MainEvent::LoadOlder(_) => {
                if let Screen::SignedIn { timeline: Some(timeline), .. } = &this.screen {
                    timeline.load_older();
                }
            }
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

        self.screen = Screen::SignedIn { client, main, _sync: sync, timeline: None };
        cx.notify();
    }

    /// Ouvre la timeline de `room` ; l'ancienne tâche est abandonnée (sa dernière réponse, si elle
    /// arrive quand même, est de toute façon ignorée par le domaine : mauvais salon).
    fn open_timeline(
        &mut self,
        main: &Entity<MainView>,
        room: domain::RoomId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Screen::SignedIn { client, timeline, .. } = &mut self.screen else {
            return;
        };
        let (mut updates, handle) = self.bridge.open_timeline(client.clone(), room);
        *timeline = Some(handle);
        let weak_main = main.downgrade();
        cx.spawn_in(window, async move |_, cx| {
            while let Some(update) = updates.recv().await {
                let alive = weak_main.update(cx, |main, cx| main.apply_timeline(update, cx));
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Applique `f` à la timeline active, s'il y en a une.
    fn with_timeline<R>(&self, f: impl FnOnce(&TimelineHandle) -> R) -> Option<R> {
        match &self.screen {
            Screen::SignedIn { timeline: Some(timeline), .. } => Some(f(timeline)),
            _ => None,
        }
    }

    fn show_login(&mut self, error: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let last_homeserver = self.bridge.last_homeserver();
        let login = cx.new(|cx| LoginView::new(window, cx, last_homeserver.as_deref()));
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
