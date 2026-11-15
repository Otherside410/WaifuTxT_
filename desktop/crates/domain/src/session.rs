//! Session utilisateur et validation du formulaire de connexion (logique pure, sans I/O).

use std::fmt;

use crate::UserId;

/// Session ouverte, **sans secret** : le jeton d'accès reste dans la crate `matrix`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub user_id: UserId,
    pub device_id: String,
    pub homeserver: String,
}

/// Champ du formulaire de connexion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginField {
    Homeserver,
    Username,
    Password,
}

/// Champ invalide, avec un message destiné à l'utilisateur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub field: LoginField,
    pub message: &'static str,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}

/// Demande de connexion validée. `Debug` masque le mot de passe.
#[derive(Clone, PartialEq, Eq)]
pub struct LoginRequest {
    pub homeserver: String,
    pub username: String,
    pub password: String,
}

impl fmt::Debug for LoginRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginRequest")
            .field("homeserver", &self.homeserver)
            .field("username", &self.username)
            .field("password", &"<masqué>")
            .finish()
    }
}

/// Valide les trois champs. Le homeserver est un nom de serveur (`matrix.org`) ou une URL
/// `http(s)://…` ; l'identifiant et le homeserver sont nettoyés des espaces autour, pas le mot de passe.
pub fn validate_login(
    homeserver: &str,
    username: &str,
    password: &str,
) -> Result<LoginRequest, ValidationError> {
    let homeserver = homeserver.trim();
    let username = username.trim();

    let err = |field, message| Err(ValidationError { field, message });

    if homeserver.is_empty() {
        return err(LoginField::Homeserver, "Indique l'adresse de ton homeserver (ex. https://mon-homeserver.exemple).");
    }
    if homeserver.chars().any(char::is_whitespace) {
        return err(LoginField::Homeserver, "Le homeserver ne doit pas contenir d'espace.");
    }
    if let Some((scheme, rest)) = homeserver.split_once("://") {
        if scheme != "http" && scheme != "https" {
            return err(LoginField::Homeserver, "Le homeserver doit commencer par http:// ou https://.");
        }
        if rest.is_empty() || rest.starts_with('/') {
            return err(LoginField::Homeserver, "Adresse du homeserver incomplète.");
        }
    }
    if username.is_empty() {
        return err(LoginField::Username, "Indique ton identifiant.");
    }
    if password.is_empty() {
        return err(LoginField::Password, "Indique ton mot de passe.");
    }

    Ok(LoginRequest {
        homeserver: homeserver.to_owned(),
        username: username.to_owned(),
        password: password.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field_of(r: Result<LoginRequest, ValidationError>) -> LoginField {
        r.expect_err("doit être refusé").field
    }

    #[test]
    fn accepts_server_name_and_url() {
        assert!(validate_login("matrix.org", "alice", "x").is_ok());
        assert!(validate_login(" https://example.org ", " alice ", "x").is_ok());
    }

    #[test]
    fn trims_homeserver_and_username_only() {
        let r = validate_login(" matrix.org ", " alice ", " pw ").expect("valide");
        assert_eq!(r.homeserver, "matrix.org");
        assert_eq!(r.username, "alice");
        assert_eq!(r.password, " pw ");
    }

    #[test]
    fn rejects_empty_fields() {
        assert_eq!(field_of(validate_login("", "a", "b")), LoginField::Homeserver);
        assert_eq!(field_of(validate_login("  ", "a", "b")), LoginField::Homeserver);
        assert_eq!(field_of(validate_login("m.org", "", "b")), LoginField::Username);
        assert_eq!(field_of(validate_login("m.org", "a", "")), LoginField::Password);
    }

    #[test]
    fn rejects_bad_homeservers() {
        for bad in ["ftp://m.org", "https://", "https:///x", "ma trix.org"] {
            assert_eq!(field_of(validate_login(bad, "a", "b")), LoginField::Homeserver, "{bad}");
        }
    }

    #[test]
    fn debug_hides_password() {
        let r = validate_login("m.org", "a", "s3cret-value").expect("valide");
        assert!(!format!("{r:?}").contains("s3cret-value"));
    }
}
