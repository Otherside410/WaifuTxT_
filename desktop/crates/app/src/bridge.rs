//! Pont Tokio -> GPUI : tout ce qui touche au réseau ou à la crypto s'exécute sur le runtime
//! Tokio dédié ; le résultat revient par un `oneshot` que l'UI attend via `cx.spawn`.
//! Le thread UI n'attend jamais un appel Matrix.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use domain::{LoginRequest, RecoveryKey, Session};
use matrix::{Client, SyncUpdate};
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

#[derive(Clone)]
pub struct Bridge {
    runtime: Arc<Runtime>,
    data_dir: PathBuf,
}

impl Bridge {
    pub fn new(runtime: Arc<Runtime>, data_dir: PathBuf) -> Self {
        Self { runtime, data_dir }
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
}
