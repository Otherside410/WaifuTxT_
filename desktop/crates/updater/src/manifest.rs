use std::cmp::Ordering;
use std::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::UpdateError;

/// Manifeste de version : ce que le client lit **après** avoir vérifié la signature.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// `X.Y.Z` (numérique ; pas de suffixe de préversion).
    pub version: String,
    /// URL du binaire (l'AppImage complète sous Linux).
    pub url: String,
    /// sha256 du binaire, 64 caractères hexadécimaux minuscules.
    pub sha256: String,
    /// Taille du binaire en octets.
    pub size: u64,
    /// Notes de version affichables (facultatif).
    #[serde(default)]
    pub notes: String,
}

/// Numéro de version `X.Y.Z` comparable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version(pub u64, pub u64, pub u64);

impl Version {
    pub fn parse(text: &str) -> Result<Self, UpdateError> {
        let bad = || UpdateError::BadManifest(format!("version illisible : {text:?}"));
        let mut parts = text.split('.');
        let mut next = || parts.next().ok_or_else(bad)?.parse::<u64>().map_err(|_| bad());
        let version = Self(next()?, next()?, next()?);
        if parts.next().is_some() {
            return Err(bad());
        }
        Ok(version)
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.0, self.1, self.2).cmp(&(other.0, other.1, other.2))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Hexadécimal minuscule.
pub fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hexadécimal → octets ; `None` si la longueur est impaire ou un caractère n'est pas hexadécimal.
pub fn decode_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    encode_hex(&Sha256::digest(bytes))
}

/// Clé publique ed25519 en hexadécimal (64 caractères).
pub fn public_key_from_hex(text: &str) -> Result<VerifyingKey, UpdateError> {
    let bytes: [u8; 32] = decode_hex(text).and_then(|b| b.try_into().ok()).ok_or(UpdateError::BadKey)?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| UpdateError::BadKey)
}

/// Génère une paire de clés (graine de 32 octets tirée de l'OS) : `(secret_hex, public_hex)`. Sert aux clés de test
/// jetables et à l'outillage de publication ; la clé secrète ne doit jamais entrer dans le dépôt.
pub fn generate_keypair() -> Result<(String, String), UpdateError> {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| UpdateError::Fetch(format!("aléa indisponible : {e}")))?;
    let signing = SigningKey::from_bytes(&seed);
    Ok((encode_hex(&seed), encode_hex(signing.verifying_key().as_bytes())))
}

/// Signature détachée du manifeste (octets exacts du fichier), en hexadécimal (128 caractères).
pub fn sign_manifest(manifest_bytes: &[u8], secret_hex: &str) -> Result<String, UpdateError> {
    let seed: [u8; 32] = decode_hex(secret_hex).and_then(|b| b.try_into().ok()).ok_or(UpdateError::BadKey)?;
    Ok(encode_hex(&SigningKey::from_bytes(&seed).sign(manifest_bytes).to_bytes()))
}

/// Vérifie la signature détachée (hexadécimal, espaces de bord tolérés) **puis** lit le manifeste.
/// Le contenu n'est jamais interprété avant que la signature ne soit valide.
pub fn verify_manifest(manifest_bytes: &[u8], signature: &[u8], key: &VerifyingKey) -> Result<Manifest, UpdateError> {
    let signature_text = std::str::from_utf8(signature).map_err(|_| UpdateError::BadSignature)?;
    let raw: [u8; 64] = decode_hex(signature_text).and_then(|b| b.try_into().ok()).ok_or(UpdateError::BadSignature)?;
    key.verify_strict(manifest_bytes, &Signature::from_bytes(&raw)).map_err(|_| UpdateError::BadSignature)?;

    let manifest: Manifest = serde_json::from_slice(manifest_bytes).map_err(|e| UpdateError::BadManifest(e.to_string()))?;
    Version::parse(&manifest.version)?;
    if manifest.sha256.len() != 64 || decode_hex(&manifest.sha256).is_none() || manifest.sha256 != manifest.sha256.to_ascii_lowercase() {
        return Err(UpdateError::BadManifest("sha256 : 64 caractères hexadécimaux minuscules attendus".to_owned()));
    }
    if manifest.url.trim().is_empty() {
        return Err(UpdateError::BadManifest("url vide".to_owned()));
    }
    Ok(manifest)
}

/// Taille puis sha256 du binaire téléchargé, comparés au manifeste **déjà authentifié**.
pub fn verify_binary(manifest: &Manifest, binary: &[u8]) -> Result<(), UpdateError> {
    let got = binary.len() as u64;
    if got != manifest.size {
        return Err(UpdateError::SizeMismatch { expected: manifest.size, got });
    }
    if sha256_hex(binary) != manifest.sha256 {
        return Err(UpdateError::HashMismatch);
    }
    Ok(())
}
