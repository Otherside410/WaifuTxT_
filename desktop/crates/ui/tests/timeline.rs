//! Rendu headless de la timeline (étape 4) : éléments présents, virtualisation, pagination sans saut,
//! états vide / chargement / erreur, réponse tardive d'un ancien salon.

mod common;

use common::{close_modal_and_open, open_main, rendered_rows, row_id, top_row};
use domain::{EventId, EventState, EventVm, TimelineUpdate};
use gpui_kit::test::TestWindowExt;
use gpui_kit::{point, px, AppContext, ScrollDelta, TestAppContext};
use ui::{RoomsState, EVENT_ROW_HEIGHT};

#[gpui_kit::test]
fn selecting_the_demo_room_shows_a_virtualized_timeline_of_constant_height_rows(
    cx: &mut TestAppContext,
) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("timeline-header").label(), Some("général"));
        assert_eq!(window.find("timeline-list").label(), Some("Messages"), "la liste est présente");
        assert!(window.try_find("timeline-empty").is_none());
        assert!(window.try_find("timeline-placeholder").is_none());

        let rows = rendered_rows(window);
        assert!(!rows.is_empty(), "des messages sont rendus");
        // 50 messages chargés, mais seulement les lignes visibles existent dans l'arbre.
        assert!(rows.len() < 30, "virtualisation : {} lignes rendues sur 50 chargés", rows.len());
        assert!(window.try_find("event-50").is_none(), "pas plus de 50 messages chargés");

        // Hauteur constante, y compris pour la ligne indéchiffrable.
        for i in &rows {
            let h = f32::from(window.find(row_id(*i)).bounds().size.height);
            assert!((h - EVENT_ROW_HEIGHT).abs() < 0.5, "ligne {i} : hauteur {h}");
        }

        // Lecture sur les derniers messages : le dernier est le n°199.
        let last = *rows.last().expect("ligne");
        assert!(window.find(row_id(last)).label().unwrap_or_default().contains("n°199"));

        // Le message indéchiffrable porte un placeholder explicite, jamais une ligne vide.
        let undecryptable = rows
            .iter()
            .map(|i| window.find(row_id(*i)).label().unwrap_or_default().to_owned())
            .find(|label| label.contains("clé manquante"));
        assert!(undecryptable.is_some(), "placeholder du message chiffré visible");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn scrolling_to_the_top_paginates_without_jump_or_duplicates(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");

    let mut before = (String::new(), 0.0_f32);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        // On remonte tout en haut des 50 messages chargés.
        window.scroll("timeline-list", ScrollDelta::Pixels(point(px(0.), px(100_000.))), cx);
        window.render_frame(cx);
        before = top_row(window);
        assert!(before.0.contains("n°150"), "tout en haut : {:?}", before);
    })
    .expect("fenêtre");

    // Le rendu a demandé une page plus ancienne (hors rendu) : on la laisse arriver.
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let after = top_row(window);
        assert!(after.0.contains("n°150"), "le message lu reste le même : {:?} → {:?}", before, after);
        assert!(
            (after.1 - before.1).abs() < 1.0,
            "aucun saut visuel : y {} → {}",
            before.1,
            after.1
        );
    })
    .expect("fenêtre");

    // On charge tout l'historique : le début est atteint, sans doublon.
    for _ in 0..6 {
        cx.update_window(handle.into(), |_, window, cx| {
            window.scroll("timeline-list", ScrollDelta::Pixels(point(px(0.), px(100_000.))), cx);
            window.render_frame(cx);
        })
        .expect("fenêtre");
        cx.run_until_parked();
    }
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(window.try_find("timeline-start").is_some(), "début de la conversation atteint");
        let labels: Vec<String> = rendered_rows(window)
            .iter()
            .map(|i| window.find(row_id(*i)).label().unwrap_or_default().to_owned())
            .collect();
        let mut unique = labels.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), labels.len(), "aucun doublon à l'écran");
        assert!(labels.first().is_some_and(|l| l.contains("n°0")), "le premier message est le n°0");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn rooms_without_messages_show_an_empty_state_and_no_message(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    // Le DM de démonstration est vide.
    close_modal_and_open(cx, handle, "room-2");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("timeline-header").label(), Some("Alice Demo"));
        assert_eq!(window.find("timeline-empty").label(), Some("Aucun message dans ce salon."));
        assert!(rendered_rows(window).is_empty(), "aucune ligne de message");
        assert!(window.try_find("timeline-list").is_none());
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn switching_rooms_never_mixes_timelines(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        assert!(!rendered_rows(window).is_empty());
        window.click("room-2", cx);
        window.render_frame(cx);
        assert!(rendered_rows(window).is_empty(), "les messages de l'ancien salon ont disparu");
        assert!(window.try_find("timeline-empty").is_some());
        window.click("room-1", cx);
        window.render_frame(cx);
        assert!(!rendered_rows(window).is_empty(), "retour sur le salon : ses messages reviennent");
    })
    .expect("fenêtre");
}

fn event(room_tag: &str, ts: u64) -> EventVm {
    EventVm {
        id: EventId::from(format!("${room_tag}-{ts}").as_str()),
        sender_name: "Test".into(),
        sender_initials: "T".into(),
        timestamp_ms: ts,
        time_label: "12:00".into(),
        body: format!("message {room_tag}"),
        state: EventState::Normal,
        event_id: Some(EventId::from(format!("$ev-{room_tag}-{ts}").as_str())),
        is_own: false,
        edited: false,
        read_by: Vec::new(),
    }
}

#[gpui_kit::test]
fn loading_error_retry_and_late_answers_in_real_mode(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let (old_room, new_room) = (rooms[1].id.clone(), rooms[2].id.clone());
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(RoomsState::Ready(rooms), cx));
        window.render_frame(cx);

        // Salon sélectionné, rien reçu : état « chargement », jamais une liste vide trompeuse.
        window.click("room-1", cx);
        window.render_frame(cx);
        assert!(window.try_find("timeline-loading").is_some());
        assert!(window.try_find("timeline-empty").is_none());

        // L'utilisateur change de salon avant la réponse du premier.
        window.click("room-2", cx);
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: old_room.clone(),
                    events: vec![event("ancien", 1)],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
        assert!(window.try_find("timeline-loading").is_some(), "réponse tardive ignorée");
        assert!(rendered_rows(window).is_empty());

        // Erreur de chargement : message clair + bouton « Réessayer ».
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Failed { room: new_room.clone(), message: "réseau coupé".into() },
                cx,
            );
        });
        window.render_frame(cx);
        assert!(window.try_find("timeline-error").is_some());
        assert!(window.try_find("timeline-retry").is_some());

        // Réessayer repasse en chargement.
        window.click("timeline-retry", cx);
        window.render_frame(cx);
        assert!(window.try_find("timeline-error").is_none());
        assert!(window.try_find("timeline-loading").is_some());

        // La bonne réponse arrive : les messages s'affichent.
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Events {
                    room: new_room.clone(),
                    events: vec![event("nouveau", 2)],
                    at_start: Some(true),
                },
                cx,
            );
        });
        window.render_frame(cx);
        assert_eq!(rendered_rows(window), vec![0]);
        assert!(window.find("event-0").label().unwrap_or_default().contains("message nouveau"));
    })
    .expect("fenêtre");
}

fn live_event(tag: &str, ts: u64) -> TimelineUpdate {
    TimelineUpdate::Events {
        room: domain::RoomId::from(ui::demo::ROOM_ID),
        events: vec![event(tag, ts)],
        at_start: None,
    }
}

#[gpui_kit::test]
fn a_live_message_sticks_to_the_bottom_only_when_reading_the_bottom(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");

    // En bas : le message reçu apparaît et la vue reste collée en bas.
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| view.apply_timeline(live_event("direct-1", 9_000_000_000_000), cx));
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let rows = rendered_rows(window);
        let last = *rows.last().expect("ligne");
        let label = window.find(row_id(last)).label().unwrap_or_default().to_owned();
        assert!(label.contains("message direct-1"), "collé en bas : dernière ligne = {label:?}");

        // L'utilisateur remonte lire plus haut : un nouveau message ne doit pas bouger la vue.
        window.scroll("timeline-list", ScrollDelta::Pixels(point(px(0.), px(600.))), cx);
        window.render_frame(cx);
    })
    .expect("fenêtre");
    let mut before = (String::new(), 0.0_f32);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        before = top_row(window);
        view.update(cx, |view, cx| view.apply_timeline(live_event("direct-2", 9_000_000_060_000), cx));
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let after = top_row(window);
        assert_eq!(before.0, after.0, "la ligne lue ne change pas");
        assert!((before.1 - after.1).abs() < 1.0, "la vue ne bouge pas : {} → {}", before.1, after.1);
        let any_new = rendered_rows(window).iter().any(|i| {
            window.find(row_id(*i)).label().unwrap_or_default().contains("message direct-2")
        });
        assert!(!any_new, "le nouveau message est en bas, hors de la vue");
    })
    .expect("fenêtre");
}
