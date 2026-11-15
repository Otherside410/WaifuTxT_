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

/// Abonne le cache d'événements du client aux réponses de synchronisation (D-W05-1).
///
/// À faire **avant** la première synchronisation : tout événement reçu avant l'abonnement n'est pas gardé, et la
/// pagination de la timeline repart après lui. Mais **pas avant** que la machine crypto existe (c'est-à-dire avant
/// la connexion ou la restauration de la session) : la tâche de rechiffrement du cache s'arrête pour de bon si elle
/// ne trouve pas la machine à son démarrage (matrix-sdk 0.19.1, `Redecryptor::redecryption_loop`), et plus aucun
/// message indéchiffrable ne serait relu après une réception de clés ou un import. Sans machine, la fonction ne fait
/// donc rien et renvoie `Ok(())` ; l'appelant la rappelle une fois connecté.
///
/// `EventCache::subscribe` (matrix-sdk 0.19.1) renvoie `Result<()>` et ne fait rien si l'abonnement existe déjà
/// (`OnceCell`) : appeler cette fonction plusieurs fois est sans effet et sans erreur. Elle ne peut échouer que si le
/// client a déjà été libéré.
pub(crate) async fn enable_event_cache(client: &Client) -> Result<()> {
    if client.encryption().room_keys_received_stream().await.is_none() {
        return Ok(());
    }
    client
        .event_cache()
        .subscribe()
        .map_err(|err| MatrixError::from(matrix_sdk::Error::from(err)))
}

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

/// Rouvre le client d'une session **déjà enregistrée**, sans aucun accès réseau.
///
/// `homeserver_url` est l'URL **résolue** mémorisée par la connexion (voir [`remember_homeserver`]). On utilise
/// `ClientBuilder::homeserver_url`, qui n'interroge pas le serveur, et non `server_name_or_homeserver_url` :
/// ce dernier fait, dans `build()`, une requête de vérification (`/_matrix/client/versions`, et `.well-known`
/// pour un nom de serveur), donc échoue serveur arrêté alors que la session est sur disque (D5/S1). Le serveur
/// n'est contacté qu'ensuite, par la boucle de synchronisation, qui réessaie toute seule.
pub async fn open_stored_client(homeserver_url: &str, data_dir: &Path) -> Result<Client> {
    let homeserver_url = homeserver_url.trim();
    if homeserver_url.is_empty() {
        return Err(MatrixError::InvalidHomeserver);
    }
    let dir = session_dir(data_dir);
    private_dir(&dir)?;
    let passphrase = store_passphrase(&dir)?;

    let client = Client::builder()
        .homeserver_url(homeserver_url)
        .sqlite_store(&dir, Some(&passphrase))
        .build()
        .await?;
    Ok(client)
}

/// Enregistre la session dans le store chiffré du client (valeur personnalisée), sans la journaliser.
pub(crate) async fn save_session(client: &Client, session: &MatrixSession) -> Result<()> {
    let json = serde_json::to_vec(session).map_err(|e| MatrixError::Storage(e.to_string()))?;
    client
        .state_store()
        .set_custom_value(SESSION_KEY, json)
        .await
        .map_err(|e| MatrixError::Storage(e.to_string()))?;
    Ok(())
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

    save_session(client, &session).await?;
    enable_event_cache(client).await?;

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
    enable_event_cache(client).await?;
    Ok(Some(to_session(client, &session)))
}

/// Supprime la session locale : store SQLite (état **et clés E2EE locales**), phrase secrète du store
/// et homeserver mémorisé. Sans effet si rien n'existe.
pub fn purge_local_session(data_dir: &Path) -> Result<()> {
    match fs::remove_dir_all(session_dir(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Déconnecte côté serveur (échec réseau toléré) puis purge la session locale, clés comprises.
pub async fn logout(client: &Client, data_dir: &Path) -> Result<()> {
    // Hors ligne ou jeton déjà invalide : on purge quand même le local.
    let _ = client.matrix_auth().logout().await;
    purge_local_session(data_dir)
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

/// Reprise au démarrage : `Ok(None)` s'il n'y a pas de session enregistrée. **Ne touche pas au réseau** :
/// une session valide sur disque s'ouvre serveur arrêté ; la synchronisation rattrape ensuite (D5/S1).
pub async fn resume(data_dir: &Path) -> Result<Option<(Client, Session)>> {
    let Some(homeserver) = stored_homeserver(data_dir) else {
        return Ok(None);
    };
    let client = open_stored_client(&homeserver, data_dir).await?;
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

    /// D5/S1 : une session valide sur disque s'ouvre **serveur injoignable**, vite, avec les salons du store.
    ///
    /// Échoue si `resume` repasse par `build_client` (`server_name_or_homeserver_url`) : cette voie contacte le
    /// serveur avant de restaurer la session, la reprise renverrait `Err` (connexion refusée) et `expect` casserait ;
    /// avec un serveur muet au lieu de refusé, la durée dépasserait largement le plafond.
    ///
    /// Mesure : ouvrir un store chiffré par phrase secrète coûte du **calcul**, pas du réseau (PBKDF2, 200 000
    /// tours par base : mesuré ~5 s en profil debug, ~0,5 s sans phrase secrète). On mesure donc d'abord ce coût
    /// incompressible (`open_stored_client` seul, même store) et on exige que la reprise complète n'y ajoute pas
    /// plus de 2 s : tout accès réseau fautif (délai de connexion, relances) fait exploser cette différence.
    #[tokio::test]
    async fn a_stored_session_opens_offline_in_under_two_seconds_with_the_rooms_of_the_store() {
        use crate::rooms::room_list;
        use crate::test_support::{seed_store, temp_dir, DEAD_HOMESERVER};

        let dir = temp_dir("resume");
        seed_store(&dir, DEAD_HOMESERVER).await;

        let started = std::time::Instant::now();
        drop(open_stored_client(DEAD_HOMESERVER, &dir).await.expect("ouverture du store"));
        let store_cost = started.elapsed();

        let started = std::time::Instant::now();
        let (client, session) = resume(&dir)
            .await
            .expect("la reprise ne doit pas exiger le réseau")
            .expect("une session est enregistrée");
        let elapsed = started.elapsed();
        let extra = elapsed.saturating_sub(store_cost);
        assert!(
            extra < std::time::Duration::from_secs(2),
            "reprise en {elapsed:?} dont {store_cost:?} de dérivation de clé : {extra:?} de trop (> 2 s)"
        );
        assert_eq!(session.user_id.as_str(), "@alice:localhost");
        assert_eq!(session.homeserver.trim_end_matches('/'), DEAD_HOMESERVER);

        let mut ids: Vec<String> =
            room_list(&client).await.iter().map(|room| room.id.to_string()).collect();
        ids.sort();
        assert_eq!(ids, ["!deux:localhost", "!un:localhost"], "salons du store local");
        let _ = fs::remove_dir_all(&dir);
    }

    /// D-W05-1 : le cache d'événements est abonné dès que la session est restaurée (avant toute synchronisation),
    /// pas avant (sans machine crypto, la tâche de rechiffrement du SDK s'arrêterait pour de bon), et s'abonner de
    /// nouveau est sans effet ni erreur (retour en ligne, ouverture d'un salon).
    ///
    /// Échoue si l'appel est retiré de `restore` : `has_subscribed()` serait faux après `resume`.
    #[tokio::test]
    async fn the_event_cache_is_subscribed_once_the_session_is_restored_and_resubscribing_is_harmless() {
        use crate::test_support::{seed_store, temp_dir, DEAD_HOMESERVER};

        let dir = temp_dir("event-cache");
        seed_store(&dir, DEAD_HOMESERVER).await;

        // Client ouvert mais session pas encore restaurée : pas de machine crypto, donc on n'abonne pas.
        let opened = open_stored_client(DEAD_HOMESERVER, &dir).await.expect("ouverture du store");
        enable_event_cache(&opened).await.expect("sans machine crypto : sans effet, sans erreur");
        assert!(!opened.event_cache().has_subscribed(), "pas d'abonnement avant la restauration de la session");
        drop(opened);

        let (client, _) = resume(&dir).await.expect("reprise hors ligne").expect("session enregistrée");
        assert!(client.event_cache().has_subscribed(), "abonné dès la reprise, avant toute synchronisation");
        for _ in 0..3 {
            enable_event_cache(&client).await.expect("un nouvel abonnement n'est pas une erreur");
        }
        client.event_cache().subscribe().expect("l'appel direct du SDK reste un succès");
        assert!(client.event_cache().has_subscribed());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn without_a_stored_session_resume_still_returns_none_offline() {
        use crate::test_support::{temp_dir, DEAD_HOMESERVER};
        let dir = temp_dir("nosession");
        // Un homeserver mémorisé mais aucune session dans le store : pas de reprise, pas d'erreur réseau.
        private_dir(&session_dir(&dir)).expect("dossier");
        write_private(&session_dir(&dir).join(HOMESERVER_FILE), DEAD_HOMESERVER).expect("fichier");
        assert!(resume(&dir).await.expect("pas d'erreur").is_none());
        let _ = fs::remove_dir_all(&dir);
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
    fn purge_removes_store_key_and_homeserver_and_is_idempotent() {
        let dir = temp_dir("purge");
        let session = session_dir(&dir);
        private_dir(&session).expect("dossier");
        for name in [KEY_FILE, HOMESERVER_FILE, "matrix-sdk-crypto.sqlite3"] {
            fs::write(session.join(name), "x").expect("fichier");
        }
        purge_local_session(&dir).expect("purge");
        assert!(!session.exists());
        assert_eq!(stored_homeserver(&dir), None);
        purge_local_session(&dir).expect("seconde purge sans effet");
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
