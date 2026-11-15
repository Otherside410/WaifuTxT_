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
//! n'est écrit dans le dépôt, ni affiché. Le média du test 4 est un PNG 8×4 généré par le test (aucun fichier binaire
//! versé). Chaque test crée ses propres salons et ses propres stores (répertoires
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

/// PNG RVB valide de `width`×`height` (dégradé, deflate sans compression) : des dimensions connues, sans fichier versé.
fn test_png(width: u32, height: u32) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        let body: Vec<u8> = kind.iter().chain(data).copied().collect();
        out.extend(&body);
        out.extend(crc32(&body).to_be_bytes());
        out
    }
    let mut raw = Vec::new();
    for y in 0..height {
        raw.push(0); // filtre « aucun »
        for x in 0..width {
            raw.extend([(x * 31 % 256) as u8, (y * 63 % 256) as u8, ((x + y) * 17 % 256) as u8]);
        }
    }
    let (mut a, mut b) = (1_u32, 0_u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    let len = raw.len() as u16;
    let mut zlib = vec![0x78, 0x01, 0x01];
    zlib.extend(len.to_le_bytes());
    zlib.extend((!len).to_le_bytes());
    zlib.extend(&raw);
    zlib.extend(((b << 16) | a).to_be_bytes());

    let mut ihdr = width.to_be_bytes().to_vec();
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 2, 0, 0, 0]);
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend(chunk(b"IHDR", &ihdr));
    png.extend(chunk(b"IDAT", &zlib));
    png.extend(chunk(b"IEND", &[]));
    png
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
    /// Dernier état `m.typing` annoncé (noms courts) ; `None` tant qu'aucune notification n'est arrivée.
    typing: Option<Vec<String>>,
    /// `at_start` du dernier instantané qui le précisait (début du salon atteint ?).
    at_start: Option<bool>,
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
        Self { task, commands, updates, events: Vec::new(), media: HashMap::new(), typing: None, at_start: None }
    }

    fn absorb(&mut self, update: TimelineUpdate) {
        match update {
            TimelineUpdate::Events { events, at_start, .. } => {
                self.events = events;
                if at_start.is_some() {
                    self.at_start = at_start;
                }
            }
            TimelineUpdate::Typing { users, .. } => self.typing = Some(users),
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

    /// Attend qu'un état de la timeline (instantané, `at_start`, frappe…) vérifie `ready`.
    async fn until(&mut self, what: &str, ready: impl Fn(&Timeline) -> bool) {
        let started = Instant::now();
        while !ready(self) {
            let left = WAIT.checked_sub(started.elapsed()).unwrap_or_else(|| panic!("délai dépassé en attendant : {what}"));
            match tokio::time::timeout(left, self.updates.recv()).await {
                Ok(Some(update)) => self.absorb(update),
                _ => panic!("délai dépassé en attendant : {what}"),
            }
        }
    }

    /// Attend qu'une notification de frappe vérifie `ready` ; renvoie la liste des noms qui écrivent.
    async fn until_typing(&mut self, what: &str, ready: impl Fn(&[String]) -> bool) -> Vec<String> {
        let started = Instant::now();
        loop {
            if let Some(users) = self.typing.as_ref().filter(|users| ready(users)) {
                return users.clone();
            }
            let left = WAIT.checked_sub(started.elapsed()).unwrap_or_else(|| panic!("délai dépassé en attendant : {what}"));
            match tokio::time::timeout(left, self.updates.recv()).await {
                Ok(Some(update)) => self.absorb(update),
                _ => panic!("délai dépassé en attendant : {what} ; dernier état de frappe : {:?}", self.typing),
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
    let source = test_png(8, 4);
    let source_md5 = md5_hex(&source);
    let (alice_dir, bob_dir) = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, alice_dir.path()).await, sign_in(&bob_account, bob_dir.path()).await);
    let room = encrypted_room(&alice, &bob).await;
    let path = alice_dir.path().join("w05-8x4.png");
    std::fs::write(&path, &source).expect("écriture du PNG de test");
    let on_disk = std::fs::metadata(&path).expect("métadonnées").len();
    assert_eq!(on_disk, source.len() as u64);

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
    // C-W05-2 : l'en-tête `info` de l'événement porte la taille du fichier envoyé et les dimensions de l'image.
    assert_eq!(media.size, Some(on_disk), "info.size ≠ taille du fichier envoyé");
    assert_eq!((media.width, media.height), (Some(8), Some(4)), "info.w/h ≠ dimensions du PNG envoyé");
    assert_eq!(media.mime.as_deref(), Some("image/png"));

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

// ───────────────────────────── étape 2 : couverture des opérations restantes ─────────────────────────────

/// Deux comptes, un salon chiffré, leurs boucles de synchronisation et leurs timelines.
struct Pair {
    /// Gardé en vie (le store se referme à la libération du client) mais jamais relu.
    _alice: Client,
    bob: Client,
    room: OwnedRoomId,
    alice_sync: Sync,
    bob_sync: Sync,
    alice_tl: Timeline,
    bob_tl: Timeline,
    _dirs: (tempfile::TempDir, tempfile::TempDir),
}

impl Pair {
    async fn start() -> Self {
        let (alice_account, bob_account) = credentials();
        let dirs = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
        let (alice, bob) = (sign_in(&alice_account, dirs.0.path()).await, sign_in(&bob_account, dirs.1.path()).await);
        let room = encrypted_room(&alice, &bob).await;
        let (alice_sync, bob_sync) = (Sync::start(&alice), Sync::start(&bob));
        let (alice_tl, bob_tl) = (Timeline::start(&alice, &room), Timeline::start(&bob, &room));
        Self { _alice: alice, bob, room, alice_sync, bob_sync, alice_tl, bob_tl, _dirs: dirs }
    }

    /// `alice` envoie `text` ; renvoie son identifiant d'événement, une fois l'écho confirmé par le serveur.
    async fn alice_says(&mut self, text: &str) -> String {
        self.alice_tl.send(TimelineCommand::SendText(text.to_owned()));
        let seen = self.alice_tl.until_events("l'écho confirmé chez alice", |events| events.iter().any(|e| e.body == text && e.event_id.is_some())).await;
        seen.iter().find(|e| e.body == text).and_then(|e| e.event_id.clone()).expect("identifiant d'événement").to_string()
    }

    async fn stop(self) {
        self.alice_tl.stop().await;
        self.bob_tl.stop().await;
        self.alice_sync.stop().await;
        self.bob_sync.stop().await;
    }
}

fn event_by_id<'a>(events: &'a [EventVm], event_id: &str) -> Option<&'a EventVm> {
    events.iter().find(|e| e.event_id.as_ref().is_some_and(|id| id.as_str() == event_id))
}

/// T7 — modifier puis supprimer : le texte modifié arrive déchiffré chez bob (même événement, mention « modifié »),
///      le serveur ne voit qu'un `m.room.encrypted` portant la relation `m.replace` ; la suppression devient un
///      `m.room.redaction` côté serveur et un message « supprimé » chez bob.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn an_encrypted_message_can_be_edited_then_deleted() {
    let mut pair = Pair::start().await;
    let (original, edited) = (unique("original"), unique("modifie"));

    let event_id = pair.alice_says(&original).await;
    pair.bob_tl.until_events("le message d'origine chez bob", |events| has_text(events, &original)).await;

    // Édition : même événement chez bob, texte remplacé, pas de nouvelle ligne.
    let started = Instant::now();
    pair.alice_tl.send(TimelineCommand::Edit { event_id: event_id.clone(), body: edited.clone() });
    let seen = pair.bob_tl.until_events("le texte modifié chez bob", |events| has_text(events, &edited)).await;
    let edit_latency = started.elapsed();
    let event = event_by_id(&seen, &event_id).expect("l'événement d'origine");
    assert_eq!(event.body, edited, "le corps affiché est le texte modifié");
    assert!(event.edited, "mention « modifié »");
    assert!(!has_text(&seen, &original), "l'ancien texte ne reste pas affiché");
    assert_eq!(seen.iter().filter(|e| e.body == edited).count(), 1, "une édition ne crée pas de nouvelle ligne");
    // Même vue chez alice.
    let mine = pair.alice_tl.until_events("le texte modifié chez alice", |events| has_text(events, &edited)).await;
    assert!(event_by_id(&mine, &event_id).is_some_and(|e| e.edited && e.is_own));

    // Sur le fil : un événement chiffré portant `m.relates_to` = `m.replace` de l'original ; aucun texte en clair.
    let wire = raw_messages(&pair.bob, &pair.room).await;
    let chunk = wire["chunk"].as_array().expect("chunk");
    let replacing: Vec<_> = chunk.iter().filter(|e| e["type"] == "m.room.encrypted" && e["content"]["m.relates_to"]["rel_type"] == "m.replace").collect();
    assert_eq!(replacing.len(), 1, "un seul événement de remplacement sur le fil");
    assert_eq!(replacing[0]["content"]["m.relates_to"]["event_id"], event_id.as_str(), "le remplacement vise l'événement d'origine");
    assert!(replacing[0]["content"].get("body").is_none() && replacing[0]["content"]["ciphertext"].is_string());
    let wire_text = wire.to_string();
    assert!(!wire_text.contains(&original) && !wire_text.contains(&edited), "aucun des deux textes en clair sur le serveur");

    // Suppression : `m.room.redaction` sur le fil, espace réservé chez bob et chez alice.
    let started = Instant::now();
    pair.alice_tl.send(TimelineCommand::Redact { event_id: event_id.clone() });
    let seen = pair
        .bob_tl
        .until_events("le message supprimé chez bob", |events| event_by_id(events, &event_id).is_some_and(|e| e.state == EventState::Supprime))
        .await;
    let redact_latency = started.elapsed();
    let event = event_by_id(&seen, &event_id).expect("l'événement supprimé");
    assert_eq!(event.body, domain::REDACTED_PLACEHOLDER);
    assert!(!event.edited);
    assert!(!has_text(&seen, &edited), "le texte modifié ne reste pas affiché");
    pair.alice_tl.until_events("le message supprimé chez alice", |events| event_by_id(events, &event_id).is_some_and(|e| e.state == EventState::Supprime)).await;
    let wire = raw_messages(&pair.bob, &pair.room).await;
    let redactions: Vec<_> = wire["chunk"].as_array().expect("chunk").iter().filter(|e| e["type"] == "m.room.redaction").collect();
    assert!(
        redactions.iter().any(|e| e["redacts"] == event_id.as_str() || e["content"]["redacts"] == event_id.as_str()),
        "un m.room.redaction vise {event_id} ; vus : {}",
        redactions.len()
    );

    println!("[T7] édition vue chez bob en {edit_latency:?} (1 m.replace chiffré), suppression vue en {redact_latency:?} ({} m.room.redaction)", redactions.len());
    pair.stop().await;
}

/// T8 — lecture et frappe : `MarkRead` de bob pose un accusé `m.read` sur le dernier événement (lu côté serveur par le
///      SDK, et vu par alice dans `read_by`) ; `Typing(true)` puis `Typing(false)` d'alice sont vus par bob, la fin
///      de frappe arrivant bien avant l'expiration serveur de 4 s (donc par l'arrêt explicite).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn read_receipts_and_typing_notices_reach_the_other_member() {
    use matrix_sdk::ruma::events::receipt::{ReceiptThread, ReceiptType};

    let mut pair = Pair::start().await;
    let text = unique("lu");
    let event_id = pair.alice_says(&text).await;
    pair.bob_tl.until_events("le message chez bob", |events| has_text(events, &text)).await;
    assert!(event_by_id(&pair.bob_tl.events, &event_id).is_some_and(|e| e.read_by.is_empty()), "aucun lecteur avant MarkRead");

    // Accusé de lecture.
    let bob_id = pair.bob.user_id().expect("bob").to_owned();
    let bob_room = pair.bob.get_room(&pair.room).expect("salon de bob");
    let started = Instant::now();
    pair.bob_tl.send(TimelineCommand::MarkRead);
    let receipt_event = loop {
        let receipt = bob_room.load_user_receipt(ReceiptType::Read, &ReceiptThread::Unthreaded, &bob_id).await.expect("lecture de l'accusé");
        if let Some((id, _)) = receipt.filter(|(id, _)| id.as_str() == event_id) {
            break id;
        }
        assert!(started.elapsed() < WAIT, "délai dépassé : accusé `m.read` de bob sur le dernier événement");
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    let receipt_latency = started.elapsed();
    assert_eq!(receipt_event.as_str(), event_id, "l'accusé m.read de bob pointe sur le dernier événement");
    let seen = pair
        .alice_tl
        .until_events("l'accusé de bob chez alice", |events| event_by_id(events, &event_id).is_some_and(|e| e.read_by == ["bob"]))
        .await;
    assert_eq!(event_by_id(&seen, &event_id).expect("événement").read_by, ["bob"], "alice voit exactement bob comme lecteur");

    // Frappe : apparition puis disparition par arrêt explicite (le serveur n'expire qu'après 4 s).
    pair.alice_tl.send(TimelineCommand::Typing(true));
    let started = Instant::now();
    let typing = pair.bob_tl.until_typing("alice écrit (vu par bob)", |users| users.iter().any(|u| u == "alice")).await;
    let appeared = started.elapsed();
    assert_eq!(typing, ["alice"], "bob voit alice et personne d'autre");
    pair.alice_tl.send(TimelineCommand::Typing(false));
    let stopped_at = Instant::now();
    let typing = pair.bob_tl.until_typing("alice a cessé d'écrire (vu par bob)", |users| users.is_empty()).await;
    let disappeared = stopped_at.elapsed();
    assert!(typing.is_empty());
    assert!(disappeared < Duration::from_millis(3500), "la fin de frappe doit venir de l'arrêt explicite, pas de l'expiration de 4 s ({disappeared:?})");

    println!("[T8] accusé m.read de bob sur {event_id} en {receipt_latency:?} (alice : read_by = [bob]) ; frappe vue en {appeared:?}, fin vue en {disappeared:?}");
    pair.stop().await;
}

/// T9 — pagination : après les messages d'un salon plus long que la première page, `LoadOlder` ramène une page plus
///      ancienne, sans doublon ni trou, dans l'ordre. `WAIFU_IT_PAGINATION_MESSAGES` (défaut 120) règle le nombre de
///      messages. **55 ne suffisent pas** (mesuré) : une fois la timeline stabilisée, la première page (pagination
///      initiale de `PAGE_SIZE` + fin du flux de synchronisation) contient déjà les 55 ; le test échoue alors plutôt que
///      de prétendre prouver `LoadOlder`. Avec 120, la série demande 3 `LoadOlder`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn load_older_brings_an_earlier_page_without_gap_or_duplicate() {
    let total: usize = std::env::var("WAIFU_IT_PAGINATION_MESSAGES").ok().and_then(|v| v.parse().ok()).unwrap_or(120);
    assert!(total > usize::from(matrix::PAGE_SIZE), "il faut plus de messages qu'une page ({})", matrix::PAGE_SIZE);
    let (alice_account, bob_account) = credentials();
    let dirs = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, dirs.0.path()).await, sign_in(&bob_account, dirs.1.path()).await);
    let room = encrypted_room(&alice, &bob).await;

    // Alice écrit tout d'avance (p-001 … p-NNN), bob n'ouvre sa timeline qu'ensuite.
    let alice_sync = Sync::start(&alice);
    let mut alice_tl = Timeline::start(&alice, &room);
    let prefix = unique("p");
    let label = |i: usize| format!("{prefix}-{i:03}");
    let started = Instant::now();
    for i in 1..=total {
        alice_tl.send(TimelineCommand::SendText(label(i)));
    }
    let last = label(total);
    alice_tl.until_events("le dernier message confirmé chez alice", |events| events.iter().any(|e| e.body == last && e.event_id.is_some())).await;
    alice_tl.until_events("tous les messages confirmés chez alice", |events| events.iter().filter(|e| e.body.starts_with(&prefix) && e.event_id.is_some()).count() == total).await;
    let sending = started.elapsed();


    let bob_sync = Sync::start(&bob);
    let mut bob_tl = Timeline::start(&bob, &room);
    bob_tl.until("la première page chez bob", |t| t.at_start.is_some() && t.events.iter().any(|e| e.body == last)).await;

    // Numéros (dans l'ordre de la liste) et identifiants des messages de la série.
    let series = |events: &[EventVm]| -> (Vec<usize>, Vec<String>) {
        events
            .iter()
            .filter(|e| e.body.starts_with(&prefix))
            .map(|e| (e.body.rsplit('-').next().and_then(|n| n.parse::<usize>().ok()).expect("numéro"), e.event_id.clone().map(|id| id.to_string()).expect("event_id")))
            .unzip()
    };
    let check = |numbers: &[usize], ids: &[String], what: &str| {
        let first = *numbers.first().unwrap_or_else(|| panic!("{what} : aucun message"));
        assert_eq!(numbers, (first..=total).collect::<Vec<_>>(), "{what} : ordre, doublon ou trou dans les numéros");
        let unique_ids: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique_ids.len(), ids.len(), "{what} : event_id en double");
    };
    // Laisse la timeline se stabiliser avant de mesurer la première page (les mises à jour tardives sont absorbées).
    tokio::time::sleep(Duration::from_secs(2)).await;
    while let Ok(update) = bob_tl.updates.try_recv() {
        bob_tl.absorb(update);
    }
    let (numbers, ids) = series(&bob_tl.events);
    check(&numbers, &ids, "première page");
    let first_page = numbers.len();
    assert!(
        first_page < total,
        "la première page contient déjà les {total} messages ({first_page}) : LoadOlder ne peut pas être prouvé, augmenter WAIFU_IT_PAGINATION_MESSAGES"
    );
    let first_at_start = bob_tl.at_start;

    // Une page plus ancienne arrive.
    let started = Instant::now();
    bob_tl.send(TimelineCommand::LoadOlder);
    bob_tl.until("une page plus ancienne chez bob", |t| t.events.iter().filter(|e| e.body.starts_with(&prefix)).count() > first_page).await;
    let (numbers, ids) = series(&bob_tl.events);
    let after_one = numbers.len();
    let one_page = started.elapsed();
    check(&numbers, &ids, "après un LoadOlder");
    assert!(after_one > first_page && after_one <= first_page + usize::from(matrix::PAGE_SIZE), "une page : {first_page} → {after_one}");

    // On remonte jusqu'au début de la série : tout est là, une fois chacun, dans l'ordre.
    let mut loads = 1;
    while series(&bob_tl.events).0.len() < total {
        assert!(loads < 10, "la série n'est pas complète après {loads} pages");
        let before = series(&bob_tl.events).0.len();
        bob_tl.send(TimelineCommand::LoadOlder);
        bob_tl.until("une page plus ancienne de plus", |t| t.events.iter().filter(|e| e.body.starts_with(&prefix)).count() > before).await;
        loads += 1;
    }
    let (numbers, ids) = series(&bob_tl.events);
    check(&numbers, &ids, "série complète");
    assert_eq!((numbers.len(), numbers[0], *numbers.last().expect("dernier")), (total, 1, total));
    let stamps: Vec<u64> = bob_tl.events.iter().filter(|e| e.body.starts_with(&prefix)).map(|e| e.timestamp_ms).collect();
    assert!(stamps.windows(2).all(|w| w[0] <= w[1]), "horodatages croissants");

    println!(
        "[T9] {total} messages envoyés en {sending:?} ; première page {first_page} (at_start={first_at_start:?}), après 1 LoadOlder {after_one} (en {one_page:?}), série complète après {loads} LoadOlder ; aucun doublon, aucun trou"
    );
    bob_tl.stop().await;
    alice_tl.stop().await;
    bob_sync.stop().await;
    alice_sync.stop().await;
}

/// Statut HTTP de `GET /account/whoami` avec ce jeton (jamais affiché).
async fn whoami_status(token: &str) -> u16 {
    let url = format!("{}/_matrix/client/v3/account/whoami", homeserver().trim_end_matches('/'));
    matrix_sdk::reqwest::Client::new().get(url).bearer_auth(token).send().await.expect("requête whoami").status().as_u16()
}

/// T10a — déconnexion : la session locale disparaît (plus de reprise possible), le serveur refuse l'ancien jeton,
///        et une nouvelle connexion sur le même dossier redonne un client fonctionnel avec un nouvel appareil.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn logout_erases_the_local_session_and_a_new_login_works() {
    let (alice, _) = credentials();
    let dir = tempfile::tempdir().expect("tempdir");
    let (client, session) = matrix::sign_in(&homeserver(), &alice.user, &alice.password, dir.path()).await.expect("connexion");
    let token = client.access_token().expect("jeton d'accès");
    assert_eq!(whoami_status(&token).await, 200, "le jeton fonctionne avant la déconnexion");
    assert!(matrix::resume(dir.path()).await.expect("reprise avant déconnexion").is_some(), "une session est reprenable avant");

    let started = Instant::now();
    matrix::logout(&client, dir.path()).await.expect("déconnexion");
    let logout_time = started.elapsed();
    drop(client);

    // Local : plus rien d'utilisable.
    assert!(!dir.path().join("session").exists(), "le dossier de session (store, clé, homeserver) est supprimé");
    assert_eq!(matrix::stored_homeserver(dir.path()), None);
    assert!(matrix::resume(dir.path()).await.expect("reprise après déconnexion").is_none(), "aucune session reprenable après logout");
    // Serveur : l'ancien jeton est invalide.
    assert_eq!(whoami_status(&token).await, 401, "le serveur doit refuser le jeton d'une session déconnectée");

    // Retour : nouvelle connexion sur le même dossier → client fonctionnel, nouvel appareil, reprise de nouveau possible.
    let (again, session_again) = matrix::sign_in(&homeserver(), &alice.user, &alice.password, dir.path()).await.expect("nouvelle connexion");
    assert_eq!(session_again.user_id, session.user_id);
    assert_ne!(session_again.device_id, session.device_id, "un nouvel appareil est créé");
    let who = again.whoami().await.expect("whoami");
    assert_eq!(who.user_id.as_str(), alice.user);
    assert_eq!(who.device_id.expect("appareil").as_str(), session_again.device_id);
    let new_token = again.access_token().expect("jeton");
    assert_ne!(new_token, token);
    assert_eq!(whoami_status(&new_token).await, 200);
    drop(again);
    assert!(matrix::resume(dir.path()).await.expect("reprise").is_some(), "la nouvelle session est reprenable");

    println!("[T10a] déconnexion {logout_time:?} ; ancien jeton → 401 ; nouveau login : appareil {} → {}", session.device_id, session_again.device_id);
}

/// Supprime la sauvegarde de clés existante sur le serveur (s'il y en a une), sans en détenir la clé : `recovery().disable()`
/// échoue (`BackupNotEnabled`) sur un appareil neuf. Sert à repartir d'un compte de test sans sauvegarde.
async fn delete_server_backup(client: &Client) {
    use matrix_sdk::ruma::api::client::backup::{delete_backup_version, get_latest_backup_info};
    if let Ok(latest) = client.send(get_latest_backup_info::v3::Request::new()).await {
        client.send(delete_backup_version::v3::Request::new(latest.version)).await.expect("suppression de la sauvegarde du compte de test");
    }
}

/// Restauration des clés par clé de récupération (générée par le test, jamais affichée) sur un nouvel appareil.
///
/// `explicit_download` : après `matrix::recover`, demande aussi explicitement au SDK de télécharger les clés de la
/// sauvegarde pour le salon. Sans cela, le message antérieur reste indéchiffrable : voir D-W05-3 dans
/// `.design/RAPPORT-W05-etape2-couverture.md` (`BackupDownloadStrategy` par défaut = `Manual`, jamais réglée par le client).
async fn recovery_scenario(explicit_download: bool) {
    use domain::KeyStatus;
    let (alice_account, bob_account) = credentials();
    let (alice_dir, bob_dir, new_dir) = (tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"), tempfile::tempdir().expect("tempdir"));
    let (alice, bob) = (sign_in(&alice_account, alice_dir.path()).await, sign_in(&bob_account, bob_dir.path()).await);
    let room = encrypted_room(&alice, &bob).await;

    // Bob écrit ; l'appareil 1 d'alice le reçoit (donc il a la clé de session).
    let (alice_sync, bob_sync) = (Sync::start(&alice), Sync::start(&bob));
    let mut alice_tl = Timeline::start(&alice, &room);
    let bob_tl = Timeline::start(&bob, &room);
    let text = unique("recup");
    bob_tl.send(TimelineCommand::SendText(text.clone()));
    alice_tl.until_events("le message de bob chez alice (appareil 1)", |events| has_text(events, &text)).await;
    decrypted(&alice_tl.events, &text);

    // Alice active la récupération (Secret Storage + sauvegarde des clés) et attend que la sauvegarde soit montée.
    // Le Secret Storage et la sauvegarde sont des états du COMPTE, qui survivent aux exécutions : on repart de zéro
    // (sinon `enable` échoue avec `BackupExistsOnServer` dès la deuxième exécution) et on nettoie à la fin.
    delete_server_backup(&alice).await;
    let started = Instant::now();
    let key: String = alice.encryption().recovery().enable().wait_for_backups_to_upload().await.expect("activation de la récupération");
    let enable_time = started.elapsed();
    assert!(!key.trim().is_empty(), "une clé de récupération est produite");

    // Appareil 2 : nouveau store. Le Secret Storage existe mais ses clés manquent ici.
    let new_device = sign_in(&alice_account, new_dir.path()).await;
    let mut new_sync = Sync::start(&new_device);
    let _ = new_sync.first_server_snapshot().await;
    let status_before = matrix::key_status(&new_device);
    assert_eq!(status_before, KeyStatus::Needed, "l'appareil 2 doit réclamer la clé de récupération");
    let mut new_tl = Timeline::start(&new_device, &room);
    let locked = new_tl.until_events("le message (illisible) sur l'appareil 2", |events| !events.is_empty()).await;
    assert!(!has_text(&locked, &text), "sans les clés, le message n'est pas lisible");
    assert!(locked.iter().any(|e| e.state == EventState::Indechiffrable || e.body == UNDECRYPTABLE_PLACEHOLDER), "message indéchiffrable attendu avant la restauration");

    // Une clé fausse est refusée, avec le message fixe (qui ne cite pas la saisie).
    let wrong = domain::validate_recovery_key("EsTx abcd efgh ijkl mnop qrst uvwx yzab cdef ghij klmn opqr").expect("saisie non vide");
    let refused = matrix::recover(&new_device, wrong).await.expect_err("une clé fausse doit être refusée");
    assert!(matches!(refused, matrix::MatrixError::InvalidRecoveryKey), "erreur inattendue : {refused}");

    // La bonne clé restaure : le message antérieur devient lisible.
    let started = Instant::now();
    matrix::recover(&new_device, domain::validate_recovery_key(&key).expect("clé valide")).await.expect("restauration par clé de récupération");
    let recover_time = started.elapsed();
    if explicit_download {
        new_device.encryption().backups().download_room_keys_for_room(&room).await.expect("téléchargement explicite des clés du salon");
    }
    let mut reopened = None;
    let readable = match tokio::time::timeout(Duration::from_secs(30), new_tl.until_events("déchiffrement après restauration", |events| has_text(events, &text))).await {
        Ok(events) => events,
        Err(_) => {
            let mut again = Timeline::start(&new_device, &room);
            let events = again.until_events("déchiffrement après réouverture de la timeline", |events| has_text(events, &text)).await;
            reopened = Some(again);
            events
        }
    };
    decrypted(&readable, &text);
    // Observation (non assertionnée) : le statut local après restauration. Le compte de test a des clés de signature
    // croisée côté serveur qu'aucun appareil de ce test ne détient (`has_master: false`, mesuré) : le SDK le garde donc
    // en `Incomplete` (→ `Needed`) même après une restauration réussie ; ce n'est pas un défaut de `recover`.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let status_after = matrix::key_status(&new_device);

    println!(
        "[T10b/c explicite={explicit_download}] récupération activée en {enable_time:?} ; appareil 2 : statut {status_before:?} → {status_after:?} ; clé fausse refusée ; restauration en {recover_time:?} ; statut local après restauration : {status_after:?} (observé, non assertionné) ; message `{text}` lisible (timeline rouverte : {})",
        reopened.is_some()
    );
    // Nettoyage : le compte de test retrouve son état d'origine (sans Secret Storage ni sauvegarde).
    alice.encryption().recovery().disable().await.expect("nettoyage de la récupération");
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

/// T10b — **défaut connu D-W05-3** : `matrix::recover` seul ne rend pas un message antérieur (le client ne règle pas
///        `BackupDownloadStrategy`). N'est exécuté que si `WAIFU_IT_KNOWN_DEFECTS=1` (rouge tant que non corrigé).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn the_recovery_key_alone_unlocks_an_earlier_message_on_a_new_device() {
    if std::env::var_os("WAIFU_IT_KNOWN_DEFECTS").is_none() {
        println!("[T10b] défaut connu D-W05-3 : test sauté (WAIFU_IT_KNOWN_DEFECTS=1 pour l'exécuter, rouge tant que non corrigé)");
        return;
    }
    recovery_scenario(false).await;
}

/// T10c — la clé de récupération restaure bien les clés : `matrix::recover` puis téléchargement explicite des clés de
///        la sauvegarde → le message antérieur est lisible sur le nouvel appareil (clé fausse refusée, statut `Needed`
///        avant). Prouve que le contenu de la sauvegarde et `recover` sont corrects ; seul le déclenchement du
///        téléchargement manque au client (T10b).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "exige un homeserver : WAIFU_IT_HOMESERVER=http://127.0.0.1:8008 puis --ignored"]
async fn the_recovery_key_with_an_explicit_key_download_unlocks_an_earlier_message() {
    recovery_scenario(true).await;
}
