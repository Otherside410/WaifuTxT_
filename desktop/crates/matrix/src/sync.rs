//! Boucle de synchronisation de fond : publie un instantané lisible par l'UI (salons + état des clés).
//! À lancer sur le runtime Tokio, jamais sur le thread UI.
//!
//! Le **premier** instantané est lu dans le store local et publié avant toute requête réseau (D5/S2) : les
//! salons déjà connus s'affichent tout de suite, même serveur arrêté. Les réponses du serveur le remplacent
//! ensuite, et une coupure est annoncée **une fois** (puis la boucle réessaie seule, le SDK espaçant les essais).

use std::sync::atomic::{AtomicBool, Ordering};

use domain::{KeyStatus, Presence, RoomVm};
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
    /// Présence d'un utilisateur (`m.presence`), reçue dans la réponse `/sync` ou lue dans le store au démarrage.
    /// Un message par utilisateur : l'UI ne met à jour que celui-là.
    Presence { user_id: String, state: Presence },
}

/// Présences portées par des événements `m.presence` bruts. Un événement illisible est ignoré (jamais d'erreur :
/// l'absence de pastille est le repli).
pub fn presence_updates(
    events: &[matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::presence::PresenceEvent>],
) -> Vec<SyncUpdate> {
    events
        .iter()
        .filter_map(|raw| raw.deserialize().ok())
        .map(|event| SyncUpdate::Presence {
            user_id: event.sender.to_string(),
            state: Presence::from_matrix(event.content.presence.as_str()),
        })
        .collect()
}

/// Présences déjà connues du store local pour les membres des salons rejoints, publiées avant la première réponse
/// du serveur (même principe que l'instantané initial : aucun accès réseau).
async fn stored_presence(client: &Client) -> Vec<SyncUpdate> {
    use matrix_sdk::RoomMemberships;
    let mut ids = std::collections::BTreeSet::new();
    for room in client.joined_rooms() {
        if let Ok(members) = room.members_no_sync(RoomMemberships::JOIN).await {
            ids.extend(members.into_iter().map(|member| member.user_id().to_owned()));
        }
    }
    let ids: Vec<_> = ids.into_iter().collect();
    match client.state_store().get_presence_events(&ids).await {
        Ok(raws) => presence_updates(&raws),
        Err(_) => Vec::new(),
    }
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
    // Le cache d'événements doit être abonné avant la première synchronisation (D-W05-1). C'est déjà fait par
    // `login` / `restore` ; ce second appel est idempotent et couvre un client connecté par un autre chemin.
    if let Err(err) = crate::client::enable_event_cache(&client).await {
        publish(SyncUpdate::Failed(err.to_string()));
        return;
    }
    // Point d'émission initial : AVANT le premier appel réseau.
    publish(local_snapshot(&client).await);
    for update in stored_presence(&client).await {
        publish(update);
    }

    let offline = AtomicBool::new(false);
    let result = client
        .sync_with_result_callback(SyncSettings::default(), |response| {
            let client = client.clone();
            let publish = &publish;
            let offline = &offline;
            async move {
                match response {
                    Ok(response) => {
                        offline.store(false, Ordering::SeqCst);
                        // Présence : événements de la réponse `/sync` (un message par utilisateur).
                        for update in presence_updates(&response.presence) {
                            publish(update);
                        }
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
    fn raw_presence(user: &str, state: &str) -> matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::presence::PresenceEvent> {
        matrix_sdk::ruma::serde::Raw::from_json_string(format!(
            r#"{{"type":"m.presence","sender":"{user}","content":{{"presence":"{state}","currently_active":true}}}}"#
        ))
        .expect("json")
    }

    /// Réception réelle impossible sans homeserver : le chemin est prouvé en injectant des événements `m.presence`
    /// bruts (la forme exacte de `/sync`) dans la fonction que la boucle appelle sur `response.presence`.
    #[test]
    fn raw_presence_events_become_one_update_per_user_and_garbage_is_ignored() {
        let garbage = matrix_sdk::ruma::serde::Raw::from_json_string(r#"{"type":"m.presence","content":{}}"#.to_owned()).expect("json");
        let updates = presence_updates(&[
            raw_presence("@a:x", "online"),
            raw_presence("@b:x", "unavailable"),
            raw_presence("@c:x", "offline"),
            garbage,
        ]);
        assert_eq!(
            updates,
            vec![
                SyncUpdate::Presence { user_id: "@a:x".into(), state: Presence::Online },
                SyncUpdate::Presence { user_id: "@b:x".into(), state: Presence::Unavailable },
                SyncUpdate::Presence { user_id: "@c:x".into(), state: Presence::Offline },
            ]
        );
    }

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
