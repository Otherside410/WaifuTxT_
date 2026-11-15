//! Boucle de synchronisation de fond : à chaque réponse du serveur, publie un instantané lisible
//! par l'UI (salons + état des clés). À lancer sur le runtime Tokio, jamais sur le thread UI.

use domain::{KeyStatus, RoomVm};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::{Client, LoopCtrl};

use crate::error::MatrixError;
use crate::recovery::key_status;
use crate::rooms::room_list;

/// Ce que la boucle publie.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncUpdate {
    /// Première synchronisation faite ou mise à jour : l'état du client est exploitable.
    Snapshot { rooms: Vec<RoomVm>, keys: KeyStatus },
    /// Erreur de synchronisation, message lisible.
    Failed(String),
}

/// Synchronise en continu jusqu'à interruption (la tâche est abandonnée au logout).
/// `publish` est appelé après chaque réponse ; il doit être non bloquant.
pub async fn run_sync(client: Client, publish: impl Fn(SyncUpdate)) {
    let result = client
        .sync_with_result_callback(SyncSettings::default(), |response| {
            let client = client.clone();
            let publish = &publish;
            async move {
                match response {
                    Ok(_) => publish(SyncUpdate::Snapshot {
                        rooms: room_list(&client).await,
                        keys: key_status(&client),
                    }),
                    Err(err) => publish(SyncUpdate::Failed(MatrixError::from(err).to_string())),
                }
                Ok(LoopCtrl::Continue)
            }
        })
        .await;

    // La boucle ne se termine que sur erreur fatale : on l'annonce plutôt que de rester muet.
    let message = match result {
        Ok(()) => "Synchronisation interrompue.".to_owned(),
        Err(err) => MatrixError::from(err).to_string(),
    };
    publish(SyncUpdate::Failed(message));
}
