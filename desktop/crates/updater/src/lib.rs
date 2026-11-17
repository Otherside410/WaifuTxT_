//! Mise à jour native de WaifuChat (remplace `electron-updater`, W07).
//!
//! Chaîne de confiance : un **manifeste** JSON (`version`, `url`, `sha256`, `size`) est signé en ed25519 (signature
//! détachée, 64 octets en hexadécimal). Le client vérifie la signature **avant de lire le manifeste**, puis le sha256 et
//! la taille du binaire téléchargé **avant de toucher au fichier installé**. Tout échec laisse l'installation
//! octet pour octet inchangée. Le remplacement conserve la version N-1 à côté (`<fichier>.previous`) ; [`rollback`]
//! l'échange avec la version courante.
//!
//! La clé publique est fournie par l'appelant (compilée dans l'application) ; la clé secrète n'existe que chez celui qui
//! publie (CI, secret). Le transport est abstrait ([`Fetcher`]) : [`FileFetcher`] pour les tests, [`CurlFetcher`] (appelle
//! `curl`) pour le réseau, sans dépendance HTTP.

mod error;
mod fetch;
mod install;
mod manifest;

pub use error::UpdateError;
pub use fetch::{CurlFetcher, Fetcher, FileFetcher, UrlPolicy};
pub use install::{apply, previous_path, rollback};
pub use manifest::{
    decode_hex, encode_hex, generate_keypair, public_key_from_hex, sha256_hex, sign_manifest, verify_binary, verify_manifest, Manifest,
    Version,
};

use std::path::Path;

use ed25519_dalek::VerifyingKey;

/// Taille maximale acceptée pour un binaire téléchargé (garde-fou : 512 Mio).
pub const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;
/// Taille maximale d'un manifeste ou d'une signature (garde-fou : 64 Kio).
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

/// Résultat d'une vérification de mise à jour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// La version publiée est celle installée : rien n'a été téléchargé en plus du manifeste.
    UpToDate,
    /// Le binaire a été vérifié et remplacé ; l'ancien est resté en `.previous`.
    Updated { from: Version, to: Version },
}

/// Vérifie le manifeste signé à `manifest_url` (signature à `signature_url`) puis, si une version plus récente que
/// `current` est publiée, télécharge le binaire, le vérifie et remplace `target`.
///
/// Ordre réel : (1) politique d'URL du manifeste et de la signature ; (2) téléchargement des deux, puis signature du
/// manifeste (avant toute lecture de son contenu) ; (3) politique d'URL du binaire ; (4) version plus récente ;
/// (5) téléchargement du binaire ; (6) taille et sha256 ; (7) remplacement. Le binaire n'est **jamais** téléchargé si la signature est invalide.
pub fn check_and_apply(
    fetcher: &dyn Fetcher,
    policy: UrlPolicy,
    manifest_url: &str,
    signature_url: &str,
    key: &VerifyingKey,
    current: &Version,
    target: &Path,
) -> Result<Outcome, UpdateError> {
    policy.check(manifest_url)?;
    policy.check(signature_url)?;
    let manifest_bytes = fetcher.fetch(manifest_url, MAX_MANIFEST_BYTES)?;
    let signature = fetcher.fetch(signature_url, MAX_MANIFEST_BYTES)?;
    let manifest = verify_manifest(&manifest_bytes, &signature, key)?;
    policy.check(&manifest.url)?;

    let offered = Version::parse(&manifest.version)?;
    if offered == *current {
        return Ok(Outcome::UpToDate);
    }
    if offered < *current {
        return Err(UpdateError::Downgrade { current: current.to_string(), offered: offered.to_string() });
    }
    if manifest.size > MAX_BINARY_BYTES {
        return Err(UpdateError::TooLarge { size: manifest.size, max: MAX_BINARY_BYTES });
    }

    let binary = fetcher.fetch(&manifest.url, manifest.size)?;
    verify_binary(&manifest, &binary)?;
    apply(target, &binary)?;
    Ok(Outcome::Updated { from: current.clone(), to: offered })
}
