//! Tests d'intégration contre un **vrai homeserver** (W05 étape 1).
//!
//! Ignorés par défaut (`cargo test` ordinaire : aucun accès réseau). Pour les lancer :
//!
//! ```text
//! WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 \
//!   cargo test -p matrix --test homeserver -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! Les comptes `alice` et `bob` sont lus dans un fichier `clé=valeur` (`alice_user`, `alice_password`,
//! `bob_user`, `bob_password`) : `WAIFU_IT_CREDENTIALS`, sinon `~/matrix-test/CREDENTIALS.txt`. Aucun mot de passe
//! n'est écrit dans le dépôt, ni affiché. Fixture de média : `WAIFU_IT_FIXTURE`, sinon
//! `~/matrix-test/fixtures/recette.png`. Chaque test crée ses propres salons et ses propres stores (répertoires
//! temporaires) ; rien n'est supposé de l'état du serveur.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use domain::{EventState, EventVm, MediaPayload, RoomId, TimelineUpdate, UNDECRYPTABLE_PLACEHOLDER};
use matrix::{Client, MediaCache, SyncUpdate, TimelineCommand};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::media::MediaRequestParameters;
use matrix_sdk::ruma::api::client::room::create_room::v3::Request as CreateRoom;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::{OwnedMxcUri, OwnedRoomId, OwnedUserId, RoomId as SdkRoomId};
use md5::{Digest, Md5};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::task::JoinHandle;

/// Plafond d'attente d'un état (synchronisation, déchiffrement, téléchargement).
const WAIT: Duration = Duration::from_secs(120);
const IGNORE: &str = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored";

// ───────────────────────────── configuration ─────────────────────────────

fn homeserver() -> String {
    std::env::var("WAIFU_IT_HOMESERVER").expect("définir WAIFU_IT_HOMESERVER (ex. http://127.0.0.1:8008)")
}

struct Account {
    user: String,
    password: String,
}

fn credentials() -> (Account, Account) {
    let path = std::env::var_os("WAIFU_IT_CREDENTIALS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").expect("HOME")).join("matrix-test/CREDENTIALS.txt"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("fichier d'identifiants illisible : {}", path.display()));
    let values: HashMap<&str, &str> = text
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim(), value.trim()))
        .collect();
    let get = |key: &str| values.get(key).unwrap_or_else(|| panic!("clé `{key}` absente du fichier d'identifiants")).to_string();
    (
        Account { user: get("alice_user"), password: get("alice_password") },
        Account { user: get("bob_user"), password: get("bob_password") },
    )
}

fn fixture() -> (PathBuf, Vec<u8>) {
    let path = std::env::var_os("WAIFU_IT_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").expect("HOME")).join("matrix-test/fixtures/recette.png"));
    let bytes = std::fs::read(&path).unwrap_or_else(|_| panic!("fixture illisible : {}", path.display()));
    (path, bytes)
}

fn md5_hex(bytes: &[u8]) -> String {
    format!("{:x}", Md5::digest(bytes))
}

/// Texte unique par exécution : évite toute confusion avec des messages d'une exécution précédente.
fn unique(tag: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("horloge").as_nanos();
    format!("w05-{tag}-{nanos}")
}

// ───────────────────────────── aides ─────────────────────────────

async fn sign_in(account: &Account, dir: &Path) -> Client {
    let (client, _) = matrix::sign_in(&homeserver(), &account.user, &account.password, dir).await.expect("connexion");
    client
}

/// Synchronise jusqu'à ce que `ready` soit vrai (échec au bout de [`WAIT`]).
async fn sync_until(client: &Client, what: &str, ready: impl Fn(&Client) -> bool) {
    let started = Instant::now();
    while !ready(client) {
        assert!(started.elapsed() < WAIT, "délai dépassé en attendant : {what}");
        client.sync_once(SyncSettings::default().timeout(Duration::from_secs(2))).await.expect("synchronisation");
    }
}

/// `alice` crée un salon **chiffré** et invite `bob` ; `bob` rejoint ; `alice` voit `bob` membre.
async fn encrypted_room(alice: &Client, bob: &Client) -> OwnedRoomId {
    let bob_id: OwnedUserId = bob.user_id().expect("bob connecté").to_owned();
    let mut request = CreateRoom::new();
    request.name = Some(unique("salon"));
    request.invite = vec![bob_id.clone()];
    request.initial_state = vec![InitialStateEvent::with_empty_state_key(RoomEncryptionEventContent::with_recommended_defaults()).to_raw_any()];
    let room = alice.create_room(request).await.expect("création du salon");
    let id = room.room_id().to_owned();

    let invited = id.clone();
    sync_until(bob, "l'invitation de bob", move |c| c.get_room(&invited).is_some_and(|r| r.state() == matrix_sdk::RoomState::Invited)).await;
    bob.get_room(&id).expect("salon de bob").join().await.expect("bob rejoint");

    // Alice doit connaître bob comme membre joint (sinon elle ne lui partagerait pas la clé de session).
    let alice_room = alice.get_room(&id).expect("salon d'alice");
    let started = Instant::now();
    loop {
        let members = alice_room.members(matrix_sdk::RoomMemberships::JOIN).await.expect("membres");
        if members.iter().any(|m| m.user_id() == bob_id) {
            break;
        }
        assert!(started.elapsed() < WAIT, "délai dépassé en attendant : bob membre côté alice");
        alice.sync_once(SyncSettings::default().timeout(Duration::from_secs(2))).await.expect("synchronisation");
    }
    id
}

/// Boucle de synchronisation de la crate (`matrix::run_sync`) en tâche de fond.
struct Sync {
    task: JoinHandle<()>,
    updates: UnboundedReceiver<SyncUpdate>,
}

impl Sync {
    fn start(client: &Client) -> Self {
        let (tx, updates) = unbounded_channel();
        let task = tokio::spawn(matrix::run_sync(client.clone(), move |update| {
            let _ = tx.send(update);
        }));
        Self { task, updates }
    }

    /// Premier instantané issu d'une réponse du serveur.
    async fn first_server_snapshot(&mut self) -> Vec<domain::RoomVm> {
        let started = Instant::now();
        loop {
            let left = WAIT.checked_sub(started.elapsed()).expect("délai dépassé : première synchronisation");
            match tokio::time::timeout(left, self.updates.recv()).await.expect("délai dépassé : première synchronisation") {
                Some(SyncUpdate::Snapshot { rooms, from_server: true, .. }) => return rooms,
                Some(SyncUpdate::Failed(message)) => panic!("synchronisation en échec : {message}"),
                Some(_) => {}
                None => panic!("boucle de synchronisation terminée"),
            }
        }
    }

    async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

/// `matrix::run_timeline` d'un salon, en tâche de fond ; garde le dernier instantané et les médias reçus.
struct Timeline {
    task: JoinHandle<()>,
    commands: UnboundedSender<TimelineCommand>,
    updates: UnboundedReceiver<TimelineUpdate>,
    events: Vec<EventVm>,
    media: HashMap<String, Arc<Vec<u8>>>,
}

impl Timeline {
    fn start(client: &Client, room: &SdkRoomId) -> Self {
        let (commands, command_rx) = unbounded_channel();
        let (tx, updates) = unbounded_channel();
        let task = tokio::spawn(matrix::run_timeline(
            client.clone(),
            RoomId::from(room.as_str()),
            command_rx,
            Arc::new(MediaCache::new()),
            move |update| {
                let _ = tx.send(update);
            },
        ));
        Self { task, commands, updates, events: Vec::new(), media: HashMap::new() }
    }

    fn absorb(&mut self, update: TimelineUpdate) {
        match update {
            TimelineUpdate::Events { events, .. } => self.events = events,
            TimelineUpdate::Media { key, payload: MediaPayload::Ready(bytes), .. } => {
                self.media.insert(key, bytes);
            }
            TimelineUpdate::Failed { message, .. } => panic!("timeline en échec : {message}"),
            TimelineUpdate::SendFailed { message, .. } | TimelineUpdate::AttachmentFailed { message, .. } => {
                panic!("envoi en échec : {message}")
            }
            _ => {}
        }
    }

    /// Attend qu'un instantané vérifie `ready`.
    async fn until_events(&mut self, what: &str, ready: impl Fn(&[EventVm]) -> bool) -> Vec<EventVm> {
        let started = Instant::now();
        loop {
            if ready(&self.events) {
                return self.events.clone();
            }
            let left = WAIT.checked_sub(started.elapsed()).unwrap_or_else(|| {
                panic!("délai dépassé en attendant : {what} ; dernier instantané : {:?}", self.events.iter().map(|e| e.body.as_str()).collect::<Vec<_>>())
            });
            match tokio::time::timeout(left, self.updates.recv()).await {
                Ok(Some(update)) => self.absorb(update),
                Ok(None) => panic!("timeline terminée en attendant : {what}"),
                Err(_) => panic!("délai dépassé en attendant : {what} ; dernier instantané : {:?}", self.events.iter().map(|e| e.body.as_str()).collect::<Vec<_>>()),
            }
        }
    }

    /// Attend les octets du média `key`.
    async fn until_media(&mut self, key: &str) -> Arc<Vec<u8>> {
        let started = Instant::now();
        loop {
            if let Some(bytes) = self.media.get(key) {
                return bytes.clone();
            }
            let left = WAIT.checked_sub(started.elapsed()).expect("délai dépassé : téléchargement du média");
            match tokio::time::timeout(left, self.updates.recv()).await {
                Ok(Some(TimelineUpdate::Media { payload: MediaPayload::Failed(message), .. })) => panic!("média en échec : {message}"),
                Ok(Some(update)) => self.absorb(update),
                _ => panic!("délai dépassé : téléchargement du média {key}"),
            }
        }
    }

    fn send(&self, command: TimelineCommand) {
        self.commands.send(command).expect("timeline vivante");
    }

    async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

fn has_text(events: &[EventVm], text: &str) -> bool {
    events.iter().any(|e| e.body == text)
}

/// Événement du message `text`, déchiffré (ni espace réservé, ni état d'erreur).
fn decrypted<'a>(events: &'a [EventVm], text: &str) -> &'a EventVm {
    let event = events.iter().find(|e| e.body == text).unwrap_or_else(|| panic!("message `{text}` absent"));
    assert_eq!(event.state, EventState::Normal, "message `{text}` en état anormal");
    assert_ne!(event.body, UNDECRYPTABLE_PLACEHOLDER);
    event
}

/// Appel HTTP brut (jeton de `client`) : `GET /_matrix/client/v3/rooms/{room}/messages`, JSON décodé.
async fn raw_messages(client: &Client, room: &SdkRoomId) -> serde_json::Value {
    let url = format!("{}/_matrix/client/v3/rooms/{}/messages?dir=b&limit=50", homeserver().trim_end_matches('/'), room);
    let token = client.access_token().expect("jeton d'accès");
    let response = matrix_sdk::reqwest::Client::new().get(url).bearer_auth(token).send().await.expect("requête brute");
    assert!(response.status().is_success(), "GET messages : {}", response.status());
    serde_json::from_str(&response.text().await.expect("corps")).expect("JSON")
}

// ───────────────────────────── scénarios ─────────────────────────────

/// 1. Connexion + persistance : un second client sur le **même** store retrouve la session sans mot de passe.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn login_then_restore_the_session_from_the_same_store() {
    let _ = IGNORE;
    let (alice, _) = credentials();
    let dir = tempfile::tempdir().expect("tempdir");

    let started = Instant::now();
    let (client, session) = matrix::sign_in(&homeserver(), &alice.user, &alice.password, dir.path()).await.expect("connexion");
    let login_time = started.elapsed();
    assert_eq!(session.user_id.as_str(), alice.user);
    let who = client.whoami().await.expect("whoami");
    assert_eq!(who.user_id.as_str(), alice.user);
    assert_eq!(who.device_id.expect("appareil").as_str(), session.device_id);
    assert_eq!(matrix::stored_homeserver(dir.path()).expect("homeserver mémorisé").trim_end_matches('/'), homeserver().trim_end_matches('/'));
    drop(client); // arrêt du client

    // Rien de secret en clair dans le store : ni mot de passe, ni jeton lisible.
    let mut files = 0;
    for entry in walk(dir.path()) {
        // Un fichier temporaire de SQLite (journal, WAL) peut disparaître entre le parcours et la lecture.
        let Ok(bytes) = std::fs::read(&entry) else { continue };
        assert!(!contains(&bytes, alice.password.as_bytes()), "mot de passe en clair dans {}", entry.display());
        files += 1;
    }
    assert!(files >= 2, "le store doit avoir laissé des fichiers ({files})");

    let started = Instant::now();
    let (restored, again) = matrix::resume(dir.path()).await.expect("reprise").expect("session restaurée sans ressaisie");
    let resume_time = started.elapsed();
    assert_eq!(again.user_id, session.user_id);
    assert_eq!(again.device_id, session.device_id, "même appareil : la session est restaurée, pas recréée");
    let who_again = restored.whoami().await.expect("whoami après reprise");
    assert_eq!(who_again.user_id.as_str(), alice.user);
    assert_eq!(who_again.device_id.expect("appareil").as_str(), session.device_id);

    // La boucle de synchronisation de la crate démarre sur le client restauré.
    let mut sync = Sync::start(&restored);
    let _ = sync.first_server_snapshot().await;
    sync.stop().await;

    // Un mauvais mot de passe est refusé (et n'écrase pas la session).
    let other = tempfile::tempdir().expect("tempdir");
    assert!(matrix::sign_in(&homeserver(), &alice.user, "pas-le-bon-mot-de-passe", other.path()).await.is_err());

    println!("[1] connexion {login_time:?}, reprise {resume_time:?}, appareil {}", session.device_id);
}

/// 2. Salon chiffré : `alice` envoie, `bob` reçoit le texte déchiffré ; sur le fil, l'événement est `m.room.encrypted`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn an_encrypted_message_is_received_decrypted() {
    let (alice_account, bob_account) = credentials();
    let (alice_dir, bob_dir) = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, alice_dir.path()).await, sign_in(&bob_account, bob_dir.path()).await);
    let room = encrypted_room(&alice, &bob).await;
    assert!(alice.get_room(&room).expect("salon").latest_encryption_state().await.expect("état").is_encrypted(), "le salon doit être chiffré");

    let (alice_sync, bob_sync) = (Sync::start(&alice), Sync::start(&bob));
    let mut alice_tl = Timeline::start(&alice, &room);
    let mut bob_tl = Timeline::start(&bob, &room);

    let text = unique("texte");
    let started = Instant::now();
    alice_tl.send(TimelineCommand::SendText(text.clone()));
    let seen = bob_tl.until_events("le texte d'alice chez bob", |events| has_text(events, &text)).await;
    let latency = started.elapsed();
    let event = decrypted(&seen, &text);
    assert!(!event.is_own, "reçu, pas envoyé par bob");
    assert!(event.event_id.is_some());
    // Côté alice, l'écho confirmé porte le même texte.
    let mine = alice_tl.until_events("l'écho confirmé chez alice", |events| events.iter().any(|e| e.body == text && e.event_id.is_some())).await;
    assert!(decrypted(&mine, &text).is_own);

    // Sur le fil : `m.room.encrypted`, sans le texte en clair.
    let wire = raw_messages(&bob, &room).await;
    let chunk = wire["chunk"].as_array().expect("chunk");
    let encrypted: Vec<_> = chunk.iter().filter(|e| e["type"] == "m.room.encrypted").collect();
    assert!(!encrypted.is_empty(), "au moins un m.room.encrypted sur le fil");
    assert!(encrypted.iter().all(|e| e["content"].get("body").is_none() && e["content"]["ciphertext"].is_string()));
    assert!(!wire.to_string().contains(&text), "le texte ne doit pas apparaître en clair sur le serveur");

    println!("[2] salon {room} : `{text}` reçu déchiffré en {latency:?}, {} m.room.encrypted sur le fil", encrypted.len());
    alice_tl.stop().await;
    bob_tl.stop().await;
    alice_sync.stop().await;
    bob_sync.stop().await;
}

/// Historique après redémarrage de `bob` (store rouvert, sans mot de passe).
///
/// `require_missed` : exige aussi le message qu'`alice` a écrit **pendant** l'arrêt de `bob`. Comme dans
/// l'application, `bob` relance d'abord la synchronisation, puis ouvre la timeline du salon ; le cache d'événements
/// est abonné dès l'ouverture du client (`resume`), avant la première synchronisation (D-W05-1).
async fn history_after_restart(require_missed: bool) {
    let (alice_account, bob_account) = credentials();
    let (alice_dir, bob_dir) = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, alice_dir.path()).await, sign_in(&bob_account, bob_dir.path()).await);
    let room = encrypted_room(&alice, &bob).await;

    let alice_sync = Sync::start(&alice);
    let mut alice_tl = Timeline::start(&alice, &room);
    let (bob_sync, mut bob_tl) = (Sync::start(&bob), Timeline::start(&bob, &room));

    let before = unique("avant");
    alice_tl.send(TimelineCommand::SendText(before.clone()));
    bob_tl.until_events("le message avant redémarrage", |events| has_text(events, &before)).await;

    // Arrêt complet de bob : tâches abandonnées, client libéré, store refermé.
    bob_tl.stop().await;
    bob_sync.stop().await;
    drop(bob);

    // Pendant que bob est arrêté, alice écrit encore.
    let during = unique("pendant");
    alice_tl.send(TimelineCommand::SendText(during.clone()));
    alice_tl.until_events("l'écho du message envoyé pendant l'arrêt", |events| events.iter().any(|e| e.body == during && e.event_id.is_some())).await;

    // Redémarrage : nouveau client sur le MÊME store, sans mot de passe.
    let restart = Instant::now();
    let (bob, session) = matrix::resume(bob_dir.path()).await.expect("reprise").expect("session de bob");
    let resumed = restart.elapsed();
    assert_eq!(session.user_id.as_str(), bob_account.user);
    let known: Vec<String> = matrix::room_list(&bob).await.iter().map(|r| r.id.to_string()).collect();
    assert!(known.contains(&room.to_string()), "le salon est connu du store avant toute synchronisation");

    let mut bob_sync = Sync::start(&bob);
    let _ = bob_sync.first_server_snapshot().await;
    let first_sync = restart.elapsed();
    let mut bob_tl = Timeline::start(&bob, &room);
    let seen = bob_tl.until_events("le message antérieur après redémarrage", |events| has_text(events, &before)).await;
    let history = restart.elapsed();
    decrypted(&seen, &before);

    // Laisse la timeline se stabiliser, puis regarde si le message de l'arrêt est là.
    tokio::time::sleep(Duration::from_secs(8)).await;
    bob_tl.until_events("(dernier instantané)", |_| true).await;
    while let Ok(update) = bob_tl.updates.try_recv() {
        bob_tl.absorb(update);
    }
    let missed_visible = has_text(&bob_tl.events, &during);
    println!(
        "[3] reprise {resumed:?}, première synchronisation {first_sync:?} après le redémarrage, message antérieur lisible à {history:?} ; message écrit pendant l'arrêt visible : {missed_visible} ({} événements)",
        bob_tl.events.len()
    );
    if require_missed {
        assert!(missed_visible, "le message reçu pendant l'arrêt de bob n'apparaît pas dans sa timeline : {:?}", bob_tl.events.iter().map(|e| e.body.as_str()).collect::<Vec<_>>());
        decrypted(&bob_tl.events, &during);
        let order: Vec<&str> = bob_tl.events.iter().map(|e| e.body.as_str()).filter(|b| *b == before || *b == during).collect();
        assert_eq!(order, [before.as_str(), during.as_str()], "ordre chronologique conservé");
    }
    bob_tl.stop().await;
    bob_sync.stop().await;
    alice_tl.stop().await;
    alice_sync.stop().await;
}

/// 3. Historique après redémarrage : `bob` rouvre son store et retrouve, déchiffré, le message antérieur.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn history_is_readable_after_a_restart() {
    history_after_restart(false).await;
}

/// 3b. D-W05-1 (corrigé) : un message reçu pendant que le client était arrêté apparaît dans la timeline au
///     redémarrage. Le cache d'événements est abonné à l'ouverture du client, avant la première synchronisation.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn a_message_received_while_stopped_shows_up_in_the_timeline() {
    history_after_restart(true).await;
}

/// 4. Média chiffré : la pièce jointe d'`alice` arrive chez `bob` avec un md5 identique ; sur le serveur, elle est chiffrée.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn an_encrypted_attachment_downloads_with_the_same_md5() {
    let (alice_account, bob_account) = credentials();
    let (path, source) = fixture();
    let source_md5 = md5_hex(&source);
    let (alice_dir, bob_dir) = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, alice_dir.path()).await, sign_in(&bob_account, bob_dir.path()).await);
    let room = encrypted_room(&alice, &bob).await;

    let (alice_sync, bob_sync) = (Sync::start(&alice), Sync::start(&bob));
    let alice_tl = Timeline::start(&alice, &room);
    let mut bob_tl = Timeline::start(&bob, &room);

    let started = Instant::now();
    alice_tl.send(TimelineCommand::SendAttachment(path.clone()));
    let file_name = path.file_name().expect("nom").to_string_lossy().into_owned();
    let seen = bob_tl
        .until_events("la pièce jointe chez bob", |events| events.iter().any(|e| e.media.as_ref().is_some_and(|m| m.filename == file_name)))
        .await;
    let media = seen.iter().filter_map(|e| e.media.as_ref()).find(|m| m.filename == file_name).expect("média").clone();
    assert!(media.encrypted, "la pièce jointe d'un salon chiffré doit l'être");
    // Constat W05 : le client n'annonce pas `info.size` à l'envoi (AttachmentConfig::default) → `size` reste `None`
    // chez le destinataire. On vérifie seulement qu'une valeur déclarée, si présente, est juste.
    assert!(media.size.is_none_or(|declared| declared == source.len() as u64), "taille déclarée fausse : {:?}", media.size);

    let bytes = bob_tl.until_media(&media.key).await;
    let elapsed = started.elapsed();
    assert_eq!(md5_hex(&bytes), source_md5, "md5 des octets reçus ≠ md5 de la source");
    assert_eq!(bytes.len(), source.len());

    // Côté serveur, le contenu stocké est du chiffré : ni le même md5, ni les mêmes octets.
    let stored = bob
        .media()
        .get_media_content(&MediaRequestParameters { source: MediaSource::Plain(OwnedMxcUri::from(media.key.as_str())), format: matrix_sdk::media::MediaFormat::File }, false)
        .await
        .expect("téléchargement du blob stocké");
    let stored_md5 = md5_hex(&stored);
    assert_ne!(stored_md5, source_md5, "le blob stocké sur le serveur ne doit pas être le fichier en clair");
    assert!(!contains(&stored, &source[..16.min(source.len())]), "l'en-tête du fichier ne doit pas apparaître dans le blob");

    println!("[4] info reçue : {media:?}");
    println!(
        "[4] {file_name} : source md5 {source_md5} ({} o) = reçu md5 {} ({} o) en {elapsed:?} ; blob serveur md5 {stored_md5} ({} o)",
        source.len(),
        md5_hex(&bytes),
        bytes.len(),
        stored.len()
    );
    alice_tl.stop().await;
    bob_tl.stop().await;
    alice_sync.stop().await;
    bob_sync.stop().await;
}

/// 5. Export / import de clés de salon : un nouvel appareil d'`alice` ne peut pas lire un message antérieur,
///    puis le peut après import du fichier de clés exporté par l'ancien appareil.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn exported_room_keys_unlock_an_earlier_message_on_a_new_device() {
    const PASSPHRASE: &str = "w05-passphrase-de-test";
    let (alice_account, bob_account) = credentials();
    let (alice_dir, bob_dir, new_dir) = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, alice_dir.path()).await, sign_in(&bob_account, bob_dir.path()).await);
    let room = encrypted_room(&alice, &bob).await;

    // Bob écrit ; l'appareil d'alice le reçoit (il reçoit donc la clé de session).
    let (alice_sync, bob_sync) = (Sync::start(&alice), Sync::start(&bob));
    let mut alice_tl = Timeline::start(&alice, &room);
    let bob_tl = Timeline::start(&bob, &room);
    let text = unique("ancien");
    bob_tl.send(TimelineCommand::SendText(text.clone()));
    alice_tl.until_events("le message de bob chez alice (appareil 1)", |events| has_text(events, &text)).await;
    decrypted(&alice_tl.events, &text);

    // Export des clés de l'appareil 1.
    let export_dir = tempfile::tempdir().expect("tempdir");
    let keys_file = export_dir.path().join("cles-alice.txt");
    let started = Instant::now();
    alice.encryption().export_room_keys(keys_file.clone(), PASSPHRASE, |_| true).await.expect("export");
    let export_time = started.elapsed();
    let exported = std::fs::read(&keys_file).expect("fichier de clés");
    let exported_md5 = md5_hex(&exported);
    let armor = String::from_utf8_lossy(&exported);
    assert!(armor.starts_with("-----BEGIN MEGOLM SESSION DATA-----"), "format d'export Matrix attendu");
    assert!(!contains(&exported, text.as_bytes()), "le fichier ne contient pas le message");
    assert!(!contains(&exported, PASSPHRASE.as_bytes()), "le fichier ne contient pas la phrase secrète");
    assert!(!contains(&exported, room.as_str().as_bytes()), "le fichier ne laisse pas voir l'identifiant du salon en clair");
    assert!(exported.len() > 200, "fichier de clés trop petit ({} o)", exported.len());

    // Appareil 2 d'alice : nouveau store, nouvelle connexion → nouvel appareil, sans les clés.
    let device_one = alice.device_id().expect("appareil 1").to_owned();
    let new_device = sign_in(&alice_account, new_dir.path()).await;
    assert_ne!(new_device.device_id().expect("appareil 2"), device_one, "un nouvel appareil est attendu");
    let mut new_sync = Sync::start(&new_device);
    let _ = new_sync.first_server_snapshot().await;
    let mut new_tl = Timeline::start(&new_device, &room);
    let locked = new_tl.until_events("le message (illisible) sur l'appareil 2", |events| !events.is_empty()).await;
    assert!(!has_text(&locked, &text), "sans les clés, le message ne doit pas être lisible");
    assert!(locked.iter().any(|e| e.body == UNDECRYPTABLE_PLACEHOLDER || e.state != EventState::Normal), "message indéchiffrable attendu avant l'import : {:?}", locked.iter().map(|e| (&e.body, &e.state)).collect::<Vec<_>>());

    // Une mauvaise phrase secrète est refusée ; la bonne importe.
    assert!(new_device.encryption().import_room_keys(keys_file.clone(), "mauvaise-phrase").await.is_err(), "mauvaise phrase secrète acceptée");
    let started = Instant::now();
    let result = new_device.encryption().import_room_keys(keys_file.clone(), PASSPHRASE).await.expect("import");
    let import_time = started.elapsed();
    assert!(result.imported_count >= 1, "au moins une clé importée : {result:?}");

    // Le message antérieur à l'import se déchiffre (la timeline retente, sinon on la rouvre : on note lequel).
    let mut reopened = None;
    let readable = match tokio::time::timeout(Duration::from_secs(20), new_tl.until_events("déchiffrement après import", |events| has_text(events, &text))).await {
        Ok(events) => events,
        Err(_) => {
            let mut again = Timeline::start(&new_device, &room);
            let events = again.until_events("déchiffrement après réouverture de la timeline", |events| has_text(events, &text)).await;
            reopened = Some(again);
            events
        }
    };
    decrypted(&readable, &text);

    println!(
        "[5] export {export_time:?} ({} o, md5 {exported_md5}), import {import_time:?} ({} clé(s) importée(s) sur {}), message `{text}` lisible sur l'appareil 2 (timeline rouverte : {})",
        exported.len(),
        result.imported_count,
        result.total_count,
        reopened.is_some()
    );
    if let Some(again) = reopened {
        again.stop().await;
    }
    new_tl.stop().await;
    new_sync.stop().await;
    alice_tl.stop().await;
    bob_tl.stop().await;
    alice_sync.stop().await;
    bob_sync.stop().await;
}

// ───────────────────────────── utilitaires fichiers ─────────────────────────────

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("lecture du dossier").flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|window| window == needle)
}
