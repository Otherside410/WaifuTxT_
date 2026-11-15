//! Vues GPUI de WaifuChat. Aucune logique réseau : une vue reçoit son état, elle ne va pas le chercher.

pub mod login;

pub use login::{LoginEvent, LoginView};
