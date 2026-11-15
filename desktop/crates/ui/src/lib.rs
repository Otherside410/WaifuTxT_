//! Vues GPUI de WaifuChat. Aucune logique réseau : une vue reçoit son état, elle ne va pas le chercher.

pub mod demo;
pub mod login;
pub mod main_view;
pub mod modal;

pub use login::{initial_homeserver, LoginEvent, LoginView, DEFAULT_HOMESERVER};
pub use main_view::{
    classify_pick, KeyHandoff, MainEvent, MainView, PickResult, RoomsState, EVENT_ROW_HEIGHT,
    PICKER_UNAVAILABLE,
};
pub use modal::ModalState;
