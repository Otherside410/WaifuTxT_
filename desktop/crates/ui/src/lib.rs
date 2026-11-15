//! Vues GPUI de WaifuChat. Aucune logique réseau : une vue reçoit son état, elle ne va pas le chercher.

pub mod demo;
pub mod login;
pub mod main_view;
pub mod modal;

pub use login::{LoginEvent, LoginView};
pub use main_view::{KeyHandoff, MainEvent, MainView, RoomsState, EVENT_ROW_HEIGHT};
pub use modal::ModalState;
