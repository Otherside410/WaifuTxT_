use std::path::PathBuf;
use std::process::Command;

use crate::UpdateError;

/// Quels schémas d'URL sont acceptés. Le défaut de production est `HttpsOnly`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrlPolicy {
    /// `https://` seulement.
    HttpsOnly,
    /// `https://` et `file://` / chemins locaux : tests et simulations hors réseau uniquement.
    AllowFile,
}

impl UrlPolicy {
    pub fn check(self, url: &str) -> Result<(), UpdateError> {
        let allowed = url.starts_with("https://") || (self == Self::AllowFile && (url.starts_with("file://") || url.starts_with('/')));
        if allowed {
            Ok(())
        } else {
            Err(UpdateError::ForbiddenUrl(url.to_owned()))
        }
    }
}

/// Transport : récupère au plus `max_bytes` octets (une réponse plus longue est une erreur).
pub trait Fetcher {
    fn fetch(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError>;
}

/// Lit des fichiers locaux (`file:///chemin` ou chemin absolu). Pour les tests et les simulations.
pub struct FileFetcher;

impl Fetcher for FileFetcher {
    fn fetch(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError> {
        let path = PathBuf::from(url.strip_prefix("file://").unwrap_or(url));
        let length = std::fs::metadata(&path).map_err(|e| UpdateError::Fetch(e.to_string()))?.len();
        if length > max_bytes {
            return Err(UpdateError::TooLarge { size: length, max: max_bytes });
        }
        std::fs::read(&path).map_err(|e| UpdateError::Fetch(e.to_string()))
    }
}

/// Télécharge en lançant `curl` (présent sur Linux et sur Windows 10+), sans dépendance HTTP dans le binaire.
/// `--proto` limite les schémas, `--max-filesize` borne la taille, `--fail` refuse les codes d'erreur HTTP.
pub struct CurlFetcher {
    pub policy: UrlPolicy,
}

impl Fetcher for CurlFetcher {
    fn fetch(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError> {
        self.policy.check(url)?;
        let protocols = if self.policy == UrlPolicy::AllowFile { "=https,file" } else { "=https" };
        let output = Command::new("curl")
            .args(["--fail", "--silent", "--show-error", "--location", "--proto", protocols, "--proto-redir", "=https"])
            .args(["--max-filesize", &max_bytes.to_string(), "--output", "-", "--"])
            .arg(url)
            .output()
            .map_err(|e| UpdateError::Fetch(format!("curl introuvable ou non exécutable : {e}")))?;
        if !output.status.success() {
            return Err(UpdateError::Fetch(String::from_utf8_lossy(&output.stderr).trim().to_owned()));
        }
        if output.stdout.len() as u64 > max_bytes {
            return Err(UpdateError::TooLarge { size: output.stdout.len() as u64, max: max_bytes });
        }
        Ok(output.stdout)
    }
}
