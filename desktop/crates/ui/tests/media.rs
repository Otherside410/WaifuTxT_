//! Rendu headless de l'étape 7 : médias en ligne (images bornées, fichiers, indisponibles), pièces jointes.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{close_modal_and_open, open_demo_media, open_main, rendered_rows, row_id};
use domain::{
    EventId, EventState, EventVm, MediaKind, MediaPayload, MediaStatus, MediaVm, RoomId,
    TimelineUpdate, THUMBNAIL_SIDE,
};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, SharedString, TestAppContext, Window};
use ui::{RoomsState, EVENT_ROW_HEIGHT};

/// Index des lignes de médias dans la démo : 50 messages texte chargés, puis 6 messages à médias.
const IMAGE: usize = 50;
const HUGE_IMAGE: usize = 51;
const FILE: usize = 52;
const SEALED: usize = 53;
const UPLOADING: usize = 54;
const LOST: usize = 55;

fn media_id(index: usize) -> SharedString {
    SharedString::from(format!("media-{index}"))
}

fn row(window: &Window, index: usize) -> String {
    window.find(row_id(index)).label().unwrap_or_default().to_owned()
}

fn box_size(window: &Window, index: usize) -> (f32, f32) {
    let bounds = window.find(media_id(index)).bounds();
    (f32::from(bounds.size.width), f32::from(bounds.size.height))
}

#[gpui_kit::test]
fn image_rows_have_a_bounded_constant_size_even_for_a_4000_pixel_image(cx: &mut TestAppContext) {
    let (handle, _view) = open_demo_media(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(rendered_rows(window).contains(&IMAGE), "lignes média rendues : {:?}", rendered_rows(window));
        for index in [IMAGE, HUGE_IMAGE, FILE, SEALED, LOST] {
            let row_height = f32::from(window.find(row_id(index)).bounds().size.height);
            assert!((row_height - EVENT_ROW_HEIGHT).abs() < 0.5, "ligne {index} : {row_height}");
            let (w, h) = box_size(window, index);
            assert!(
                (w - THUMBNAIL_SIDE as f32).abs() < 0.5 && (h - THUMBNAIL_SIDE as f32).abs() < 0.5,
                "boîte {index} : {w}×{h}"
            );
        }
        // L'image annoncée en 4000×3000 est décrite comme telle, mais jamais dessinée en grand.
        assert!(row(window, HUGE_IMAGE).contains("4000×3000"), "{}", row(window, HUGE_IMAGE));
        assert!(row(window, IMAGE).contains("96×64") && row(window, IMAGE).contains("paysage.bmp"));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn the_image_box_does_not_move_between_loading_and_decoded(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    let key = "mxc://demo/avant-apres";
    let image_event = EventVm {
        id: EventId::from("$img"),
        sender_name: "Alice".into(),
        sender_initials: "A".into(),
        sender_avatar: None,
        timestamp_ms: 1,
        time_label: "12:00".into(),
        body: "grande.bmp".into(),
        state: EventState::Normal,
        event_id: Some(EventId::from("$real-img")),
        is_own: false,
        edited: false,
        read_by: Vec::new(),
        media: Some(MediaVm {
            key: key.into(),
            kind: MediaKind::Image,
            filename: "grande.bmp".into(),
            size: Some(5_000_000),
            mime: Some("image/bmp".into()),
            width: Some(4000),
            height: Some(3000),
            encrypted: false,
            status: MediaStatus::Available,
        }),
    };
    let mut before = (0.0, 0.0);
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: room.clone(),
                    events: vec![image_event],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
        // Octets pas encore arrivés : l'espace est déjà réservé, à la taille définitive.
        before = box_size(window, 0);
        assert!((before.0 - THUMBNAIL_SIDE as f32).abs() < 0.5 && (before.1 - THUMBNAIL_SIDE as f32).abs() < 0.5);
        assert!(window.find(media_id(0)).label().unwrap_or_default().contains("grande.bmp"));

        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Media {
                    room: room.clone(),
                    key: key.into(),
                    payload: MediaPayload::Ready(Arc::new(ui::demo::gradient_bmp(64, 48))),
                },
                cx,
            );
        });
        window.render_frame(cx);
        assert_eq!(box_size(window, 0), before, "aucun saut de mise en page au décodage");
        let height = f32::from(window.find(row_id(0)).bounds().size.height);
        assert!((height - EVENT_ROW_HEIGHT).abs() < 0.5);
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_file_row_shows_its_name_and_a_readable_size(cx: &mut TestAppContext) {
    let (handle, _view) = open_demo_media(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let label = row(window, FILE);
        assert!(label.contains("rapport-trimestriel.pdf"), "{label}");
        assert!(label.contains("2,4 Mo"), "taille lisible : {label}");
        let card = window.find(media_id(FILE)).label().unwrap_or_default().to_owned();
        assert_eq!(card, "Fichier : rapport-trimestriel.pdf · 2,4 Mo · application/pdf");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn an_undecryptable_encrypted_image_shows_a_placeholder_and_never_a_raw_error(
    cx: &mut TestAppContext,
) {
    let (handle, _view) = open_demo_media(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let label = row(window, SEALED);
        assert!(label.contains("média indisponible"), "{label}");
        assert!(label.contains("chiffree.jpg"));
        for index in rendered_rows(window) {
            let any = format!("{} {}", row(window, index), window.find(row_id(index)).label().unwrap_or_default());
            assert!(!any.contains("DecryptorError") && !any.contains("hash mismatch"), "erreur brute : {any}");
        }
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_failed_attachment_stays_visible_and_selectable(cx: &mut TestAppContext) {
    let (handle, _view) = open_demo_media(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let label = row(window, LOST);
        assert!(label.contains("photo-perdue.png"), "{label}");
        assert!(label.contains("[non envoyé]") && label.contains("[média en échec]"), "{label}");
        assert!(!label.contains("[sélectionné]"));

        window.click(row_id(LOST), cx);
        window.render_frame(cx);
        assert!(row(window, LOST).contains("[sélectionné]"), "{}", row(window, LOST));
        // Sélectionner une autre ligne déplace la sélection.
        window.click(row_id(FILE), cx);
        window.render_frame(cx);
        assert!(row(window, FILE).contains("[sélectionné]"));
        assert!(!row(window, LOST).contains("[sélectionné]"));
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn an_upload_in_progress_shows_its_progress(cx: &mut TestAppContext) {
    let (handle, _view) = open_demo_media(cx);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let label = row(window, UPLOADING);
        assert!(label.contains("Envoi de video-longue.mp4 : 60 %"), "{label}");
        assert!(label.contains("[envoi en cours]"));
        assert_eq!(
            window.find(media_id(UPLOADING)).label(),
            Some("Envoi en cours : video-longue.mp4")
        );
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn attaching_a_file_shows_a_local_echo_then_confirms_it_without_duplicate(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    let mut total = 0;
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("attach-button").is_some(), "bouton « Joindre » présent");
        view.update(cx, |view, cx| view.attach_path("/home/demo/archives/releve.zip".into(), cx));
        window.render_frame(cx);
        let labels: Vec<String> = rendered_rows(window).iter().map(|i| row(window, *i)).collect();
        let hit: Vec<_> = labels.iter().filter(|l| l.contains("releve.zip")).collect();
        assert_eq!(hit.len(), 1, "écho local de la pièce jointe : {labels:?}");
        assert!(hit[0].contains("[envoi en cours]") && hit[0].contains("40 %"), "{}", hit[0]);
        total = rendered_rows(window).len();
    })
    .expect("fenêtre");

    cx.executor().advance_clock(Duration::from_millis(700));
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let labels: Vec<String> = rendered_rows(window).iter().map(|i| row(window, *i)).collect();
        assert_eq!(labels.iter().filter(|l| l.contains("releve.zip")).count(), 1, "aucun doublon");
        assert!(!labels.iter().any(|l| l.contains("[envoi en cours]")), "confirmé");
        assert_eq!(rendered_rows(window).len(), total);
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_failed_attachment_shows_a_readable_error_and_can_be_retried(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::AttachmentFailed {
                    room: RoomId::from("!demo-room:demo"),
                    path: "/home/demo/gros.iso".into(),
                    message: "Fichier trop volumineux (60,0 Mo, limite 50,0 Mo).".into(),
                },
                cx,
            );
        });
        window.render_frame(cx);
        assert_eq!(
            window.find("composer-error").label(),
            Some("Fichier trop volumineux (60,0 Mo, limite 50,0 Mo).")
        );
        window.click("composer-retry", cx);
        window.render_frame(cx);
        assert!(window.try_find("composer-error").is_none());
        let echoed = rendered_rows(window).iter().any(|i| row(window, *i).contains("gros.iso"));
        assert!(echoed, "la relance renvoie la pièce jointe");
    })
    .expect("fenêtre");
}
