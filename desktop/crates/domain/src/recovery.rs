//! Clé de récupération (Secret Storage / 4S) : un secret qui ne doit jamais fuiter.
//!
//! `RecoveryKey` n'implémente ni `Clone` ni `Display` en clair, et son `Debug` est masqué. La clé
//! sert à déverrouiller puis disparaît : elle n'est jamais écrite sur disque.

use std::fmt;

use crate::session::{LoginField, ValidationError};

/// Clé saisie par l'utilisateur. Accès au texte uniquement via [`RecoveryKey::expose`].
pub struct RecoveryKey(String);

impl RecoveryKey {
    /// Texte brut, à passer tel quel au SDK ; ne jamais le journaliser ni l'afficher.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecoveryKey(<masquée>)")
    }
}

impl fmt::Display for RecoveryKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<clé de récupération masquée>")
    }
}

impl Drop for RecoveryKey {
    /// Écrase le contenu avant de libérer la mémoire (au mieux : le texte a pu être copié ailleurs).
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        for byte in bytes.iter_mut() {
            *byte = 0;
        }
        std::hint::black_box(&bytes);
    }
}

/// État du chiffrement du compte vu par l'UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    /// Pas encore connu (avant la première synchronisation).
    Unknown,
    /// Rien à saisir : compte sans Secret Storage, ou clés déjà présentes localement.
    NotNeeded,
    /// Secret Storage configuré mais clés absentes de cet appareil : la clé de récupération est requise.
    Needed,
}

/// Valide la saisie : non vide après nettoyage des espaces en bord. Les espaces internes sont gardés
/// (les clés Matrix sont affichées par groupes de 4 caractères ; le SDK les accepte).
pub fn validate_recovery_key(input: &str) -> Result<RecoveryKey, ValidationError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ValidationError {
            field: LoginField::Password,
            message: "Saisis ta clé de récupération.",
        });
    }
    Ok(RecoveryKey(trimmed.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "EsTc 9x7Q-SECRET-ne-doit-jamais-fuiter";

    #[test]
    fn debug_and_display_never_contain_the_key() {
        let key = validate_recovery_key(SECRET).expect("valide");
        for rendered in [format!("{key:?}"), format!("{key}"), format!("{key:#?}")] {
            assert!(!rendered.contains("SECRET"), "fuite : {rendered}");
            assert!(!rendered.contains("EsTc"), "fuite : {rendered}");
        }
    }

    #[test]
    fn container_debug_does_not_leak_either() {
        let held = vec![validate_recovery_key(SECRET).expect("valide")];
        assert!(!format!("{held:?}").contains("SECRET"));
        let wrapped: Result<RecoveryKey, ValidationError> = validate_recovery_key(SECRET);
        assert!(!format!("{wrapped:?}").contains("SECRET"));
    }

    #[test]
    fn validation_error_is_a_fixed_message() {
        let err = validate_recovery_key("   ").expect_err("vide");
        assert_eq!(err.to_string(), "Saisis ta clé de récupération.");
    }

    #[test]
    fn trims_edges_and_keeps_inner_spaces() {
        let key = validate_recovery_key("  AAAA BBBB  ").expect("valide");
        assert_eq!(key.expose(), "AAAA BBBB");
    }

    #[test]
    fn rejects_blank_input() {
        assert!(validate_recovery_key("").is_err());
        assert!(validate_recovery_key(" \t\n").is_err());
    }
}
