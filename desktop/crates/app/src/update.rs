//! Lignes de commande de mise à jour : `--update <URL du manifeste>` et `--rollback` (W07).
//!
//! Le fichier remplacé est l'AppImage elle-même (`$APPIMAGE`, posée par le lanceur) ; hors AppImage, l'exécutable courant.
//! La clé publique de vérification est **compilée** (`WAIFU_UPDATE_PUBKEY` au moment du build, 64 caractères
//! hexadécimaux) : sans elle, aucune mise à jour n'est possible. Elle n'est lue ni dans l'environnement d'exécution
//! ni dans un fichier, pour qu'on ne puisse pas la remplacer par une clé choisie par l'attaquant.

use std::path::PathBuf;
use std::process::ExitCode;

use updater::{check_and_apply, previous_path, public_key_from_hex, rollback, CurlFetcher, Outcome, UrlPolicy, Version};

pub const UPDATE_FLAG: &str = "--update";
pub const ROLLBACK_FLAG: &str = "--rollback";
pub const VERSION_FLAG: &str = "--version";

/// Clé publique de mise à jour compilée dans ce binaire, si le build en a reçu une.
const PUBLIC_KEY: Option<&str> = option_env!("WAIFU_UPDATE_PUBKEY");

/// Demande de mise à jour extraite de la ligne de commande.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Update { manifest_url: String },
    Rollback,
    /// Affiche la version du binaire qui tourne : le nom de fichier de l'AppImage ne change pas après une mise à jour.
    Version,
}

/// `--update <url>` ou `--rollback` ; `None` si la ligne de commande n'en contient pas. `Err` : `--update` sans URL.
pub fn parse(args: &[String]) -> Result<Option<Request>, String> {
    if args.iter().any(|a| a == VERSION_FLAG) {
        return Ok(Some(Request::Version));
    }
    if args.iter().any(|a| a == ROLLBACK_FLAG) {
        return Ok(Some(Request::Rollback));
    }
    match args.iter().position(|a| a == UPDATE_FLAG) {
        None => Ok(None),
        Some(i) => match args.get(i + 1) {
            Some(url) if !url.starts_with("--") => Ok(Some(Request::Update { manifest_url: url.clone() })),
            _ => Err(format!("{UPDATE_FLAG} attend l'URL https:// du manifeste")),
        },
    }
}

/// Fichier à remplacer : l'AppImage si on tourne dedans, sinon l'exécutable. Si le processus tourne depuis la version
/// précédente (`<fichier>.previous`), c'est le fichier principal qui est visé : lancer la version N-1 avec `--rollback` est
/// la procédure de secours quand la nouvelle version ne démarre plus.
fn target() -> Result<PathBuf, String> {
    let running = match std::env::var_os("APPIMAGE") {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => std::env::current_exe().map_err(|e| format!("exécutable courant introuvable : {e}"))?,
    };
    Ok(main_file(&running))
}

/// `<fichier>.previous` → `<fichier>` ; tout autre chemin est rendu tel quel.
fn main_file(running: &std::path::Path) -> PathBuf {
    let suffix = previous_path(std::path::Path::new("")).into_os_string();
    let name = running.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match name.strip_suffix(suffix.to_string_lossy().as_ref()) {
        Some(stem) if !stem.is_empty() => running.with_file_name(stem),
        _ => running.to_path_buf(),
    }
}

/// Ligne affichée par `--version` : nom et version du binaire qui tourne (celle de `desktop/Cargo.toml` à la compilation).
pub fn version_line() -> String {
    format!("waifu-desktop {}", env!("CARGO_PKG_VERSION"))
}

/// Exécute la demande et renvoie le code de sortie du processus. Après une mise à jour réussie sous Unix, le nouveau
/// binaire est relancé à la place du processus courant.
pub fn run(request: Request) -> ExitCode {
    if request == Request::Version {
        println!("{}", version_line());
        return ExitCode::SUCCESS;
    }
    let target = match target() {
        Ok(target) => target,
        Err(message) => return fail(&message),
    };
    match request {
        Request::Version => ExitCode::SUCCESS,
        Request::Rollback => match rollback(&target) {
            Ok(()) => {
                println!("version précédente réactivée : {} (relancez l'application)", target.display());
                ExitCode::SUCCESS
            }
            // Le fichier visé est nommé : lancé hors du lanceur AppImage (`$APPIMAGE` absent), c'est l'exécutable courant.
            Err(err) => fail(&format!("{err} (fichier visé : {})", target.display())),
        },
        Request::Update { manifest_url } => {
            let Some(key_hex) = PUBLIC_KEY.filter(|k| !k.is_empty()) else {
                return fail("mises à jour désactivées : aucune clé publique compilée (variable de build WAIFU_UPDATE_PUBKEY)");
            };
            let key = match public_key_from_hex(key_hex) {
                Ok(key) => key,
                Err(err) => return fail(&err.to_string()),
            };
            let current = match Version::parse(env!("CARGO_PKG_VERSION")) {
                Ok(version) => version,
                Err(err) => return fail(&err.to_string()),
            };
            let fetcher = CurlFetcher { policy: UrlPolicy::HttpsOnly };
            let signature_url = format!("{manifest_url}.sig");
            match check_and_apply(&fetcher, UrlPolicy::HttpsOnly, &manifest_url, &signature_url, &key, &current, &target) {
                Ok(Outcome::UpToDate) => {
                    println!("à jour ({current})");
                    ExitCode::SUCCESS
                }
                Ok(Outcome::Updated { from, to }) => {
                    println!("mis à jour {from} → {to} ; version précédente : {}", previous_path(&target).display());
                    restart(&target)
                }
                Err(err) => fail(&err.to_string()),
            }
        }
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("waifu-desktop : {message}");
    ExitCode::FAILURE
}

/// Relance le binaire installé (sans les options de mise à jour). Unix : remplace le processus ; sinon : lance et sort.
fn restart(target: &std::path::Path) -> ExitCode {
    let mut command = std::process::Command::new(target);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = command.exec();
        fail(&format!("relance impossible : {err}"))
    }
    #[cfg(not(unix))]
    {
        match command.spawn() {
            Ok(_) => ExitCode::SUCCESS,
            Err(err) => fail(&format!("relance impossible : {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn update_and_rollback_flags_are_parsed() {
        assert_eq!(parse(&args(&[])), Ok(None));
        assert_eq!(parse(&args(&["--demo-ui"])), Ok(None));
        assert_eq!(parse(&args(&["--rollback"])), Ok(Some(Request::Rollback)));
        assert_eq!(
            parse(&args(&["--update", "https://exemple.org/manifest.json"])),
            Ok(Some(Request::Update { manifest_url: "https://exemple.org/manifest.json".to_owned() }))
        );
    }

    #[test]
    fn running_from_the_previous_version_targets_the_main_file() {
        use std::path::Path;
        assert_eq!(main_file(Path::new("/opt/waifu/WaifuChat.AppImage.previous")), Path::new("/opt/waifu/WaifuChat.AppImage"));
        assert_eq!(main_file(Path::new("/opt/waifu/WaifuChat.AppImage")), Path::new("/opt/waifu/WaifuChat.AppImage"));
        assert_eq!(main_file(Path::new("/opt/.previous")), Path::new("/opt/.previous"), "pas de nom vide");
    }

    #[test]
    fn version_flag_is_parsed_and_reports_the_cargo_version() {
        assert_eq!(parse(&args(&["--version"])), Ok(Some(Request::Version)));
        assert_eq!(version_line(), format!("waifu-desktop {}", env!("CARGO_PKG_VERSION")));
        assert!(version_line().ends_with(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn update_without_a_url_is_an_error() {
        assert!(parse(&args(&["--update"])).is_err());
        assert!(parse(&args(&["--update", "--rollback-not"])).is_err());
    }
}
