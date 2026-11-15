//! Seule crate qui parle à `matrix-sdk` (client, sync, salons, timeline, envoi, médias).
//!
//! Étape 2 : construction du client, connexion, restauration et déconnexion. Dépend de `domain`.

pub mod client;
pub mod error;

pub use client::{
    build_client, login, logout, remember_homeserver, restore, resume, sign_in, stored_homeserver,
};
pub use matrix_sdk::Client;
pub use error::{MatrixError, Result};
