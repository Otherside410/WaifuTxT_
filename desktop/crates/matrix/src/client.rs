//! Construction du client, connexion, restauration et déconnexion.
//!
//! Persistance : le store SQLite (état + crypto) est chiffré par une phrase secrète aléatoire
//! générée au premier lancement et gardée dans `session/store.key` (permissions 0600). Le jeton
//! d'accès vit **dans** ce store chiffré (valeur personnalisée), jamais dans un fichier en clair.
//! Aucun mot de passe ni jeton n'est journalisé.
//!
//! Limite connue : la phrase secrète est un fichier local, pas encore le trousseau système
//! (prévu par ARCHITECTURE.md §3).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use domain::{Session, UserId};
use matrix_sdk::authentication::matrix::MatrixSession;
use matrix_sdk::Client;

use crate::error::{MatrixError, Result};

/// Sous-dossier de `data_dir` contenant le store SQLite et les fichiers de session.
const SESSION_DIR: &str = "session";
const KEY_FILE: &str = "store.key";
const HOMESERVER_FILE: &str = "homeserver";
/// Clé de la valeur personnalisée du store qui contient la session sérialisée.
const SESSION_KEY: &[u8] = b"waifu.matrix_session";
const DEVICE_NAME: &str = "WaifuChat (natif)";

fn session_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SESSION_DIR)
}

#[cfg(unix)]
fn private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path)
}

#[cfg(not(unix))]
fn private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(contents.as_bytes())
}

/// Lit la phrase secrète du store, ou en génère une (32 octets aléatoires, en hexadécimal).
fn store_passphrase(dir: &Path) -> Result<String> {
    let path = dir.join(KEY_FILE);
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim().to_owned();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| MatrixError::Storage(e.to_string()))?;
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    write_private(&path, &key)?;
    Ok(key)
}

/// Homeserver mémorisé par la dernière connexion, pour reconstruire le client au démarrage.
pub fn stored_homeserver(data_dir: &Path) -> Option<String> {
    let value = fs::read_to_string(session_dir(data_dir).join(HOMESERVER_FILE)).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// Construit un client dont l'état et la crypto sont dans `data_dir/session` (SQLite chiffré).
///
/// `homeserver` : nom de serveur (`matrix.org`, résolu par `.well-known`) ou URL `http(s)://…`.
/// Contacte le serveur pour vérifier qu'il existe : à appeler hors du thread UI.
pub async fn build_client(homeserver: &str, data_dir: &Path) -> Result<Client> {
    let homeserver = homeserver.trim();
    if homeserver.is_empty() {
        return Err(MatrixError::InvalidHomeserver);
    }
    let dir = session_dir(data_dir);
    private_dir(&dir)?;
    let passphrase = store_passphrase(&dir)?;

    let client = Client::builder()
        .server_name_or_homeserver_url(homeserver)
        .sqlite_store(&dir, Some(&passphrase))
        .build()
        .await?;
    Ok(client)
}

fn to_session(client: &Client, session: &MatrixSession) -> Session {
    Session {
        user_id: UserId::from(session.meta.user_id.as_str()),
        device_id: session.meta.device_id.to_string(),
        homeserver: client.homeserver().to_string(),
    }
}

/// Connexion par mot de passe ; persiste la session (jeton dans le store chiffré).
pub async fn login(client: &Client, user: &str, password: &str) -> Result<Session> {
    client
        .matrix_auth()
        .login_username(user, password)
        .initial_device_display_name(DEVICE_NAME)
        .send()
        .await?;

    let session = client
        .matrix_auth()
        .session()
        .ok_or_else(|| MatrixError::Other("session absente après connexion".to_owned()))?;

    let json = serde_json::to_vec(&session).map_err(|e| MatrixError::Storage(e.to_string()))?;
    client
        .state_store()
        .set_custom_value(SESSION_KEY, json)
        .await
        .map_err(|e| MatrixError::Storage(e.to_string()))?;

    Ok(to_session(client, &session))
}

/// Mémorise le homeserver résolu pour le prochain démarrage (non secret).
pub fn remember_homeserver(client: &Client, data_dir: &Path) -> Result<()> {
    let dir = session_dir(data_dir);
    private_dir(&dir)?;
    write_private(&dir.join(HOMESERVER_FILE), client.homeserver().as_str())?;
    Ok(())
}

/// Restaure la session persistée, sans mot de passe. `Ok(None)` s'il n'y en a pas.
pub async fn restore(client: &Client) -> Result<Option<Session>> {
    let stored = client
        .state_store()
        .get_custom_value(SESSION_KEY)
        .await
        .map_err(|e| MatrixError::Storage(e.to_string()))?;
    let Some(bytes) = stored else {
        return Ok(None);
    };
    let session: MatrixSession = serde_json::from_slice(&bytes)
        .map_err(|_| MatrixError::Storage("session enregistrée illisible".to_owned()))?;

    client.restore_session(session.clone()).await?;
    Ok(Some(to_session(client, &session)))
}

/// Déconnecte côté serveur (échec réseau toléré) puis purge la session locale de `data_dir`.
pub async fn logout(client: &Client, data_dir: &Path) -> Result<()> {
    // Hors ligne ou jeton déjà invalide : on purge quand même le local.
    let _ = client.matrix_auth().logout().await;
    let dir = session_dir(data_dir);
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Connexion complète : construit le client, se connecte, mémorise le homeserver.
pub async fn sign_in(
    homeserver: &str,
    user: &str,
    password: &str,
    data_dir: &Path,
) -> Result<(Client, Session)> {
    let client = build_client(homeserver, data_dir).await?;
    let session = login(&client, user, password).await?;
    remember_homeserver(&client, data_dir)?;
    Ok((client, session))
}

/// Reprise au démarrage : `Ok(None)` s'il n'y a pas de session enregistrée.
pub async fn resume(data_dir: &Path) -> Result<Option<(Client, Session)>> {
    let Some(homeserver) = stored_homeserver(data_dir) else {
        return Ok(None);
    };
    let client = build_client(&homeserver, data_dir).await?;
    Ok(restore(&client).await?.map(|session| (client, session)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("waifu-matrix-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn passphrase_is_generated_then_reused_with_private_mode() {
        let dir = temp_dir("pass");
        private_dir(&dir).expect("dossier");
        let first = store_passphrase(&dir).expect("génération");
        assert_eq!(first.len(), 64);
        assert_eq!(store_passphrase(&dir).expect("relecture"), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(KEY_FILE)).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stored_homeserver_is_none_without_file() {
        assert_eq!(stored_homeserver(&temp_dir("none")), None);
    }

    #[tokio::test]
    async fn build_client_rejects_empty_homeserver() {
        let dir = temp_dir("empty");
        assert!(matches!(build_client("  ", &dir).await, Err(MatrixError::InvalidHomeserver)));
    }

    #[tokio::test]
    async fn build_client_fails_cleanly_on_unknown_host() {
        let dir = temp_dir("nohost");
        let err = build_client("https://waifu-test.invalid", &dir).await.expect_err("hôte inexistant");
        assert!(
            matches!(err, MatrixError::Unreachable | MatrixError::BadServerResponse),
            "erreur inattendue : {err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn build_client_rejects_garbage_url() {
        let dir = temp_dir("garbage");
        assert!(build_client("http://", &dir).await.is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
