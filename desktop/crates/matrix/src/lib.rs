//! Seule crate qui parle à `matrix-sdk` (client, sync, salons, timeline, envoi, médias).
//!
//! Étape 2 : client, connexion, restauration, déconnexion. Étape 3 : synchronisation, salons, clés de récupération. Dépend de `domain`.

pub mod client;
pub mod error;
pub mod media;
pub mod recovery;
pub mod rooms;
pub mod sync;
pub mod timeline;

#[cfg(test)]
mod test_support;

pub use client::{
    build_client, login, logout, open_stored_client, purge_local_session, remember_homeserver, restore, resume, sign_in, stored_homeserver,
};
pub use matrix_sdk::Client;
pub use error::{MatrixError, Result};
pub use media::{MediaCache, MediaError};
pub use recovery::{key_status, recover};
pub use rooms::room_list;
pub use sync::{local_snapshot, run_sync, SyncUpdate};
pub use timeline::{run_timeline, TimelineCommand, PAGE_SIZE};
