//! Fenêtre de test partagée par les tests de rendu (étapes 3 et 4).
#![allow(dead_code)]

use gpui_kit::test::TestWindowExt;
use gpui_kit::{
    AppContext, Bounds, Entity, Point, TestAppContext, WindowBounds, WindowHandle, WindowOptions,
    base::Root, px, size, SharedString, Window,
};
use ui::MainView;

/// Ouvre `MainView` dans une fenêtre headless 1200×800 : en démonstration (`demo`) ou en mode réel
/// (sans client : rien n'est émis vers un réseau, les événements `MainEvent` n'ont pas d'abonné).
pub fn open_main(cx: &mut TestAppContext, demo: bool) -> (WindowHandle<Root>, Entity<MainView>) {
    cx.update(gpui_kit::init);
    cx.update(|cx| {
        let bounds = Bounds { origin: Point::default(), size: size(px(1200.), px(800.)) };
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let (window, view) = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| {
                if demo {
                    MainView::demo(window, cx)
                } else {
                    MainView::new("@test:local".to_owned(), window, cx)
                }
            })
        })
        .expect("fenêtre de test");
        (window.downcast::<Root>().expect("Root"), view)
    })
}

const MAX_EVENTS_PROBED: usize = 400;

/// Identifiant d'accessibilité de la ligne `index` (propriétaire : l'id ne doit pas emprunter).
pub fn row_id(index: usize) -> SharedString {
    SharedString::from(format!("event-{index}"))
}

/// Indices des lignes `event-N` actuellement rendues (virtualisation : seulement les visibles).
pub fn rendered_rows(window: &Window) -> Vec<usize> {
    (0..MAX_EVENTS_PROBED)
        .filter(|i| window.try_find(row_id(*i)).is_some())
        .collect()
}

/// Ligne rendue la plus haute : `(libellé, ordonnée)`.
pub fn top_row(window: &Window) -> (String, f32) {
    let rows = rendered_rows(window);
    let first = *rows.first().expect("au moins une ligne rendue");
    let snapshot = window.find(row_id(first));
    (snapshot.label().unwrap_or_default().to_owned(), f32::from(snapshot.bounds().origin.y))
}

pub fn close_modal_and_open(cx: &mut TestAppContext, handle: gpui_kit::WindowHandle<gpui_kit::base::Root>, room: &'static str) {
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("recovery-cancel", cx);
        window.render_frame(cx);
        window.click(room, cx);
        window.render_frame(cx);
    })
    .expect("fenêtre");
    cx.run_until_parked();
}

