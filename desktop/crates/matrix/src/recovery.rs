//! Restauration des clés (Secret Storage / 4S) via `client.encryption().recovery()`.
//!
//! La clé de récupération est consommée par `recover` et n'est ni journalisée ni persistée.

use domain::{KeyStatus, RecoveryKey};
use matrix_sdk::encryption::recovery::{RecoveryError, RecoveryState};
use matrix_sdk::Client;

use crate::error::{MatrixError, Result};

/// État actuel des clés, lu localement (aucun appel réseau).
///
/// `Disabled` (pas de Secret Storage) et `Enabled` (secrets déjà présents) n'exigent rien : un compte
/// sans chiffrement fonctionne sans jamais demander de clé.
pub fn key_status(client: &Client) -> KeyStatus {
    map_state(client.encryption().recovery().state())
}

fn map_state(state: RecoveryState) -> KeyStatus {
    match state {
        RecoveryState::Unknown => KeyStatus::Unknown,
        RecoveryState::Enabled | RecoveryState::Disabled => KeyStatus::NotNeeded,
        RecoveryState::Incomplete => KeyStatus::Needed,
    }
}

/// Déverrouille le Secret Storage avec la clé de récupération et importe les secrets sur cet appareil.
pub async fn recover(client: &Client, key: RecoveryKey) -> Result<()> {
    let outcome = client.encryption().recovery().recover(key.expose()).await;
    drop(key);
    outcome.map_err(MatrixError::from)
}

impl From<RecoveryError> for MatrixError {
    fn from(err: RecoveryError) -> Self {
        match err {
            RecoveryError::Sdk(err) => Self::from(err),
            RecoveryError::BackupExistsOnServer => {
                Self::Other("une sauvegarde existe déjà sur le serveur".to_owned())
            }
            // Message volontairement fixe : on n'affiche rien venant de l'erreur du SDK, qui pourrait
            // citer la saisie.
            RecoveryError::SecretStorage(_) => Self::InvalidRecoveryKey,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_incomplete_recovery_asks_for_a_key() {
        assert_eq!(map_state(RecoveryState::Unknown), KeyStatus::Unknown);
        assert_eq!(map_state(RecoveryState::Enabled), KeyStatus::NotNeeded);
        assert_eq!(map_state(RecoveryState::Disabled), KeyStatus::NotNeeded);
        assert_eq!(map_state(RecoveryState::Incomplete), KeyStatus::Needed);
    }

    #[test]
    fn invalid_key_message_is_fixed_and_key_free() {
        let message = MatrixError::InvalidRecoveryKey.to_string();
        assert_eq!(message, "Clé de récupération incorrecte ou illisible.");
    }
}
