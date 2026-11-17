//! Avatars de la timeline : photo ronde 32 px quand les octets sont en cache, disque d'initiales sinon.

mod common;

use common::open_main;
use domain::{avatar_key, EventId, EventState, EventVm, MediaPayload, TimelineUpdate};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, TestAppContext};

const MXC: &str = "mxc://test/alice";

fn msg(tag: &str, sender: &str, avatar: Option<&str>, ts: u64) -> EventVm {
    EventVm {
        id: EventId::from(format!("${tag}").as_str()),
        sender_name: sender.into(),
        sender_initials: sender[..1].into(),
        sender_avatar: avatar.map(str::to_owned),
        sender_id: String::new(),
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
fn a_photo_is_shown_when_its_bytes_are_cached_and_initials_otherwise(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    let t = 1_700_000_000_000u64;
    // 0 : Alice avec photo en cache ; 1 : Bob sans photo ; 2 : Carol avec photo jamais arrivée (téléchargement en cours).
    let events = vec![
        msg("a", "Alice", Some(MXC), t),
        msg("b", "Bob", None, t + 1000),
        msg("c", "Carol", Some("mxc://test/carol"), t + 2000),
    ];
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(ui::RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(TimelineUpdate::Events { room: room.clone(), events, at_start: Some(true) }, cx);
            view.apply_timeline(
                TimelineUpdate::Media {
                    room: room.clone(),
                    key: avatar_key(MXC),
                    payload: MediaPayload::Ready(std::sync::Arc::new(ui::demo::gradient_bmp(64, 64))),
                },
                cx,
            );
        });
        window.render_frame(cx);
        window.render_frame(cx);

        assert_eq!(window.find("avatar-0").label(), Some("Photo de Alice"));
        assert_eq!(window.find("avatar-1").label(), Some("Initiales de Bob"));
        assert_eq!(window.find("avatar-2").label(), Some("Initiales de Carol"), "octets absents : repli, pas de panic");
        for i in 0..3 {
            let b = window.find(format!("avatar-{i}")).bounds();
            assert_eq!((f32::from(b.size.width), f32::from(b.size.height)), (32.0, 32.0), "avatar-{i}");
        }
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_failed_avatar_download_keeps_the_initials(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(ui::RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events { room: room.clone(), events: vec![msg("a", "Alice", Some(MXC), 1)], at_start: Some(true) },
                cx,
            );
            view.apply_timeline(
                TimelineUpdate::Media { room: room.clone(), key: avatar_key(MXC), payload: MediaPayload::Failed("404".into()) },
                cx,
            );
        });
        window.render_frame(cx);
        window.render_frame(cx);
        assert_eq!(window.find("avatar-0").label(), Some("Initiales de Alice"));
    })
    .expect("fenêtre");
}
