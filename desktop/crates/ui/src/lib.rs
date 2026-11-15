//! Vues GPUI de WaifuChat. Aucune logique réseau : une vue reçoit son état, elle ne va pas le chercher.

pub mod login;
pub mod main_view;
pub mod modal;

pub use login::{LoginEvent, LoginView};
pub use main_view::{KeyHandoff, MainEvent, MainView, RoomsState};
pub use modal::ModalState;
