//! D5 : état de connexion lisible et premier instantané local, côté interface.

mod common;

use common::open_main;
use domain::{ConnectionState, KeyStatus};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, TestAppContext};

#[gpui_kit::test]
fn a_local_snapshot_lists_the_known_rooms_at_once_under_a_connecting_banner(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("rooms-state").is_some(), "avant tout instantané : « Synchronisation… »");
        assert!(window.try_find("room-0").is_none());

        view.update(cx, |view, cx| {
            view.apply_local_snapshot(ui::demo::demo_rooms(), KeyStatus::NotNeeded, cx);
        });
        window.render_frame(cx);
        assert!(window.try_find("rooms-state").is_none(), "plus de « Synchronisation… »");
        for room in ["room-0", "room-1", "room-2"] {
            assert!(window.try_find(room).is_some(), "salon du store absent : {room}");
        }
        assert_eq!(window.find("connection-banner").label(), Some("Connexion au serveur…"));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn an_empty_local_snapshot_is_not_announced_as_no_rooms(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.apply_local_snapshot(Vec::new(), KeyStatus::Unknown, cx));
        window.render_frame(cx);
        // Premier démarrage : rien en store ne prouve qu'il n'y a pas de salon.
        assert!(window.try_find("rooms-state").is_some(), "on garde « Synchronisation… »");
        assert_eq!(window.find("rooms-state").label(), Some("Synchronisation…"));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn an_unreachable_server_shows_a_readable_offline_banner_and_keeps_the_rooms(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| {
            view.apply_local_snapshot(ui::demo::demo_rooms(), KeyStatus::NotNeeded, cx);
            view.set_connection(ConnectionState::Offline("Homeserver injoignable.".into()), cx);
        });
        window.render_frame(cx);
        let banner = window.find("connection-banner").label().unwrap_or_default().to_owned();
        assert!(banner.starts_with("Hors ligne") && banner.contains("Homeserver injoignable."), "{banner}");
        assert!(window.try_find("room-1").is_some(), "les salons du store restent affichés hors ligne");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn the_server_coming_back_clears_the_banner_without_any_restart(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| {
            view.apply_local_snapshot(ui::demo::demo_rooms(), KeyStatus::NotNeeded, cx);
            view.set_connection(ConnectionState::Offline("coupé".into()), cx);
        });
        window.render_frame(cx);
        assert!(window.try_find("connection-banner").is_some());

        // Réponse du serveur : liste à jour (un salon de plus), bandeau retiré.
        let mut rooms = ui::demo::demo_rooms();
        rooms.push(domain::RoomVm::new(
            domain::RoomId::from("!nouveau:localhost"),
            "arrivé après la coupure",
            domain::RoomKind::Room,
            0,
        ));
        view.update(cx, |view, cx| view.apply_server_snapshot(rooms, KeyStatus::NotNeeded, cx));
        window.render_frame(cx);
        assert!(window.try_find("connection-banner").is_none(), "serveur de retour : plus de bandeau");
        assert!(window.try_find("room-3").is_some(), "la liste est mise à jour sans redémarrage");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_late_local_snapshot_never_downgrades_an_online_connection(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| {
            view.apply_server_snapshot(ui::demo::demo_rooms(), KeyStatus::NotNeeded, cx);
            view.apply_local_snapshot(ui::demo::demo_rooms(), KeyStatus::NotNeeded, cx);
        });
        window.render_frame(cx);
        assert!(window.try_find("connection-banner").is_none(), "le local ne redonne pas « Connexion… »");
    })
    .expect("fenêtre");
}
