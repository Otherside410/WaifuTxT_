//! Erreurs de la couche Matrix, avec des messages lisibles dans l'UI (jamais de secret dedans).

use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::{ClientBuildError, HttpError};

pub type Result<T> = std::result::Result<T, MatrixError>;

#[derive(Debug, thiserror::Error)]
pub enum MatrixError {
    #[error("Adresse de homeserver invalide.")]
    InvalidHomeserver,
    #[error("Homeserver injoignable (réseau, DNS ou TLS) : vérifie l'adresse et ta connexion.")]
    Unreachable,
    #[error("Identifiant ou mot de passe incorrect.")]
    InvalidCredentials,
    #[error("Trop de tentatives : réessaie dans un moment.")]
    RateLimited,
    #[error("Réponse inattendue du serveur : ce n'est peut-être pas un homeserver Matrix.")]
    BadServerResponse,
    #[error("Clé de récupération incorrecte ou illisible.")]
    InvalidRecoveryKey,
    #[error("Stockage local inutilisable : {0}")]
    Storage(String),
    #[error("Erreur inattendue : {0}")]
    Other(String),
}

impl From<std::io::Error> for MatrixError {
    fn from(err: std::io::Error) -> Self {
        Self::Storage(err.kind().to_string())
    }
}

impl From<ClientBuildError> for MatrixError {
    fn from(err: ClientBuildError) -> Self {
        match err {
            ClientBuildError::MissingHomeserver
            | ClientBuildError::InvalidServerName
            | ClientBuildError::Url(_) => Self::InvalidHomeserver,
            ClientBuildError::Http(err) => Self::from(err),
            ClientBuildError::AutoDiscovery(_) | ClientBuildError::WellKnownLookupDisabled => {
                Self::BadServerResponse
            }
            ClientBuildError::SqliteStore(err) => Self::Storage(err.to_string()),
            other => Self::Other(other.to_string()),
        }
    }
}

impl From<HttpError> for MatrixError {
    fn from(err: HttpError) -> Self {
        match err.client_api_error_kind() {
            Some(ErrorKind::Forbidden | ErrorKind::UserDeactivated) => Self::InvalidCredentials,
            Some(ErrorKind::LimitExceeded(_)) => Self::RateLimited,
            Some(ErrorKind::Unauthorized | ErrorKind::UnknownToken(_)) => Self::InvalidCredentials,
            Some(_) => Self::Other("le serveur a refusé la requête".to_owned()),
            None => match err {
                HttpError::Reqwest(_) => Self::Unreachable,
                _ => Self::BadServerResponse,
            },
        }
    }
}

impl From<matrix_sdk::Error> for MatrixError {
    fn from(err: matrix_sdk::Error) -> Self {
        match err {
            matrix_sdk::Error::Http(err) => Self::from(*err),
            other => Self::Other(other.to_string()),
        }
    }
}
