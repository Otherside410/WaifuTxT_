//! Prototype W06 : timeline virtualisée de 5 000 messages à hauteurs variables, rendue en fenêtre de test (sans GPU).
//!
//! Les tests de la suite fonctionnelle vérifient des **comportements** (lignes construites par frame, ancre de lecture,
//! suivi de la fin) et n'assertent jamais une durée (leçon de D9). Le banc de coût (`timeline_5000_frame_cost`) est
//! `#[ignore]` : il rapporte des durées, il ne les juge pas.

use std::time::Instant;

use gpui_kit::test::TestWindowExt;
use gpui_kit::{px, size, AppContext, Bounds, Entity, Point, TestAppContext, WindowBounds, WindowHandle, WindowOptions};
use gpui_kit::base::Root;
use ui::{summarize, TimelineProto, PROTO_MESSAGES};

/// Plafond de lignes construites par frame pour une fenêtre 1280×800 : ≈ la hauteur visible + 400 px de marge de chaque
/// côté (`LIST_OVERDRAW` de `MessageScroller`), avec des lignes d'au moins ~40 px. Large exprès : le but est de prouver
/// que le coût ne dépend pas de 5 000, pas de régler un seuil fin.
const MAX_ROWS_PER_FRAME: usize = 80;

fn open_proto(cx: &mut TestAppContext, count: usize) -> (WindowHandle<Root>, Entity<TimelineProto>) {
    cx.update(gpui_kit::init);
    cx.update(|cx| {
        let bounds = Bounds { origin: Point::default(), size: size(px(1280.), px(800.)) };
        let options = WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() };
        let (window, view) = gpui_kit::open_window(options, cx, |_, cx| cx.new(|cx| TimelineProto::new(count, cx)))
            .expect("fenêtre de test");
        (window.downcast::<Root>().expect("Root"), view)
    })
}

#[gpui_kit::test]
fn five_thousand_messages_build_only_a_screenful_of_rows_per_frame(cx: &mut TestAppContext) {
    let (handle, view) = open_proto(cx, PROTO_MESSAGES);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let proto = view.read(cx);
        assert_eq!(proto.len(), PROTO_MESSAGES);
        assert_eq!(proto.scroller().read(cx).item_count(), PROTO_MESSAGES);
        let built = proto.take_built_rows();
        assert!(!built.is_empty(), "des lignes sont construites");
        assert!(built.len() <= MAX_ROWS_PER_FRAME, "{} lignes construites sur {PROTO_MESSAGES}", built.len());
        // Calée en bas : ce sont les dernières lignes.
        assert!(built.iter().all(|i| *i >= PROTO_MESSAGES - MAX_ROWS_PER_FRAME), "lignes du bas : {built:?}");
        assert!(built.contains(&(PROTO_MESSAGES - 1)), "la dernière ligne est construite");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn jumping_to_the_middle_builds_only_rows_around_the_target(cx: &mut TestAppContext) {
    let (handle, view) = open_proto(cx, PROTO_MESSAGES);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.read(cx).take_built_rows();

        view.update(cx, |proto, cx| assert!(proto.scroll_to_item(2_500, cx)));
        window.render_frame(cx);
        let built = view.read(cx).take_built_rows();
        assert!(!built.is_empty() && built.len() <= MAX_ROWS_PER_FRAME, "{} lignes", built.len());
        assert!(built.iter().all(|i| (2_400..=2_600).contains(i)), "aucune ligne intermédiaire construite : {built:?}");
        assert!(built.contains(&2_500), "la ligne visée est construite");
        assert_eq!(view.read(cx).scroller().read(cx).logical_scroll_top().item_ix, 2_500);
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn a_full_pass_from_top_to_bottom_never_builds_more_than_a_screenful(cx: &mut TestAppContext) {
    let (handle, view) = open_proto(cx, PROTO_MESSAGES);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.read(cx).take_built_rows();
        let (mut worst, mut total, mut frames) = (0, 0, 0);
        for index in (0..PROTO_MESSAGES).step_by(25) {
            view.update(cx, |proto, cx| {
                proto.scroll_to_item(index, cx);
            });
            window.render_frame(cx);
            let built = view.read(cx).take_built_rows().len();
            worst = worst.max(built);
            total += built;
            frames += 1;
        }
        assert_eq!(frames, PROTO_MESSAGES / 25);
        assert!(worst <= MAX_ROWS_PER_FRAME, "pire frame : {worst} lignes");
        // Sans virtualisation il faudrait 5 000 constructions par frame ; ici la moyenne reste du même ordre qu'une frame.
        assert!(total / frames <= MAX_ROWS_PER_FRAME, "moyenne {} lignes/frame", total / frames);
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn prepending_when_nothing_older_exists_changes_nothing(cx: &mut TestAppContext) {
    let (handle, view) = open_proto(cx, PROTO_MESSAGES);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |proto, cx| {
            proto.scroll_to_item(200, cx);
        });
        window.render_frame(cx);
        let before = view.read(cx).scroller().read(cx).logical_scroll_top();
        assert_eq!(before.item_ix, 200);

        let added = view.update(cx, |proto, cx| proto.prepend_older(0, cx));
        assert_eq!(added, 0, "rien de plus ancien que le message 0 : page vide");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn prepending_after_a_partial_load_moves_the_index_but_not_the_content_under_the_eye(cx: &mut TestAppContext) {
    // Salon dont on n'a chargé que les 1 000 derniers messages (numéros 4 000..5 000) : on ajoute 50 plus anciens.
    cx.update(gpui_kit::init);
    let (handle, view) = cx.update(|cx| {
        let bounds = Bounds { origin: Point::default(), size: size(px(1280.), px(800.)) };
        let options = WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() };
        let (window, view) = gpui_kit::open_window(options, cx, |_, cx| {
            cx.new(|cx| {
                let mut proto = TimelineProto::new(1_000, cx);
                proto.rebase_numbers(4_000);
                proto
            })
        })
        .expect("fenêtre de test");
        (window.downcast::<Root>().expect("Root"), view)
    });
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |proto, cx| {
            proto.scroll_to_item(300, cx);
        });
        window.render_frame(cx);
        let before = view.read(cx).scroller().read(cx).logical_scroll_top();
        let top_number = view.read(cx).message_number(before.item_ix).expect("message");

        let added = view.update(cx, |proto, cx| proto.prepend_older(50, cx));
        assert_eq!(added, 50);
        window.render_frame(cx);
        let after = view.read(cx).scroller().read(cx).logical_scroll_top();
        assert_eq!(view.read(cx).len(), 1_050);
        assert_eq!(after.item_ix, before.item_ix + 50, "l'index avance du nombre de lignes ajoutées en tête");
        assert_eq!(view.read(cx).message_number(after.item_ix), Some(top_number), "le même message reste en haut de l'écran");
        assert_eq!(after.offset_in_item, before.offset_in_item, "sans décalage en pixels : pas de saut de lecture");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn appending_follows_the_tail_only_while_the_reader_is_at_the_bottom(cx: &mut TestAppContext) {
    let (handle, view) = open_proto(cx, 300);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert!(view.read(cx).scroller().read(cx).is_following_tail(), "suivi de la fin actif à l'ouverture");

        view.update(cx, |proto, cx| proto.append_newer(3, cx));
        window.render_frame(cx);
        let built = view.read(cx).take_built_rows();
        assert!(built.contains(&302), "le nouveau dernier message est construit : {built:?}");

        // Le lecteur remonte : les nouveaux messages ne le ramènent pas en bas.
        view.update(cx, |proto, cx| {
            proto.scroll_to_item(10, cx);
        });
        window.render_frame(cx);
        view.update(cx, |proto, cx| proto.append_newer(3, cx));
        window.render_frame(cx);
        let scroller = view.read(cx).scroller().read(cx);
        assert!(scroller.is_scrolled_up(), "le lecteur est resté en haut");
        assert_eq!(scroller.logical_scroll_top().item_ix, 10, "l'ancre n'a pas bougé à l'arrivée de messages");
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn rows_have_variable_heights(cx: &mut TestAppContext) {
    let (handle, view) = open_proto(cx, PROTO_MESSAGES);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let built = view.read(cx).take_built_rows();
        let heights: Vec<f32> = built
            .iter()
            .filter_map(|i| window.try_find(format!("proto-row-{i}")))
            .map(|row| f32::from(row.bounds().size.height))
            .collect();
        assert!(heights.len() >= 5, "au moins 5 lignes mesurables ({} sur {})", heights.len(), built.len());
        let mut distinct = heights.clone();
        distinct.sort_by(f32::total_cmp);
        distinct.dedup_by(|a, b| (*a - *b).abs() < 0.5);
        assert!(distinct.len() >= 3, "hauteurs variables attendues, trouvé : {distinct:?}");
    })
    .expect("fenêtre");
}

/// Banc de coût de mise en page **sans GPU** : durée de `render_frame` en plateforme de test, sur un passage complet
/// (200 sauts de 25 messages) puis sur des sauts début ↔ fin. Rapporté, jamais jugé.
///
/// `cargo test -p ui --test timeline_proto --release -- --ignored --nocapture timeline_5000_frame_cost`
#[gpui_kit::test]
#[ignore = "banc de mesure : lancer à la main (voir la doc du test)"]
fn timeline_5000_frame_cost(cx: &mut TestAppContext) {
    let build_started = Instant::now();
    let (handle, view) = open_proto(cx, PROTO_MESSAGES);
    let open_time = build_started.elapsed();
    cx.update_window(handle.into(), |_, window, cx| {
        let first = Instant::now();
        window.render_frame(cx);
        let first_frame = first.elapsed();
        view.read(cx).take_built_rows();

        // 1. Passage complet, 25 messages par frame.
        let (mut frame_times, mut rows) = (Vec::new(), Vec::new());
        for index in (0..PROTO_MESSAGES).step_by(25) {
            view.update(cx, |proto, cx| {
                proto.scroll_to_item(index, cx);
            });
            let started = Instant::now();
            window.render_frame(cx);
            frame_times.push(started.elapsed());
            rows.push(view.read(cx).take_built_rows().len());
        }
        let (median, p95, max) = summarize(&frame_times);
        rows.sort_unstable();
        println!(
            "[W06 banc] ouverture={open_time:?} première_frame={first_frame:?} | passage complet : frames={} render_frame ms médiane={median:.3} p95={p95:.3} max={max:.3} | lignes/frame médiane={} max={}",
            frame_times.len(),
            rows[rows.len() / 2],
            rows.last().copied().unwrap_or(0)
        );

        // 2. Sauts début ↔ fin.
        let mut jump_times = Vec::new();
        for i in 0..100 {
            let end = i % 2 == 0;
            view.update(cx, |proto, cx| {
                if end {
                    proto.scroll_to_end(cx);
                } else {
                    proto.scroll_to_item(0, cx);
                }
            });
            let started = Instant::now();
            window.render_frame(cx);
            jump_times.push(started.elapsed());
        }
        let (median, p95, max) = summarize(&jump_times);
        println!("[W06 banc] sauts début↔fin : frames={} render_frame ms médiane={median:.3} p95={p95:.3} max={max:.3}", jump_times.len());
    })
    .expect("fenêtre");
}
