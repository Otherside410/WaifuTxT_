//! Rendu headless de l'étape 6 : modifier, supprimer (avec confirmation), accusés de lecture,
//! indicateur de frappe. Réutilise `tests/common/`.

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::{close_modal_and_open, open_main, rendered_rows, row_id};
use domain::{EventId, EventState, EventVm, RoomId, TimelineUpdate};
use gpui_kit::test::{TestQueryExt, TestWindowExt};
use gpui_kit::{AppContext, TestAppContext, Window};
use ui::{MainEvent, RoomsState};

/// Ligne du dernier message de démonstration (n°199, le mien) dans la page initiale de 50.
const LAST_ROW: usize = 49;
const DEMO_ROOM: &str = "!demo-room:demo";

fn field_value(window: &Window) -> String {
    window.find_by_label("Message").value().unwrap_or_default().to_owned()
}

fn row_label(window: &Window, index: usize) -> String {
    window.find(row_id(index)).label().unwrap_or_default().to_owned()
}

#[gpui_kit::test]
fn the_edit_action_prefills_the_composer_and_applies_the_edit_in_place(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");

    let mut rows_before = 0;
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        rows_before = rendered_rows(window).len();
        // Seuls mes messages confirmés ont des actions : la ligne n°199 (la mienne), pas la 198 (Alice).
        assert!(window.try_find("edit-49").is_some());
        assert!(window.try_find("edit-48").is_none(), "pas mon message : pas d'action");

        window.click("edit-49", cx);
        window.render_frame(cx);
        assert_eq!(field_value(window), "Message de démonstration n°199", "saisie pré-remplie");
        assert!(window.try_find("edit-banner").is_some(), "mode modification signalé");

        window.press("ctrl-a", cx);
        window.input("texte corrigé", cx);
        window.press("enter", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();

    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let label = row_label(window, LAST_ROW);
        assert!(label.contains("texte corrigé"), "texte édité affiché : {label}");
        assert!(label.contains("[modifié]"), "mention « modifié » : {label}");
        assert_eq!(rendered_rows(window).len(), rows_before, "aucune nouvelle ligne");
        assert!(window.try_find("event-50").is_none());
        assert!(window.try_find("edit-banner").is_none(), "mode modification terminé");
        assert_eq!(field_value(window), "");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn cancelling_an_edit_restores_nothing_and_leaves_the_message_untouched(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("edit-49", cx);
        window.render_frame(cx);
        window.click("edit-cancel", cx);
        window.render_frame(cx);
        assert!(window.try_find("edit-banner").is_none());
        assert_eq!(field_value(window), "");
        assert!(row_label(window, LAST_ROW).contains("n°199"));
        assert!(!row_label(window, LAST_ROW).contains("[modifié]"));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn deleting_requires_a_confirmation_then_leaves_a_placeholder_row(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");

    let mut rows_before = 0;
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        rows_before = rendered_rows(window).len();
        window.click("delete-49", cx);
        window.render_frame(cx);
        // Rien n'est supprimé tant que ce n'est pas confirmé.
        assert!(window.try_find("delete-confirm-bar").is_some(), "confirmation demandée");
        assert!(row_label(window, LAST_ROW).contains("n°199"), "message encore intact");

        window.click("delete-cancel", cx);
        window.render_frame(cx);
        assert!(window.try_find("delete-confirm-bar").is_none());
        assert!(row_label(window, LAST_ROW).contains("n°199"), "annulé : message intact");

        window.click("delete-49", cx);
        window.render_frame(cx);
        window.click("delete-confirm", cx);
        window.render_frame(cx);
        assert!(window.try_find("delete-confirm-bar").is_none());

        let label = row_label(window, LAST_ROW);
        assert!(label.contains("Message supprimé"), "espace réservé : {label}");
        assert!(!label.contains("n°199"));
        assert_eq!(rendered_rows(window).len(), rows_before, "la ligne reste (pas de trou)");
        let height = f32::from(window.find(row_id(LAST_ROW)).bounds().size.height);
        assert!((height - ui::EVENT_ROW_HEIGHT).abs() < 0.5, "hauteur constante : {height}");
        assert!(window.try_find("edit-49").is_none(), "plus d'action sur un message supprimé");
        assert!(window.try_find("delete-49").is_none());
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_failed_edit_restores_the_text_in_edit_mode_and_can_be_retried(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::EditFailed {
                    room: RoomId::from(DEMO_ROOM),
                    event_id: EventId::from("$demo-ev-0199"),
                    text: "ma nouvelle version".into(),
                    message: "Modification impossible : réseau coupé".into(),
                },
                cx,
            );
        });
        window.render_frame(cx);
        window.render_frame(cx);
        assert_eq!(
            window.find("composer-error").label(),
            Some("Modification impossible : réseau coupé")
        );
        assert_eq!(field_value(window), "ma nouvelle version", "saisie restituée");
        assert!(window.try_find("edit-banner").is_some(), "retour en mode modification");

        window.click("composer-retry", cx);
        window.render_frame(cx);
        assert!(window.try_find("composer-error").is_none());
        assert!(row_label(window, LAST_ROW).contains("ma nouvelle version"));
        assert!(row_label(window, LAST_ROW).contains("[modifié]"));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn reading_the_bottom_marks_the_room_read_and_shows_who_read_the_last_message(
    cx: &mut TestAppContext,
) {
    let (handle, _view) = open_main(cx, true);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("unread-1").is_some(), "« général » a 3 messages non lus");
    })
    .expect("fenêtre");

    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("unread-1").is_none(), "ouvert en bas : non-lus remis à zéro");
        assert!(window.try_find("unread-2").is_some(), "l'autre salon garde ses non-lus");

        // Le dernier message lu par d'autres porte « vu par … » ; aucun autre.
        assert!(row_label(window, LAST_ROW).contains("[vu par alice, bob]"));
        let with_marker = rendered_rows(window)
            .iter()
            .filter(|i| row_label(window, **i).contains("[vu par"))
            .count();
        assert_eq!(with_marker, 1);
    })
    .expect("fenêtre");
}

/// `MainEvent` reçus par un abonné, en texte (le contenu des événements n'est pas comparé finement).
fn record_events(
    cx: &mut TestAppContext,
    view: &gpui_kit::Entity<ui::MainView>,
) -> Rc<RefCell<Vec<String>>> {
    let log = Rc::new(RefCell::new(Vec::new()));
    let sink = Rc::clone(&log);
    cx.update(|cx| {
        cx.subscribe(view, move |_, event: &MainEvent, _| sink.borrow_mut().push(format!("{event:?}")))
            .detach();
    });
    log
}

fn confirmed_message(tag: &str, ts: u64) -> EventVm {
    EventVm {
        id: EventId::from(format!("${tag}").as_str()),
        sender_name: "Alice".into(),
        sender_initials: "A".into(),
        sender_avatar: None,
        timestamp_ms: ts,
        time_label: "12:00".into(),
        body: format!("message {tag}"),
        state: EventState::Normal,
        event_id: Some(EventId::from(format!("$real-{tag}").as_str())),
        is_own: false,
        edited: false,
        read_by: Vec::new(),
        media: None,
    }
}

#[gpui_kit::test]
fn typing_emits_one_notice_per_window_and_stops_when_the_field_is_cleared(
    cx: &mut TestAppContext,
) {
    let (handle, view) = open_main(cx, false);
    let log = record_events(cx, &view);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: room.clone(),
                    events: vec![confirmed_message("a", 1)],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();

    cx.update_window(handle.into(), |_, window, cx| {
        window.click("composer", cx);
        for key in ["b", "o", "n", "j", "o", "u", "r"] {
            window.input(key, cx);
        }
    })
    .expect("fenêtre");
    cx.run_until_parked();

    let count = |needle: &str| log.borrow().iter().filter(|e| e.contains(needle)).count();
    assert_eq!(count("typing: true"), 1, "sept frappes, une seule notice : {:?}", log.borrow());
    assert_eq!(count("typing: false"), 0);

    // Champ vidé : on annonce qu'on a cessé d'écrire, une seule fois.
    cx.update_window(handle.into(), |_, window, cx| {
        window.press("ctrl-a", cx);
        window.press("backspace", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert_eq!(count("typing: false"), 1, "{:?}", log.borrow());
    assert_eq!(count("typing: true"), 1);
}

#[gpui_kit::test]
fn typing_stops_by_itself_after_the_idle_delay(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let log = record_events(cx, &view);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: room.clone(),
                    events: vec![confirmed_message("a", 1)],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.click("composer", cx);
        window.input("salut", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.executor().advance_clock(std::time::Duration::from_millis(domain::TYPING_IDLE_MS + 100));
    cx.run_until_parked();
    let log = log.borrow();
    assert_eq!(log.iter().filter(|e| e.contains("typing: true")).count(), 1, "{log:?}");
    assert_eq!(log.iter().filter(|e| e.contains("typing: false")).count(), 1, "{log:?}");
}

#[gpui_kit::test]
fn the_typing_indicator_names_who_is_writing(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("typing-indicator").label(), Some(""), "personne n'écrit");

        let typing = |users: Vec<&str>| TimelineUpdate::Typing {
            room: RoomId::from(DEMO_ROOM),
            users: users.into_iter().map(str::to_owned).collect(),
        };
        view.update(cx, |view, cx| view.apply_timeline(typing(vec!["Alice"]), cx));
        window.render_frame(cx);
        assert_eq!(window.find("typing-indicator").label(), Some("Alice écrit…"));

        view.update(cx, |view, cx| view.apply_timeline(typing(vec!["Alice", "Bob"]), cx));
        window.render_frame(cx);
        assert_eq!(window.find("typing-indicator").label(), Some("Alice et Bob écrivent…"));

        view.update(cx, |view, cx| view.apply_timeline(typing(vec![]), cx));
        window.render_frame(cx);
        assert_eq!(window.find("typing-indicator").label(), Some(""));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_read_receipt_command_is_emitted_once_per_new_last_message(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let log = record_events(cx, &view);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        let events = |tag: &str, ts| TimelineUpdate::Events {
            room: room.clone(),
            events: vec![confirmed_message(tag, ts)],
            at_start: Some(true),
        };
        view.update(cx, |view, cx| view.apply_timeline(events("a", 1), cx));
        window.render_frame(cx);
        // Un instantané identique ne redemande pas d'accusé.
        view.update(cx, |view, cx| view.apply_timeline(events("a", 1), cx));
        window.render_frame(cx);
        view.update(cx, |view, cx| view.apply_timeline(events("b", 2), cx));
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    let marks = log.borrow().iter().filter(|e| e.contains("MarkRead")).count();
    assert_eq!(marks, 2, "un accusé par dernier message distinct : {:?}", log.borrow());
}

#[gpui_kit::test]
fn a_stale_unread_count_from_a_sync_never_overwrites_the_local_zero_of_the_open_room(
    cx: &mut TestAppContext,
) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    // Salon « général » : 3 non-lus ; le DM garde son propre compteur.
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(ui::demo::demo_rooms()), cx));
        window.render_frame(cx);
        assert!(window.try_find("unread-1").is_some());
        window.click("room-1", cx);
        window.render_frame(cx);
        // Un message arrive dans le salon ouvert, lu en bas : accusé + remise à zéro.
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: room.clone(),
                    events: vec![confirmed_message("recu", 1)],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
        assert!(window.try_find("unread-1").is_none(), "pastille à 0 dès l'arrivée du message");

        // La synchronisation suivante republie l'ANCIEN compteur (3) : il ne doit pas écraser le 0 local.
        for _ in 0..3 {
            view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(ui::demo::demo_rooms()), cx));
            window.render_frame(cx);
            assert!(window.try_find("unread-1").is_none(), "compteur périmé réaffiché");
        }
        // Les autres salons gardent leur compteur.
        assert!(window.try_find("unread-2").is_some());

        // Un message plus récent arrive : l'accusé est redemandé, la pastille reste à 0.
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: room.clone(),
                    events: vec![confirmed_message("recent", 2)],
                    at_start: None,
                },
                cx,
            );
            view.set_rooms(RoomsState::Ready(ui::demo::demo_rooms()), cx);
        });
        window.render_frame(cx);
        assert!(window.try_find("unread-1").is_none());
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn emptying_the_composer_sends_exactly_one_typing_stop_per_transition(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let log = record_events(cx, &view);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: room.clone(),
                    events: vec![confirmed_message("a", 1)],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();

    let count = |needle: &str| log.borrow().iter().filter(|e| e.contains(needle)).count();
    cx.update_window(handle.into(), |_, window, cx| {
        window.click("composer", cx);
        window.input("bonjour", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert_eq!((count("typing: true"), count("typing: false")), (1, 0));

    // Non vide → vide : un seul arrêt.
    cx.update_window(handle.into(), |_, window, cx| {
        window.press("ctrl-a", cx);
        window.press("backspace", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert_eq!((count("typing: true"), count("typing: false")), (1, 1), "{:?}", log.borrow());

    // Déjà vide : d'autres touches sur un champ vide n'ajoutent aucun arrêt.
    cx.update_window(handle.into(), |_, window, cx| {
        window.press("backspace", cx);
        window.press("ctrl-a", cx);
        window.press("backspace", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert_eq!(count("typing: false"), 1, "arrêt répété sur un champ vide : {:?}", log.borrow());

    // Nouvelle transition vide → non vide → vide : une notice et un arrêt de plus.
    cx.update_window(handle.into(), |_, window, cx| {
        window.input("x", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.press("backspace", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert_eq!((count("typing: true"), count("typing: false")), (2, 2), "{:?}", log.borrow());
}
