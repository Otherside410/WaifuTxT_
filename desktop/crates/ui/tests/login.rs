//! Écran de connexion (D4) : aucun homeserver public proposé par défaut.

mod common;

use common::open_login;
use gpui_kit::test::TestWindowExt;
use gpui_kit::{AppContext, TestAppContext};
use ui::{initial_homeserver, DEFAULT_HOMESERVER};

const PUBLIC_HOMESERVERS: [&str; 3] = ["matrix.org", "matrix-client.matrix.org", "element.io"];

fn homeserver_value(cx: &mut TestAppContext, last: Option<&'static str>) -> String {
    let (handle, _view) = open_login(cx, last);
    let mut value = String::new();
    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        value = window.find("login-homeserver").value().unwrap_or_default().to_owned();
    })
    .expect("fenêtre");
    value
}

#[gpui_kit::test]
fn with_an_empty_store_the_homeserver_field_is_empty_and_never_a_public_domain(cx: &mut TestAppContext) {
    // La constante et l'aide : échouent si un défaut public réapparaît.
    assert!(DEFAULT_HOMESERVER.is_empty(), "défaut public réapparu : {DEFAULT_HOMESERVER:?}");
    assert!(initial_homeserver(None).is_empty());

    let value = homeserver_value(cx, None);
    assert!(value.is_empty(), "champ initial : {value:?}");
    for public in PUBLIC_HOMESERVERS {
        assert!(!value.contains(public), "domaine public pré-rempli : {public}");
    }
}

#[gpui_kit::test]
fn with_a_stored_homeserver_that_one_is_proposed(cx: &mut TestAppContext) {
    assert_eq!(initial_homeserver(Some("http://localhost:8008")), "http://localhost:8008");
    assert_eq!(homeserver_value(cx, Some("http://localhost:8008")), "http://localhost:8008");
}

#[gpui_kit::test]
fn a_blank_stored_value_is_treated_as_no_store(cx: &mut TestAppContext) {
    assert_eq!(homeserver_value(cx, Some("   ")), "");
}
