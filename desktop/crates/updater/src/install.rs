use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::UpdateError;

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(std::ffi::OsStr::to_os_string).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Emplacement de la version N-1 : `<fichier>.previous`, à côté du fichier installé.
pub fn previous_path(target: &Path) -> PathBuf {
    sibling(target, ".previous")
}

#[cfg(unix)]
fn make_executable(file: &fs::File, like: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(like).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o755) | 0o111;
    file.set_permissions(fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn make_executable(_file: &fs::File, _like: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Remplace `target` par `new_bytes` en gardant l'ancien en `.previous`.
///
/// Les octets doivent déjà avoir été vérifiés ([`crate::verify_binary`]). Procédure : écriture dans `<fichier>.new`
/// (même dossier, donc même volume), synchronisation sur disque, `target` → `.previous`, `.new` → `target`. Si la
/// seconde permutation échoue, l'ancien fichier est remis en place. Un échec **avant** la première permutation ne laisse
/// que le fichier `.new`, supprimé.
pub fn apply(target: &Path, new_bytes: &[u8]) -> Result<(), UpdateError> {
    if !target.is_file() {
        return Err(UpdateError::TargetMissing);
    }
    let staged = sibling(target, ".new");
    let previous = previous_path(target);
    let _ = fs::remove_file(&staged);

    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&staged)?;
        file.write_all(new_bytes)?;
        make_executable(&file, target)?;
        file.sync_all()
    };
    if let Err(err) = write() {
        let _ = fs::remove_file(&staged);
        return Err(err.into());
    }

    let _ = fs::remove_file(&previous);
    if let Err(err) = fs::rename(target, &previous) {
        let _ = fs::remove_file(&staged);
        return Err(err.into());
    }
    if let Err(err) = fs::rename(&staged, target) {
        // Retour arrière : l'ancienne version reprend sa place.
        let restored = fs::rename(&previous, target);
        let _ = fs::remove_file(&staged);
        return match restored {
            Ok(()) => Err(err.into()),
            Err(restore_err) => Err(std::io::Error::new(
                restore_err.kind(),
                format!("remplacement échoué ({err}) ET restauration échouée ({restore_err}) : l'ancienne version est dans {}", previous.display()),
            )
            .into()),
        };
    }
    Ok(())
}

/// Réactive la version N-1 : `target` et `.previous` échangent leur place (rappeler [`rollback`] revient donc à la
/// version la plus récente). `NoPrevious` si aucune version précédente n'est conservée.
pub fn rollback(target: &Path) -> Result<(), UpdateError> {
    let previous = previous_path(target);
    if !previous.is_file() {
        return Err(UpdateError::NoPrevious);
    }
    if !target.is_file() {
        return Err(UpdateError::TargetMissing);
    }
    let parked = sibling(target, ".rollback");
    let _ = fs::remove_file(&parked);
    fs::rename(target, &parked)?;
    if let Err(err) = fs::rename(&previous, target) {
        let _ = fs::rename(&parked, target);
        return Err(err.into());
    }
    if let Err(err) = fs::rename(&parked, &previous) {
        // La version N-1 est déjà active : seul le rangement de l'ancienne courante a échoué ; on le dit.
        return Err(std::io::Error::new(err.kind(), format!("version précédente active, mais l'ancienne reste dans {}", parked.display())).into());
    }
    Ok(())
}
