//! Fenêtre de test partagée par les tests de rendu (étapes 3 et 4).
#![allow(dead_code)]

use gpui_kit::{
    AppContext, Bounds, Entity, Point, TestAppContext, WindowBounds, WindowHandle, WindowOptions,
    base::Root, px, size,
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
