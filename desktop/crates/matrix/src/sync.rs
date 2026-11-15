//! Boucle de synchronisation de fond : publie un instantané lisible par l'UI (salons + état des clés).
//! À lancer sur le runtime Tokio, jamais sur le thread UI.
//!
//! Le **premier** instantané est lu dans le store local et publié avant toute requête réseau (D5/S2) : les
//! salons déjà connus s'affichent tout de suite, même serveur arrêté. Les réponses du serveur le remplacent
//! ensuite, et une coupure est annoncée **une fois** (puis la boucle réessaie seule, le SDK espaçant les essais).

use std::sync::atomic::{AtomicBool, Ordering};

use domain::{KeyStatus, RoomVm};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::{Client, LoopCtrl};

use crate::error::MatrixError;
use crate::recovery::key_status;
use crate::rooms::room_list;

/// Ce que la boucle publie.
#[derive(Debug, Clone, PartialEq)]
pub enum SyncUpdate {
    /// Instantané des salons et des clés. `from_server` : `false` pour l'instantané initial, lu dans le store
    /// local avant toute réponse du serveur ; `true` pour un instantané issu d'une réponse de synchronisation.
    Snapshot { rooms: Vec<RoomVm>, keys: KeyStatus, from_server: bool },
    /// Le serveur ne répond pas (ou la synchronisation a échoué) : message lisible. Publié une fois par coupure ;
    /// le retour du serveur est annoncé par le prochain `Snapshot { from_server: true, .. }`.
    Failed(String),
}

/// Instantané initial, lu dans le store local (aucun accès réseau).
pub async fn local_snapshot(client: &Client) -> SyncUpdate {
    SyncUpdate::Snapshot { rooms: room_list(client).await, keys: key_status(client), from_server: false }
}

async fn server_snapshot(client: &Client) -> SyncUpdate {
    SyncUpdate::Snapshot { rooms: room_list(client).await, keys: key_status(client), from_server: true }
}

/// Synchronise en continu jusqu'à interruption (la tâche est abandonnée au logout).
/// `publish` est appelé pour l'instantané initial puis après chaque réponse ; il doit être non bloquant.
pub async fn run_sync(client: Client, publish: impl Fn(SyncUpdate)) {
    // Point d'émission initial : AVANT le premier appel réseau.
    publish(local_snapshot(&client).await);

    let offline = AtomicBool::new(false);
    let result = client
        .sync_with_result_callback(SyncSettings::default(), |response| {
            let client = client.clone();
            let publish = &publish;
            let offline = &offline;
            async move {
                match response {
                    Ok(_) => {
                        offline.store(false, Ordering::SeqCst);
                        publish(server_snapshot(&client).await);
                    }
                    Err(err) => {
                        // Une seule annonce par coupure : le SDK réessaie en boucle, on ne spamme pas l'UI.
                        if !offline.swap(true, Ordering::SeqCst) {
                            publish(SyncUpdate::Failed(MatrixError::from(err).to_string()));
                        }
                    }
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::client::resume;
    use crate::test_support::{seed_store, temp_dir, DEAD_HOMESERVER};

    async fn offline_client(name: &str) -> (Client, std::path::PathBuf) {
        let dir = temp_dir(name);
        seed_store(&dir, DEAD_HOMESERVER).await;
        let (client, _) = resume(&dir).await.expect("reprise hors ligne").expect("session");
        (client, dir)
    }

    /// D5/S2 : le premier instantané est publié AVANT toute réponse du serveur (ici : il n'y en aura jamais).
    /// Échoue si l'émission initiale de `run_sync` est retirée : le premier message serait alors `Failed`.
    #[tokio::test]
    async fn the_first_snapshot_comes_from_the_local_store_before_any_server_answer() {
        let (client, dir) = offline_client("sync-first").await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(run_sync(client, move |update| {
            let _ = tx.send(update);
        }));

        let first = tokio::time::timeout(Duration::from_millis(1500), rx.recv())
            .await
            .expect("un premier instantané doit arriver sans attendre le serveur")
            .expect("canal ouvert");
        match first {
            SyncUpdate::Snapshot { rooms, from_server, .. } => {
                assert!(!from_server, "l'instantané initial vient du store, pas du serveur");
                assert_eq!(rooms.len(), 2, "les salons déjà connus sont publiés tout de suite");
            }
            other => panic!("le premier message doit être l'instantané local, pas {other:?}"),
        }
        task.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// La coupure est annoncée **une seule fois** (la boucle réessaie seule, sans inonder l'UI), après l'instantané.
    #[tokio::test]
    async fn an_unreachable_server_is_announced_once_after_the_local_snapshot() {
        let (client, dir) = offline_client("sync-once").await;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(run_sync(client, move |update| {
            let _ = tx.send(update);
        }));

        let first = rx.recv().await.expect("premier message");
        assert!(matches!(first, SyncUpdate::Snapshot { from_server: false, .. }));
        let second = tokio::time::timeout(Duration::from_secs(15), rx.recv())
            .await
            .expect("la coupure doit être annoncée")
            .expect("canal ouvert");
        match second {
            SyncUpdate::Failed(message) => assert!(!message.is_empty(), "message lisible"),
            other => panic!("attendu une annonce de coupure, obtenu {other:?}"),
        }
        // Plusieurs tentatives ont lieu pendant ce temps : aucune nouvelle annonce.
        let extra = tokio::time::timeout(Duration::from_secs(4), rx.recv()).await;
        assert!(extra.is_err(), "la coupure ne doit pas être répétée : {extra:?}");
        task.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
