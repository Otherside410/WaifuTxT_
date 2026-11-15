//! Rendu headless de l'écran principal : la fenêtre est réelle (GPUI de test), sans affichage ni réseau.
//! Les éléments sont retrouvés par identifiant ; le texte dessiné n'est pas énumérable par l'API de
//! test, donc chaque élément clé porte un identifiant et un libellé d'accessibilité.

use gpui_kit::test::TestWindowExt;
use gpui_kit::{
    AppContext, Bounds, Point, TestAppContext, WindowBounds, WindowOptions, base::Root, px, size,
};
use ui::MainView;

fn open_main(cx: &mut TestAppContext, demo: bool) -> gpui_kit::WindowHandle<Root> {
    cx.update(gpui_kit::init);
    cx.update(|cx| {
        let bounds = Bounds { origin: Point::default(), size: size(px(1200.), px(800.)) };
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        };
        let (window, _view) = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| {
                if demo {
                    MainView::demo(window, cx)
                } else {
                    MainView::new("@test:local".to_owned(), window, cx)
                }
            })
        })
        .expect("fenêtre de test");
        window.downcast::<Root>().expect("Root")
    })
}

#[gpui_kit::test]
fn demo_shows_sidebar_three_rooms_and_the_key_modal(cx: &mut TestAppContext) {
    let handle = open_main(cx, true);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);

        let sidebar = window.find("sidebar");
        assert_eq!(sidebar.label(), Some("Salons"));
        assert!(sidebar.visible());

        // Espace, salon, DM : dans cet ordre, de haut en bas.
        let rows: Vec<_> = ["room-0", "room-1", "room-2"].into_iter().map(|id| window.find(id)).collect();
        assert_eq!(rows[0].label(), Some("Démo Serveur"));
        assert_eq!(rows[1].label(), Some("général"));
        assert_eq!(rows[2].label(), Some("Alice Demo"));
        assert!(rows[0].bounds().origin.y < rows[1].bounds().origin.y);
        assert!(rows[1].bounds().origin.y < rows[2].bounds().origin.y);
        assert!(window.try_find("room-3").is_none(), "exactement 3 salons");

        // La barre latérale est à gauche, ses lignes sont dedans.
        let sidebar_right = sidebar.bounds().origin.x + sidebar.bounds().size.width;
        assert!(rows.iter().all(|r| r.bounds().origin.x + r.bounds().size.width <= sidebar_right));

        // Modal de clé de récupération ouvert, avec son champ et ses deux boutons.
        assert!(window.find("recovery-modal").visible());
        assert!(window.try_find("recovery-key").is_some());
        assert!(window.try_find("recovery-submit").is_some());
        assert!(window.try_find("recovery-cancel").is_some());

        // Pas d'état « synchronisation… » : la liste est affichée.
        assert!(window.try_find("rooms-state").is_none());
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn cancel_closes_the_modal_and_it_can_be_reopened(cx: &mut TestAppContext) {
    let handle = open_main(cx, true);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        window.click("recovery-cancel", cx);
        window.render_frame(cx);
        assert!(window.try_find("recovery-modal").is_none(), "le modal doit être fermé");

        // Le bouton de réouverture est proposé tant que les clés manquent.
        assert!(window.try_find("recovery-open").is_some());
        window.click("recovery-open", cx);
        window.render_frame(cx);
        assert!(window.try_find("recovery-modal").is_some(), "le modal doit se rouvrir");
        window.click("recovery-cancel", cx);
        window.render_frame(cx);
        assert!(window.try_find("recovery-modal").is_none());
    })
    .expect("fenêtre");
}

#[gpui_kit::test]
fn before_first_sync_the_list_says_syncing_instead_of_being_empty(cx: &mut TestAppContext) {
    let handle = open_main(cx, false);
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(window.find("rooms-state").label(), Some("Synchronisation…"));
        assert!(window.try_find("room-0").is_none());
        assert!(window.try_find("recovery-modal").is_none(), "pas de modal sans clé requise");
        assert!(window.try_find("recovery-open").is_none(), "pas de bouton tant que rien n'exige de clé");
    })
    .expect("fenêtre");
}
