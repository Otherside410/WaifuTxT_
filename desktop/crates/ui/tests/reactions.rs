//! Réactions : pastilles sous le message (table latérale), clic = commande `ToggleReaction`, bouton « Réagir » et
//! sélecteur rapide (ouverture, choix, fermeture, récents). Rendu headless, aucun réseau : l'arrivée d'une réaction
//! passe par le canal `TimelineUpdate::Reactions`, exactement comme le fait la tâche de timeline.

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::{open_main, rendered_rows, row_id};
use domain::{EventId, EventState, EventVm, ReactionVm, RoomId, TimelineUpdate};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, Entity, TestAppContext, Window, WindowHandle};
use gpui_kit::base::Root;
use ui::{EVENT_ROW_HEIGHT, MainEvent, MainView};

fn msg(tag: &str, own: bool, confirmed: bool, ts: u64) -> EventVm {
    EventVm {
        id: EventId::from(format!("${tag}").as_str()),
        sender_name: "Alice".into(),
        sender_initials: "A".into(),
        sender_avatar: None,
        sender_id: "@alice:x".into(),
        timestamp_ms: ts,
        time_label: "12:00".into(),
        body: format!("message {tag}"),
        state: if confirmed { EventState::Normal } else { EventState::Local },
        event_id: confirmed.then(|| EventId::from(format!("$real-{tag}").as_str())),
        is_own: own,
        edited: false,
        read_by: Vec::new(),
        media: None,
    }
}

fn reaction(key: &str, count: usize, mine: bool) -> ReactionVm {
    ReactionVm {
        key: key.into(),
        count,
        reacted_by_me: mine,
        senders: (0..count).map(|n| format!("membre{n}")).collect(),
    }
}

fn record(cx: &mut TestAppContext, view: &Entity<MainView>) -> Rc<RefCell<Vec<String>>> {
    let log = Rc::new(RefCell::new(Vec::new()));
    let sink = Rc::clone(&log);
    cx.update(|cx| {
        cx.subscribe(view, move |_, event: &MainEvent, _| sink.borrow_mut().push(format!("{event:?}"))).detach();
    });
    log
}

/// Salon ouvert avec trois messages : 0 d'Alice (confirmé), 1 le mien (confirmé), 2 un écho local.
fn open_room(cx: &mut TestAppContext) -> (WindowHandle<Root>, Entity<MainView>, RoomId) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    let t = 1_700_000_000_000u64;
    let events = vec![msg("a", false, true, t), msg("b", true, true, t + 1000), msg("c", true, false, t + 2000)];
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(ui::RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(TimelineUpdate::Events { room: room.clone(), events, at_start: Some(true) }, cx);
        });
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    (handle, view, room)
}

fn inject(cx: &mut TestAppContext, handle: WindowHandle<Root>, view: &Entity<MainView>, room: &RoomId, list: Vec<(&str, Vec<ReactionVm>)>) {
    let reactions = list.into_iter().map(|(id, r)| (EventId::from(id), r)).collect();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.apply_timeline(TimelineUpdate::Reactions { room: room.clone(), reactions }, cx));
        window.render_frame(cx);
    })
    .expect("fenêtre");
}

fn heights(window: &Window) -> Vec<f32> {
    rendered_rows(window).iter().map(|i| f32::from(window.find(row_id(*i)).bounds().size.height)).collect()
}

#[gpui_kit::test]
fn no_reaction_means_no_row_and_a_received_one_appears_without_reloading_the_timeline(cx: &mut TestAppContext) {
    let (handle, view, room) = open_room(cx);
    cx.update_window(handle.into(), |_, window, _| {
        assert_eq!(rendered_rows(window).len(), 3);
        assert!(window.try_find("reactions-0").is_none(), "aucune réaction : aucune rangée");
        assert!(window.try_find("reaction-0-👍").is_none());
    })
    .expect("fenêtre");

    inject(cx, handle, &view, &room, vec![("$real-a", vec![reaction("👍", 2, true), reaction("🎉", 1, false), reaction("❤️", 1, false)])]);
    cx.update_window(handle.into(), |_, window, _| {
        assert!(window.try_find("reactions-0").is_some());
        assert_eq!(window.find("reaction-0-👍").label(), Some("2 réactions 👍, dont la vôtre"));
        assert_eq!(window.find("reaction-0-🎉").label(), Some("1 réaction 🎉"));
        assert!(window.try_find("reaction-0-❤️").is_some());
        assert_eq!(rendered_rows(window).len(), 3, "la timeline n'a pas été rechargée : mêmes trois lignes");
        assert!(window.try_find("reactions-1").is_none(), "l'autre message n'a pas de rangée");
        assert!(heights(window).iter().all(|h| (h - EVENT_ROW_HEIGHT).abs() < 0.5), "lignes toujours à 48 px : {:?}", heights(window));
    })
    .expect("fenêtre");

    // Snapshot suivant sans réaction : la rangée disparaît.
    inject(cx, handle, &view, &room, vec![]);
    cx.update_window(handle.into(), |_, window, _| assert!(window.try_find("reactions-0").is_none())).expect("fenêtre");
}

#[gpui_kit::test]
fn the_chips_row_sits_below_the_header_inside_the_row_and_keeps_the_density(cx: &mut TestAppContext) {
    let (handle, view, room) = open_room(cx);
    inject(cx, handle, &view, &room, vec![("$real-a", vec![reaction("👍", 3, true), reaction("🎉", 1, false), reaction("❤️", 2, false)])]);
    cx.update_window(handle.into(), |_, window, _| {
        let row = window.find(row_id(0)).bounds();
        let header = window.find("event-header-0").bounds();
        let chips = window.find("reactions-0").bounds();
        let (mine, other) = (window.find("reaction-0-👍").bounds(), window.find("reaction-0-🎉").bounds());
        println!("[mesure] ligne {row:?}\n[mesure] en-tête {header:?}\n[mesure] rangée {chips:?}\n[mesure] pastille 👍 {mine:?} 🎉 {other:?}");
        assert!(chips.origin.y >= header.origin.y + header.size.height, "la rangée est sous l'en-tête");
        assert!(chips.origin.y + chips.size.height <= row.origin.y + row.size.height + gpui_kit::px(0.5), "elle tient dans la ligne de 48 px");
        assert!((f32::from(mine.size.height) - 18.0).abs() < 0.5 && (f32::from(other.size.height) - 18.0).abs() < 0.5);
        assert!(other.origin.x >= mine.origin.x + mine.size.width, "pastilles côte à côte, sans chevauchement");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn clicking_a_chip_asks_to_toggle_that_reaction_on_that_message(cx: &mut TestAppContext) {
    let (handle, view, room) = open_room(cx);
    let log = record(cx, &view);
    inject(cx, handle, &view, &room, vec![("$real-b", vec![reaction("👍", 1, true), reaction("🎉", 2, false)])]);
    cx.update_window(handle.into(), |_, window, cx| {
        window.click("reaction-1-🎉", cx);
        window.render_frame(cx);
    })
    .expect("fenêtre");
    let seen = log.borrow().clone();
    assert_eq!(seen.len(), 1, "une seule commande : {seen:?}");
    assert!(seen[0].contains("ToggleReaction") && seen[0].contains("$real-b") && seen[0].contains("🎉"), "{}", seen[0]);

    cx.update_window(handle.into(), |_, window, cx| {
        window.click("reaction-1-👍", cx);
    })
    .expect("fenêtre");
    assert!(log.borrow()[1].contains("👍"), "retirer la mienne = même commande, c'est le SDK qui décide : {}", log.borrow()[1]);
}

#[gpui_kit::test]
fn react_is_offered_on_any_confirmed_message_but_never_on_a_local_echo(cx: &mut TestAppContext) {
    let (handle, _view, _room) = open_room(cx);
    cx.update_window(handle.into(), |_, window, _| {
        assert!(window.try_find("react-0").is_some(), "message d'un autre : on peut réagir");
        assert!(window.try_find("react-1").is_some(), "mon message confirmé aussi");
        assert!(window.try_find("edit-0").is_none() && window.try_find("delete-0").is_none(), "modifier/supprimer restent les miens");
        assert!(window.try_find("edit-1").is_some());
        assert!(window.try_find("react-2").is_none(), "écho local (pas d'id d'événement) : pas de réaction");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn the_picker_opens_picks_closes_and_keeps_recents_most_recent_first(cx: &mut TestAppContext) {
    let (handle, view, _room) = open_room(cx);
    let log = record(cx, &view);
    cx.update_window(handle.into(), |_, window, cx| {
        assert!(window.try_find("reaction-picker").is_none(), "fermé au départ");
        window.click("react-0", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_some(), "ouvert par le bouton");
        assert!(window.try_find("picker-recent-0").is_none(), "aucun récent au début");
        let panel = window.find("reaction-picker").bounds();
        println!("[mesure] sélecteur {panel:?}");
        assert!((0..16).all(|n| window.try_find(format!("picker-emoji-{n}")).is_some()), "grille de 16 émojis");
        assert!(window.try_find("picker-emoji-16").is_none());

        // 🎉 (n°6) puis ❤️ (n°2) : le sélecteur se ferme à chaque choix.
        window.click("picker-emoji-6", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_none(), "fermé après le choix");
        window.click("react-0", cx);
        window.render_frame(cx);
        window.click("picker-emoji-2", cx);
        window.render_frame(cx);
        window.click("react-0", cx);
        window.render_frame(cx);
        assert_eq!(window.find("picker-recent-0").label(), Some("❤️"), "le plus récent en tête");
        assert_eq!(window.find("picker-recent-1").label(), Some("🎉"));
        assert!(window.try_find("picker-recent-2").is_none());
    })
    .expect("fenêtre");
    let seen = log.borrow().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    // `Debug` échappe le sélecteur de variation de ❤️ : on compare à sa forme `Debug`.
    assert!(seen[0].contains("$real-a") && seen[0].contains(&format!("{:?}", "🎉")), "{}", seen[0]);
    assert!(seen[1].contains("$real-a") && seen[1].contains(&format!("{:?}", "❤️")), "{}", seen[1]);
}

#[gpui_kit::test]
fn escape_and_an_outside_click_close_the_picker_without_reacting(cx: &mut TestAppContext) {
    let (handle, view, _room) = open_room(cx);
    let log = record(cx, &view);
    cx.update_window(handle.into(), |_, window, cx| {
        window.click("react-0", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_some());
        window.press("escape", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_none(), "Échap ferme");

        window.click("react-0", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_some());
        window.click("timeline-header", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_none(), "un clic extérieur ferme");

        // Second clic sur le bouton alors que le sélecteur est ouvert : il se ferme (bascule), il ne se rouvre pas.
        window.click("react-0", cx);
        window.render_frame(cx);
        window.click("react-0", cx);
        window.render_frame(cx);
        assert!(window.try_find("reaction-picker").is_none(), "le bouton rebascule");
    })
    .expect("fenêtre");
    assert!(log.borrow().is_empty(), "fermer ne réagit jamais : {:?}", log.borrow());
}

#[gpui_kit::test]
fn a_failed_reaction_shows_a_readable_error_and_retry_sends_the_same_command_again(cx: &mut TestAppContext) {
    let (handle, view, room) = open_room(cx);
    let log = record(cx, &view);
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::ReactionFailed {
                    room: room.clone(),
                    event_id: EventId::from("$real-a"),
                    key: "👍".into(),
                    message: "Réaction impossible : réseau".into(),
                },
                cx,
            )
        });
        window.render_frame(cx);
        assert_eq!(window.find("composer-error").label(), Some("Réaction impossible : réseau"));
        window.click("composer-retry", cx);
        window.render_frame(cx);
        assert!(window.try_find("composer-error").is_none(), "l'erreur disparaît au nouvel essai");
    })
    .expect("fenêtre");
    let seen = log.borrow().clone();
    assert_eq!(seen.len(), 1, "{seen:?}");
    assert!(seen[0].contains("$real-a") && seen[0].contains("👍"), "{}", seen[0]);
}
