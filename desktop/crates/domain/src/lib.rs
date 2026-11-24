//! Types purs du domaine WaifuChat : aucune I/O, aucune dépendance.

use std::fmt;

mod connection;
mod event;
mod media;
mod recovery;
mod room;
mod session;

pub use connection::ConnectionState;
pub use event::{
    apply_edit, last_read_marker, Presence, merge_events, prepare_message, read_by_label, redact_event,
    typing_label, Applied, EventState, EventVm, FailedAction, MergeOutcome, SendFailure,
    remember_recent_emoji, ReactionVm, TimelineState, TimelineStatus, TimelineUpdate, TypingThrottle,
    MAX_RECENT_EMOJIS, QUICK_EMOJIS, REDACTED_PLACEHOLDER,
    TYPING_IDLE_MS, TYPING_RESEND_MS, UNDECRYPTABLE_PLACEHOLDER,
};
pub use media::{
    avatar_key,
    fit_within, format_size, media_display, sniff_image_format, too_large_message, ImageKind,
    MediaDisplay, MediaKind, MediaLoad, MediaPayload, MediaStatus, MediaVm, MAX_INLINE_IMAGE_BYTES,
    MAX_UPLOAD_BYTES, MEDIA_UNAVAILABLE, THUMBNAIL_SIDE, TOO_LARGE_PREFIX,
};
pub use recovery::{validate_recovery_key, KeyStatus, RecoveryKey};
pub use room::{initials, sort_rooms, RoomKind, RoomVm};
pub use session::{validate_login, LoginField, LoginRequest, Session, ValidationError};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            /// Identifiant sous sa forme textuelle Matrix.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

string_id! {
    /// Identifiant de salon Matrix (`!abc:server`).
    RoomId
}
string_id! {
    /// Identifiant d'événement Matrix (`$abc`).
    EventId
}
string_id! {
    /// Identifiant d'utilisateur Matrix (`@alice:server`).
    UserId
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_returns_original_string() {
        assert_eq!(RoomId::from("!r:example.org").to_string(), "!r:example.org");
        assert_eq!(EventId::from("$e").to_string(), "$e");
        assert_eq!(UserId::from("@u:example.org").as_str(), "@u:example.org");
    }

    #[test]
    fn ids_compare_by_value() {
        assert_eq!(UserId::from("@a:b"), UserId::from("@a:b"));
        assert_ne!(UserId::from("@a:b"), UserId::from("@c:b"));
    }
}
