//! Regroupement rendu : une rafale d'un même expéditeur n'a qu'un en-tête, les actions n'ont pas de colonne réservée.

mod common;

use common::{open_main, rendered_rows, row_id};
use domain::{EventId, EventState, EventVm, TimelineUpdate};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, TestAppContext};

fn msg(tag: &str, sender: &str, ts: u64, own: bool) -> EventVm {
    EventVm {
        id: EventId::from(format!("${tag}").as_str()),
        sender_name: sender.into(),
        sender_initials: sender[..1].into(),
        sender_avatar: None,
        timestamp_ms: ts,
        time_label: "12:00".into(),
        body: format!("message {tag}"),
        state: EventState::Normal,
        event_id: Some(EventId::from(format!("$real-{tag}").as_str())),
        is_own: own,
        edited: false,
        read_by: Vec::new(),
        media: None,
    }
}

#[gpui_kit::test]
fn a_burst_from_one_sender_has_a_single_header_and_actions_reserve_no_column(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    // 6 messages de Alice (1 min d'écart), 1 de Bob, 1 d'Alice 10 min plus tard, 2 de moi (dont 1 suite).
    let t = 1_700_000_000_000u64;
    let mut events: Vec<EventVm> = (0..6).map(|i| msg(&format!("a{i}"), "Alice", t + i * 60_000, false)).collect();
    events.push(msg("b0", "Bob", t + 400_000, false));
    events.push(msg("a6", "Alice", t + 1_100_000, false));
    events.push(msg("m0", "Moi", t + 1_150_000, true));
    events.push(msg("m1", "Moi", t + 1_160_000, true));
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

        let rows = rendered_rows(window);
        assert_eq!(rows.len(), 10, "{rows:?}");
        let headers: Vec<usize> = rows.iter().copied().filter(|i| window.try_find(format!("event-header-{i}")).is_some()).collect();
        assert_eq!(headers, vec![0, 6, 7, 8], "en-têtes : Alice (rafale), Bob, Alice +10 min, Moi");
        for i in [1, 2, 3, 4, 5, 9] {
            assert!(window.try_find(format!("event-header-{i}")).is_none(), "ligne {i} sans en-tête");
        }

        // Le libellé d'accessibilité garde l'expéditeur sur chaque ligne, suite de groupe comprise.
        assert!(window.find(row_id(3)).label().unwrap_or_default().starts_with("Alice : "));

        // Mes messages ont des actions dans l'arbre (révélées au survol), sans colonne réservée : pas de corps rétréci.
        let row_w = f32::from(window.find(row_id(8)).bounds().size.width);
        let header_w = f32::from(window.find("event-header-8").bounds().size.width);
        let actions_w = f32::from(window.find("actions-9").bounds().size.width);
        println!("MESURE largeur_ligne={row_w} largeur_en_tete={header_w} largeur_actions={actions_w}");
        assert!(header_w > row_w - 32.0 - 24.0 - 12.0 - 1.0, "le corps récupère la largeur : {header_w} / {row_w}");
    })
    .expect("fenêtre");
}
