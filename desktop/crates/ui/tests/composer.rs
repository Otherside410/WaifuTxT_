//! Rendu headless de la zone de saisie (étape 5) : présence, désactivation, envoi (Entrée),
//! saut de ligne (Maj+Entrée), texte vide sans effet, écho local puis confirmation sans doublon,
//! échec d'envoi avec brouillon restitué et nouvelle tentative.

mod common;

use common::{close_modal_and_open, open_main, rendered_rows, row_id};
use domain::{RoomId, TimelineUpdate};
use gpui_kit::test::{TestQueryExt, TestWindowExt};
use gpui_kit::{AppContext, TestAppContext, Window};
use std::time::Duration;

const DEMO_ROOM: &str = "!demo-room:demo";

fn field_value(window: &Window) -> String {
    window.find_by_label("Message").value().unwrap_or_default().to_owned()
}

fn row_labels(window: &Window) -> Vec<String> {
    rendered_rows(window)
        .iter()
        .map(|i| window.find(row_id(*i)).label().unwrap_or_default().to_owned())
        .collect()
}

/// La saisie accepte-t-elle du texte ? (`disabled()` n'est pas publié par l'accessibilité du champ :
/// on vérifie le comportement, un champ désactivé rejette la frappe.)
fn typing_is_accepted(cx: &mut TestAppContext, handle: gpui_kit::WindowHandle<gpui_kit::base::Root>) -> bool {
    let mut accepted = false;
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("composer", cx);
        window.input("z", cx);
        accepted = field_value(window) == "z";
        if accepted {
            window.press("ctrl-a", cx);
            window.press("backspace", cx);
        }
    })
    .expect("fenêtre");
    accepted
}

fn rows_containing(window: &Window, needle: &str) -> usize {
    row_labels(window).iter().filter(|label| label.contains(needle)).count()
}

#[gpui_kit::test]
fn the_composer_is_present_and_disabled_until_a_room_is_selected(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("composer").label(), Some("Zone de saisie"));
        let field = window.find_by_label("Message");
        assert!(
            field.placeholder().unwrap_or_default().contains("Écrire un message"),
            "placeholder explicite : {:?}",
            field.placeholder()
        );
    })
    .expect("fenêtre");

    assert!(!typing_is_accepted(cx, handle), "pas de salon : la saisie est désactivée");

    close_modal_and_open(cx, handle, "room-1");
    assert!(typing_is_accepted(cx, handle), "salon sélectionné : la saisie est active");
}

#[gpui_kit::test]
fn the_composer_is_disabled_while_the_timeline_is_in_error(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, false);
    let rooms = ui::demo::demo_rooms();
    let room = rooms[1].id.clone();
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| view.set_rooms(ui::RoomsState::Ready(rooms), cx));
        window.render_frame(cx);
        window.click("room-1", cx);
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert!(typing_is_accepted(cx, handle), "timeline en chargement : saisie active");
    cx.update_window(handle.into(), |_, window, cx| {
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::Failed { room: room.clone(), message: "réseau coupé".into() },
                cx,
            );
        });
        window.render_frame(cx);
        assert!(window.try_find("timeline-error").is_some());
    })
    .expect("fenêtre");
    cx.run_until_parked();
    assert!(!typing_is_accepted(cx, handle), "timeline en erreur : la saisie est désactivée");
}

#[gpui_kit::test]
fn blank_text_sends_nothing_and_enter_has_no_phantom_effect(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    let mut baseline: Vec<String> = Vec::new();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        baseline = row_labels(window);
    })
    .expect("fenêtre");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("composer", cx);
        window.input("   ", cx);
        window.press("enter", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(row_labels(window), baseline, "aucun message ajouté");
        assert_eq!(field_value(window), "   ", "Entrée n'a rien inséré (pas de saut de ligne fantôme)");

        // Champ totalement vide : même chose.
        window.press("ctrl-a", cx);
        window.press("backspace", cx);
        window.press("enter", cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(row_labels(window), baseline);
        assert_eq!(field_value(window), "");
        assert!(window.try_find("composer-error").is_none());
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn shift_enter_inserts_a_newline_and_the_field_grows_up_to_five_lines(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("composer", cx);
        let height = |window: &Window| f32::from(window.find("composer").bounds().size.height);
        let one_line = height(window);

        window.input("a", cx);
        window.press("shift-enter", cx);
        window.input("b", cx);
        window.render_frame(cx);
        assert_eq!(field_value(window), "a\nb", "Maj+Entrée insère un saut de ligne");
        assert!(row_labels(window).iter().all(|l| !l.contains("a\nb")), "rien n'est envoyé");

        for _ in 0..2 {
            window.press("shift-enter", cx);
            window.input("x", cx);
        }
        window.render_frame(cx);
        let four_lines = height(window);
        assert!(four_lines > one_line, "le champ grandit : {one_line} → {four_lines}");

        for _ in 0..6 {
            window.press("shift-enter", cx);
            window.input("x", cx);
        }
        window.render_frame(cx);
        let ten_lines = height(window);
        for _ in 0..6 {
            window.press("shift-enter", cx);
            window.input("x", cx);
        }
        window.render_frame(cx);
        assert_eq!(height(window), ten_lines, "plafonné à ~5 lignes");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn sending_shows_a_local_echo_then_confirms_it_without_duplicate(cx: &mut TestAppContext) {
    let (handle, _view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");

    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("composer", cx);
        window.input("bonjour le monde", cx);
        window.press("enter", cx);
    })
    .expect("fenêtre");
    // L'événement Entrée est traité à la fin de la mise à jour : on le laisse passer.
    cx.run_until_parked();

    let mut total_after_send = 0;
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(field_value(window), "", "champ vidé après envoi");
        assert_eq!(window.find_by_label("Message").focused(), Some(true), "focus conservé");
        assert_eq!(rows_containing(window, "bonjour le monde"), 1, "écho local affiché");
        assert_eq!(rows_containing(window, "[envoi en cours]"), 1, "état Local");
        let last = *rendered_rows(window).last().expect("ligne");
        assert!(
            window.find(row_id(last)).label().unwrap_or_default().contains("bonjour le monde"),
            "vue collée en bas : le message est la dernière ligne"
        );
        total_after_send = rendered_rows(window).len();
    })
    .expect("fenêtre");

    // Le SDK (ici : la simulation) confirme : même ligne, état Normal, aucun doublon.
    cx.executor().advance_clock(Duration::from_millis(700));
    cx.run_until_parked();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(rows_containing(window, "bonjour le monde"), 1, "toujours une seule ligne");
        assert_eq!(rows_containing(window, "[envoi en cours]"), 0, "confirmé : plus d'état Local");
        assert_eq!(rendered_rows(window).len(), total_after_send, "aucune ligne ajoutée");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_failed_send_shows_the_error_restores_the_draft_and_can_be_retried(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::SendFailed {
                    room: RoomId::from(DEMO_ROOM),
                    text: "mon brouillon".into(),
                    message: "Envoi impossible : réseau coupé".into(),
                },
                cx,
            );
        });
        window.render_frame(cx);
        window.render_frame(cx);
        assert_eq!(
            window.find("composer-error").label(),
            Some("Envoi impossible : réseau coupé"),
            "message lisible à l'écran"
        );
        assert_eq!(field_value(window), "mon brouillon", "le brouillon n'est pas perdu");
        assert!(window.try_find("composer-retry").is_some());

        // Réessayer renvoie le brouillon : l'erreur disparaît, l'écho local apparaît.
        window.click("composer-retry", cx);
        window.render_frame(cx);
        assert!(window.try_find("composer-error").is_none());
        assert_eq!(field_value(window), "");
        assert_eq!(rows_containing(window, "mon brouillon"), 1);
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_failure_from_another_room_does_not_touch_the_composer(cx: &mut TestAppContext) {
    let (handle, view) = open_main(cx, true);
    close_modal_and_open(cx, handle, "room-1");
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.apply_timeline(
                TimelineUpdate::SendFailed {
                    room: RoomId::from("!autre:demo"),
                    text: "pas pour ce salon".into(),
                    message: "x".into(),
                },
                cx,
            );
        });
        window.render_frame(cx);
        assert!(window.try_find("composer-error").is_none());
        assert_eq!(field_value(window), "");
    })
    .expect("fenêtre");
}
