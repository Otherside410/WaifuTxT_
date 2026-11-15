//! Aides de test : un store local « déjà connu » fabriqué **sans réseau** (session enregistrée + deux salons).

use std::path::{Path, PathBuf};

use matrix_sdk::ruma::{device_id, room_id, user_id};
use matrix_sdk::{RoomInfo, RoomState, SessionMeta, SessionTokens, StateChanges};

use crate::client::{open_stored_client, remember_homeserver, save_session};

/// Homeserver qui ne répond jamais : le port 1 de la boucle locale refuse la connexion aussitôt.
pub(crate) const DEAD_HOMESERVER: &str = "http://127.0.0.1:1";

pub(crate) fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("waifu-matrix-offline-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Écrit dans `data_dir` ce que laisse une vraie connexion : session dans le store chiffré, homeserver
/// mémorisé, deux salons joints. Aucun accès réseau (jeton factice, serveur inexistant).
pub(crate) async fn seed_store(data_dir: &Path, homeserver: &str) {
    let client = open_stored_client(homeserver, data_dir).await.expect("client hors ligne");
    let session = matrix_sdk::authentication::matrix::MatrixSession {
        meta: SessionMeta {
            user_id: user_id!("@alice:localhost").to_owned(),
            device_id: device_id!("RECETTEOFFLINE").to_owned(),
        },
        tokens: SessionTokens { access_token: "jeton-de-test-factice".to_owned(), refresh_token: None },
    };
    save_session(&client, &session).await.expect("session enregistrée");
    remember_homeserver(&client, data_dir).expect("homeserver mémorisé");

    let mut changes = StateChanges::new("s_local_1".to_owned());
    changes.add_room(RoomInfo::new(room_id!("!un:localhost"), RoomState::Joined));
    changes.add_room(RoomInfo::new(room_id!("!deux:localhost"), RoomState::Joined));
    client.state_store().save_changes(&changes).await.expect("salons enregistrés");
}
