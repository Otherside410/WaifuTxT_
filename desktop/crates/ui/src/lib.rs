//! Vues GPUI de WaifuChat. Aucune logique réseau : une vue reçoit son état, elle ne va pas le chercher.

pub mod demo;
pub mod login;
pub mod main_view;
pub mod modal;
pub mod theme;
pub mod theme_gpui;
pub mod timeline_proto;

pub use login::{initial_homeserver, LoginEvent, LoginView, DEFAULT_HOMESERVER};
pub use main_view::{
    classify_pick, KeyHandoff, MainEvent, MainView, PickResult, RoomsState, EVENT_ROW_HEIGHT,
    PICKER_UNAVAILABLE,
};
pub use modal::ModalState;
pub use theme::{AccentChoice, ThemeMode, WaifuTheme};
pub use theme_gpui::{install as install_theme, Palette};
pub use timeline_proto::{generate_messages, summarize, BenchReport, ProtoBody, ProtoMessage, TimelineBench, TimelineProto, PROTO_MESSAGES};
