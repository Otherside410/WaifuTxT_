//! État pur du modal de clé de récupération (testable sans fenêtre).

/// Cycle de vie du modal.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ModalState {
    #[default]
    Closed,
    Open {
        /// Déverrouillage en cours : le bouton et le champ sont désactivés, le modal ne se ferme pas.
        busy: bool,
        error: Option<String>,
    },
}

impl ModalState {
    pub fn is_open(&self) -> bool {
        matches!(self, Self::Open { .. })
    }

    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Open { busy: true, .. })
    }

    pub fn open(&mut self) {
        if !self.is_open() {
            *self = Self::Open { busy: false, error: None };
        }
    }

    /// Fermeture demandée par l'utilisateur : refusée pendant un déverrouillage.
    pub fn close(&mut self) {
        if !self.is_busy() {
            *self = Self::Closed;
        }
    }

    pub fn start(&mut self) {
        if let Self::Open { busy, error } = self {
            *busy = true;
            *error = None;
        }
    }

    pub fn fail(&mut self, message: String) {
        if let Self::Open { busy, error } = self {
            *busy = false;
            *error = Some(message);
        }
    }

    /// Succès : fermeture inconditionnelle.
    pub fn succeed(&mut self) {
        *self = Self::Closed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_and_closes() {
        let mut modal = ModalState::default();
        assert!(!modal.is_open());
        modal.open();
        assert!(modal.is_open());
        modal.close();
        assert!(!modal.is_open());
    }

    #[test]
    fn cannot_be_closed_while_busy() {
        let mut modal = ModalState::default();
        modal.open();
        modal.start();
        modal.close();
        assert!(modal.is_open() && modal.is_busy());
    }

    #[test]
    fn failure_keeps_it_open_with_the_message_then_retry_clears_it() {
        let mut modal = ModalState::default();
        modal.open();
        modal.start();
        modal.fail("Clé incorrecte".to_owned());
        assert_eq!(modal, ModalState::Open { busy: false, error: Some("Clé incorrecte".to_owned()) });
        modal.start();
        assert_eq!(modal, ModalState::Open { busy: true, error: None });
    }

    #[test]
    fn success_closes_even_when_busy() {
        let mut modal = ModalState::default();
        modal.open();
        modal.start();
        modal.succeed();
        assert_eq!(modal, ModalState::Closed);
    }

    #[test]
    fn reopening_an_open_modal_keeps_its_state() {
        let mut modal = ModalState::default();
        modal.open();
        modal.fail("x".to_owned());
        modal.open();
        assert_eq!(modal, ModalState::Open { busy: false, error: Some("x".to_owned()) });
    }
}
