//! État de la connexion au homeserver, tel que l'UI l'affiche.

/// Où en est la liaison avec le serveur.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ConnectionState {
    /// Démarrage : l'affichage vient du store local, la première réponse du serveur n'est pas encore là.
    #[default]
    Connecting,
    /// Le serveur répond : l'affichage est à jour.
    Online,
    /// Le serveur ne répond pas : l'affichage est celui du store local ; l'application réessaie seule.
    Offline(String),
}

impl ConnectionState {
    /// Texte du bandeau ; `None` quand tout va bien (pas de bandeau).
    pub fn banner(&self) -> Option<String> {
        match self {
            Self::Online => None,
            Self::Connecting => Some("Connexion au serveur…".to_owned()),
            Self::Offline(reason) => {
                Some(format!("Hors ligne — nouvelle tentative automatique. {reason}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_healthy_connection_has_no_banner() {
        assert_eq!(ConnectionState::Online.banner(), None);
        assert!(ConnectionState::Connecting.banner().is_some());
        let offline = ConnectionState::Offline("Homeserver injoignable.".into()).banner();
        let text = offline.expect("bandeau hors ligne");
        assert!(text.starts_with("Hors ligne") && text.contains("Homeserver injoignable."), "{text}");
    }

    #[test]
    fn the_default_state_is_connecting() {
        assert_eq!(ConnectionState::default(), ConnectionState::Connecting);
    }
}
