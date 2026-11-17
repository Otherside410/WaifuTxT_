//! Pastille de présence : un élément `presence-{index}` pour un état connu, aucun sinon ; mise à jour ciblée ;
//! l'avatar (32 px) et la ligne (48 px) ne changent pas de taille.

mod common;

use common::{open_main, rendered_rows, row_id};
use domain::{EventId, EventState, EventVm, Presence, TimelineUpdate};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, TestAppContext};
use ui::EVENT_ROW_HEIGHT;

fn msg(tag: &str, sender: &str, id: &str, ts: u64) -> EventVm {
    EventVm {
        id: EventId::from(format!("${tag}").as_str()),
        sender_name: sender.into(),
        sender_initials: sender[..1].into(),
        sender_avatar: None,
        sender_id: id.into(),
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
fn a_dot_is_drawn_only_for_a_known_state_and_updates_one_sender_without_resizing_anything(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    let t = 1_700_000_000_000u64;
    // 0 Alice (en ligne), 1 Bob (absent), 2 Carol (hors ligne), 3 Dan (inconnu).
    let events = vec![
        msg("a", "Alice", "@alice:x", t),
        msg("b", "Bob", "@bob:x", t + 1000),
        msg("c", "Carol", "@carol:x", t + 2000),
        msg("d", "Dan", "@dan:x", t + 3000),
    ];
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(ui::RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(TimelineUpdate::Events { room: room.clone(), events, at_start: Some(true) }, cx);
        });
        window.render_frame(cx);
        window.render_frame(cx);
        assert!(window.try_find("presence-0").is_none(), "aucune présence connue : aucun élément");
        let heights = |window: &gpui_kit::Window| -> Vec<f32> {
            rendered_rows(window).iter().map(|i| f32::from(window.find(row_id(*i)).bounds().size.height)).collect()
        };
        let before = heights(window);

        view.update(cx, |view, cx| {
            view.apply_presence("@alice:x", Presence::Online, cx);
            view.apply_presence("@bob:x", Presence::Unavailable, cx);
            view.apply_presence("@carol:x", Presence::Offline, cx);
        });
        window.render_frame(cx);
        window.render_frame(cx);
        assert_eq!(window.find("presence-0").label(), Some("en ligne"));
        assert_eq!(window.find("presence-1").label(), Some("absent"));
        assert_eq!(window.find("presence-2").label(), Some("hors ligne"));
        assert!(window.try_find("presence-3").is_none(), "état inconnu : pas de pastille");

        // 8 px de pastille + anneau de 1 px ; l'avatar reste à 32 px et la ligne à 48 px.
        let dot = window.find("presence-0").bounds();
        assert_eq!((f32::from(dot.size.width), f32::from(dot.size.height)), (10.0, 10.0));
        let avatar = window.find("avatar-0").bounds();
        assert_eq!((f32::from(avatar.size.width), f32::from(avatar.size.height)), (32.0, 32.0));
        assert_eq!(heights(window), before, "aucun changement de hauteur");
        assert!(heights(window).iter().all(|h| (h - EVENT_ROW_HEIGHT).abs() < 0.5));

        // Mise à jour ciblée : seule la ligne de Bob change, sans recharger la timeline.
        view.update(cx, |view, cx| view.apply_presence("@bob:x", Presence::Offline, cx));
        window.render_frame(cx);
        assert_eq!(window.find("presence-1").label(), Some("hors ligne"));
        assert_eq!(window.find("presence-0").label(), Some("en ligne"));
        assert_eq!(window.find("presence-2").label(), Some("hors ligne"));
        view.update(cx, |view, cx| view.apply_presence("@alice:x", Presence::Unknown, cx));
        window.render_frame(cx);
        assert!(window.try_find("presence-0").is_none(), "Unknown retire la pastille");
        assert_eq!(window.find("presence-1").label(), Some("hors ligne"));
    })
    .expect("fenêtre");
}
