use std::fmt;

/// Erreurs de la mise à jour. Les messages ne citent jamais de clé ni de contenu de binaire.
#[derive(Debug)]
pub enum UpdateError {
    /// La signature du manifeste ne correspond pas à la clé publique (ou n'est pas lisible).
    BadSignature,
    /// Clé publique illisible (hexadécimal de 64 caractères attendu).
    BadKey,
    /// Manifeste signé mais invalide (JSON, version, sha256, URL).
    BadManifest(String),
    /// Le sha256 du binaire téléchargé ne correspond pas au manifeste.
    HashMismatch,
    /// La taille du binaire téléchargé ne correspond pas au manifeste.
    SizeMismatch { expected: u64, got: u64 },
    /// Taille déclarée ou téléchargée au-delà du garde-fou.
    TooLarge { size: u64, max: u64 },
    /// Le manifeste propose une version plus ancienne que l'installée (attaque par retour en arrière ou manifeste périmé).
    Downgrade { current: String, offered: String },
    /// Schéma d'URL interdit (seul `https://` est accepté hors tests).
    ForbiddenUrl(String),
    /// Échec de téléchargement.
    Fetch(String),
    /// Le fichier à remplacer n'existe pas.
    TargetMissing,
    /// Aucune version précédente à réactiver.
    NoPrevious,
    /// Erreur d'entrée-sortie ; le fichier installé a été restauré si le remplacement avait commencé.
    Io(std::io::Error),
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadSignature => f.write_str("signature du manifeste invalide : rien n'a été remplacé"),
            Self::BadKey => f.write_str("clé publique de mise à jour illisible"),
            Self::BadManifest(why) => write!(f, "manifeste invalide : {why}"),
            Self::HashMismatch => f.write_str("sha256 du binaire différent du manifeste : rien n'a été remplacé"),
            Self::SizeMismatch { expected, got } => write!(f, "taille du binaire {got} o au lieu de {expected} o : rien n'a été remplacé"),
            Self::TooLarge { size, max } => write!(f, "binaire trop gros ({size} o, plafond {max} o)"),
            Self::Downgrade { current, offered } => write!(f, "version proposée {offered} plus ancienne que l'installée {current} : refusée"),
            Self::ForbiddenUrl(url) => write!(f, "URL non autorisée : {url}"),
            Self::Fetch(why) => write!(f, "téléchargement impossible : {why}"),
            Self::TargetMissing => f.write_str("le fichier à mettre à jour n'existe pas"),
            Self::NoPrevious => f.write_str("aucune version précédente à réactiver"),
            Self::Io(err) => write!(f, "erreur de fichier : {err}"),
        }
    }
}

impl std::error::Error for UpdateError {}

impl From<std::io::Error> for UpdateError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}
