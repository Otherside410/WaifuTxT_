//! Pont Tokio -> GPUI : tout ce qui touche au réseau ou à la crypto s'exécute sur le runtime
//! Tokio dédié ; le résultat revient par un `oneshot` que l'UI attend via `cx.spawn`.
//! Le thread UI n'attend jamais un appel Matrix.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use domain::{LoginRequest, RecoveryKey, RoomId, Session, TimelineUpdate};
use matrix::{Client, MediaCache, SyncUpdate, TimelineCommand};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// Résultat d'une connexion ou d'une reprise : message affichable en cas d'échec.
pub type SessionResult = Result<(Client, Session), String>;

/// Garde la boucle de synchronisation en vie ; la lâcher (logout, fermeture) l'interrompt.
pub struct SyncHandle(JoinHandle<()>);

impl Drop for SyncHandle {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Timeline du salon sélectionné : la lâcher (autre salon, déconnexion) interrompt la tâche, donc
/// plus aucune mise à jour de l'ancien salon n'est émise.
pub struct TimelineHandle {
    task: JoinHandle<()>,
    commands: mpsc::UnboundedSender<TimelineCommand>,
}

impl TimelineHandle {
    /// Demande une page plus ancienne ; sans effet si la tâche est terminée.
    pub fn load_older(&self) {
        let _ = self.commands.send(TimelineCommand::LoadOlder);
    }

    /// Met un message texte en file d'envoi ; `false` si la tâche de timeline n'écoute plus.
    pub fn send_text(&self, body: String) -> bool {
        self.command(TimelineCommand::SendText(body))
    }

    /// Transmet une commande à la tâche de timeline ; `false` si elle n'écoute plus.
    pub fn command(&self, command: TimelineCommand) -> bool {
        self.commands.send(command).is_ok()
    }
}

impl Drop for TimelineHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
pub struct Bridge {
    runtime: Arc<Runtime>,
    data_dir: PathBuf,
    /// Cache des médias téléchargés, partagé par toutes les timelines (vit côté `matrix`, pas dans l'UI).
    media_cache: Arc<MediaCache>,
}

impl Bridge {
    pub fn new(runtime: Arc<Runtime>, data_dir: PathBuf) -> Self {
        Self { runtime, data_dir, media_cache: Arc::new(MediaCache::new()) }
    }

    /// Lance `future` sur Tokio ; le receveur peut être attendu depuis l'executor GPUI.
    fn run<T, F>(&self, future: F) -> oneshot::Receiver<Result<T, String>>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, String>> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        self.runtime.spawn(async move {
            // Si l'UI a disparu, le résultat est simplement abandonné.
            let _ = tx.send(future.await);
        });
        rx
    }

    pub fn sign_in(&self, request: LoginRequest) -> oneshot::Receiver<SessionResult> {
        let data_dir = self.data_dir.clone();
        self.run(async move {
            matrix::sign_in(&request.homeserver, &request.username, &request.password, &data_dir)
                .await
                .map_err(|e| e.to_string())
        })
    }

    pub fn resume(&self) -> oneshot::Receiver<Result<Option<(Client, Session)>, String>> {
        let data_dir = self.data_dir.clone();
        self.run(async move { matrix::resume(&data_dir).await.map_err(|e| e.to_string()) })
    }

    pub fn logout(&self, client: Client) -> oneshot::Receiver<Result<(), String>> {
        let data_dir = self.data_dir.clone();
        self.run(async move { matrix::logout(&client, &data_dir).await.map_err(|e| e.to_string()) })
    }

    /// Lance la synchronisation de fond ; les instantanés arrivent sur le receveur.
    pub fn start_sync(&self, client: Client) -> (mpsc::UnboundedReceiver<SyncUpdate>, SyncHandle) {
        let (tx, rx) = mpsc::unbounded_channel();
        let task = self.runtime.spawn(matrix::run_sync(client, move |update| {
            // Receveur disparu : plus personne n'écoute, la tâche sera abandonnée par `SyncHandle`.
            let _ = tx.send(update);
        }));
        (rx, SyncHandle(task))
    }

    /// Déverrouille le Secret Storage ; la clé est consommée et jamais journalisée.
    pub fn recover(&self, client: Client, key: RecoveryKey) -> oneshot::Receiver<Result<(), String>> {
        self.run(async move { matrix::recover(&client, key).await.map_err(|e| e.to_string()) })
    }

    /// Ouvre la timeline d'un salon sur Tokio ; les mises à jour arrivent sur le receveur.
    pub fn open_timeline(
        &self,
        client: Client,
        room: RoomId,
    ) -> (mpsc::UnboundedReceiver<TimelineUpdate>, TimelineHandle) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (commands, command_rx) = mpsc::unbounded_channel();
        let cache = Arc::clone(&self.media_cache);
        let task = self.runtime.spawn(matrix::run_timeline(
            client,
            room,
            command_rx,
            cache,
            move |update| {
                let _ = tx.send(update);
            },
        ));
        (rx, TimelineHandle { task, commands })
    }
}
