//! Mise à jour de bout en bout, sans réseau : deux « versions » factices (scripts shell) dans un dossier temporaire.
//! Signature valide / invalide, sha256 correct / faux, refus sans remplacement, rollback, politique d'URL, outil en ligne
//! de commande réel. Les clés sont jetables (générées par chaque test) : aucune vraie clé, rien dans le dépôt.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use updater::{
    apply, check_and_apply, generate_keypair, previous_path, public_key_from_hex, rollback, sha256_hex, sign_manifest, verify_binary,
    verify_manifest, CurlFetcher, Fetcher, FileFetcher, Manifest, Outcome, UpdateError, UrlPolicy, Version,
};

const V1: &[u8] = b"#!/bin/sh\necho waifu-1.0.0\n";
const V2: &[u8] = b"#!/bin/sh\necho waifu-2.0.0\n";

struct Release {
    dir: tempfile::TempDir,
    secret: String,
    public: String,
}

impl Release {
    fn new() -> Self {
        let (secret, public) = generate_keypair().expect("clés jetables");
        Self { dir: tempfile::tempdir().expect("dossier temporaire"), secret, public }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Publie `binary` en version `version` : binaire, manifeste et signature, dans le dossier du test.
    fn publish(&self, version: &str, binary: &[u8]) -> (String, String) {
        fs::write(self.path("release.bin"), binary).expect("binaire");
        let manifest = Manifest {
            version: version.to_owned(),
            url: format!("file://{}", self.path("release.bin").display()),
            sha256: sha256_hex(binary),
            size: binary.len() as u64,
            notes: "notes de test".to_owned(),
        };
        let bytes = serde_json::to_vec_pretty(&manifest).expect("manifeste");
        fs::write(self.path("manifest.json"), &bytes).expect("manifeste");
        fs::write(self.path("manifest.json.sig"), sign_manifest(&bytes, &self.secret).expect("signature")).expect("signature");
        (format!("file://{}", self.path("manifest.json").display()), format!("file://{}", self.path("manifest.json.sig").display()))
    }

    fn installed(&self, content: &[u8]) -> PathBuf {
        let target = self.path("waifu-installed");
        fs::write(&target, content).expect("version installée");
        target
    }

    fn key(&self) -> ed25519_dalek::VerifyingKey {
        public_key_from_hex(&self.public).expect("clé publique")
    }
}

/// Transport qui compte ce qu'on lui demande : prouve qu'un binaire n'est pas téléchargé sur signature invalide.
struct Counting {
    urls: RefCell<Vec<String>>,
}

impl Fetcher for Counting {
    fn fetch(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError> {
        self.urls.borrow_mut().push(url.to_owned());
        FileFetcher.fetch(url, max_bytes)
    }
}

fn run_script(path: &Path) -> String {
    let out = Command::new("sh").arg(path).output().expect("exécution");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn leftovers(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).expect("dossier").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.retain(|n| n.ends_with(".new") || n.ends_with(".rollback"));
    names
}

// ── signature ─────────────────────────────────────────────────────────────────────────

#[test]
fn a_manifest_signed_with_the_right_key_is_accepted() {
    let release = Release::new();
    release.publish("2.0.0", V2);
    let manifest = verify_manifest(
        &fs::read(release.path("manifest.json")).unwrap(),
        &fs::read(release.path("manifest.json.sig")).unwrap(),
        &release.key(),
    )
    .expect("signature valide");
    assert_eq!((manifest.version.as_str(), manifest.size), ("2.0.0", V2.len() as u64));
    assert_eq!(manifest.sha256, sha256_hex(V2));
}

#[test]
fn a_signature_from_another_key_is_refused() {
    let (release, other) = (Release::new(), Release::new());
    release.publish("2.0.0", V2);
    let result = verify_manifest(&fs::read(release.path("manifest.json")).unwrap(), &fs::read(release.path("manifest.json.sig")).unwrap(), &other.key());
    assert!(matches!(result, Err(UpdateError::BadSignature)), "{result:?}");
}

#[test]
fn a_tampered_manifest_is_refused_even_if_it_is_still_valid_json() {
    let release = Release::new();
    release.publish("2.0.0", V2);
    let signature = fs::read(release.path("manifest.json.sig")).unwrap();
    let genuine = fs::read_to_string(release.path("manifest.json")).unwrap();
    // L'attaquant redirige l'URL vers son binaire : JSON valide, signature d'origine.
    let tampered = genuine.replace("release.bin", "evil.bin");
    assert_ne!(tampered, genuine);
    assert!(matches!(verify_manifest(tampered.as_bytes(), &signature, &release.key()), Err(UpdateError::BadSignature)));
}

#[test]
fn malformed_signatures_and_keys_are_refused() {
    let release = Release::new();
    let (_, bytes) = (release.publish("2.0.0", V2), fs::read(release.path("manifest.json")).unwrap());
    for bad in [&b""[..], b"zz", b"00", &[0xff, 0xfe][..], "ab".repeat(63).as_bytes(), "ab".repeat(65).as_bytes()] {
        assert!(matches!(verify_manifest(&bytes, bad, &release.key()), Err(UpdateError::BadSignature)), "{bad:?}");
    }
    for bad in ["", "abcd", &"g".repeat(64), &"ab".repeat(33)] {
        assert!(matches!(public_key_from_hex(bad), Err(UpdateError::BadKey)), "{bad:?}");
    }
}

#[test]
fn a_signed_manifest_must_still_be_well_formed() {
    let release = Release::new();
    for body in [
        r#"{"version":"2.0","url":"https://x/a","sha256":"00","size":1}"#.to_owned(),
        format!(r#"{{"version":"2.0.0","url":"https://x/a","sha256":"{}","size":1}}"#, "A".repeat(64)),
        format!(r#"{{"version":"2.0.0","url":"","sha256":"{}","size":1}}"#, "a".repeat(64)),
        format!(r#"{{"version":"2.0.0","url":"https://x/a","sha256":"{}","size":1,"extra":true}}"#, "a".repeat(64)),
        "pas du json".to_owned(),
    ] {
        let signature = sign_manifest(body.as_bytes(), &release.secret).unwrap();
        let result = verify_manifest(body.as_bytes(), signature.as_bytes(), &release.key());
        assert!(matches!(result, Err(UpdateError::BadManifest(_))), "{body} → {result:?}");
    }
}

// ── sha256 et taille ──────────────────────────────────────────────────────────────────

#[test]
fn the_binary_must_match_the_manifest_sha256_and_size() {
    let manifest = Manifest { version: "2.0.0".into(), url: "https://x/a".into(), sha256: sha256_hex(V2), size: V2.len() as u64, notes: String::new() };
    assert!(verify_binary(&manifest, V2).is_ok());
    let mut flipped = V2.to_vec();
    flipped[3] ^= 1;
    assert!(matches!(verify_binary(&manifest, &flipped), Err(UpdateError::HashMismatch)), "un octet changé, même taille");
    assert!(matches!(verify_binary(&manifest, &V2[..5]), Err(UpdateError::SizeMismatch { .. })));
    assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "vecteur connu : sha256 du vide");
}

// ── remplacement et rollback ──────────────────────────────────────────────────────────

#[test]
fn apply_replaces_the_binary_and_keeps_the_previous_one() {
    let release = Release::new();
    let target = release.installed(V1);
    apply(&target, V2).expect("remplacement");
    assert_eq!(fs::read(&target).unwrap(), V2);
    assert_eq!(fs::read(previous_path(&target)).unwrap(), V1, "la version N-1 reste sur disque");
    assert!(leftovers(release.dir.path()).is_empty(), "aucun fichier temporaire");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(fs::metadata(&target).unwrap().permissions().mode() & 0o111, 0, "le nouveau binaire est exécutable");
    }
    assert_eq!(run_script(&target), "waifu-2.0.0", "le nouveau binaire s'exécute");
}

#[test]
fn apply_on_a_missing_target_fails_without_creating_anything() {
    let release = Release::new();
    let target = release.path("absent");
    assert!(matches!(apply(&target, V2), Err(UpdateError::TargetMissing)));
    assert!(!target.exists() && !previous_path(&target).exists());
}

#[test]
fn rollback_swaps_back_and_forth_and_refuses_without_a_previous_version() {
    let release = Release::new();
    let target = release.installed(V1);
    assert!(matches!(rollback(&target), Err(UpdateError::NoPrevious)), "pas de N-1 avant une première mise à jour");
    assert_eq!(fs::read(&target).unwrap(), V1, "rien n'a bougé");

    apply(&target, V2).unwrap();
    rollback(&target).expect("retour à N-1");
    assert_eq!((fs::read(&target).unwrap(), run_script(&target)), (V1.to_vec(), "waifu-1.0.0".to_owned()));
    assert_eq!(fs::read(previous_path(&target)).unwrap(), V2, "la version 2 est rangée, pas perdue");
    rollback(&target).expect("on peut re-avancer");
    assert_eq!(fs::read(&target).unwrap(), V2);
    assert!(leftovers(release.dir.path()).is_empty());
}

// ── chaîne complète ───────────────────────────────────────────────────────────────────

#[test]
fn a_valid_newer_release_updates_and_the_new_version_runs() {
    let release = Release::new();
    let target = release.installed(V1);
    let (manifest_url, sig_url) = release.publish("2.0.0", V2);
    let outcome = check_and_apply(&FileFetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &release.key(), &Version(1, 0, 0), &target).expect("mise à jour");
    assert_eq!(outcome, Outcome::Updated { from: Version(1, 0, 0), to: Version(2, 0, 0) });
    assert_eq!(run_script(&target), "waifu-2.0.0");
    assert_eq!(run_script(&previous_path(&target)), "waifu-1.0.0");
}

#[test]
fn an_up_to_date_client_downloads_no_binary() {
    let release = Release::new();
    let target = release.installed(V1);
    let (manifest_url, sig_url) = release.publish("1.0.0", V1);
    let fetcher = Counting { urls: RefCell::new(Vec::new()) };
    let outcome = check_and_apply(&fetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &release.key(), &Version(1, 0, 0), &target).unwrap();
    assert_eq!(outcome, Outcome::UpToDate);
    assert_eq!(fetcher.urls.borrow().len(), 2, "manifeste et signature seulement");
    assert!(!previous_path(&target).exists());
}

#[test]
fn a_bad_signature_replaces_nothing_and_downloads_no_binary() {
    let (release, other) = (Release::new(), Release::new());
    let target = release.installed(V1);
    let (manifest_url, sig_url) = release.publish("2.0.0", V2);
    let fetcher = Counting { urls: RefCell::new(Vec::new()) };
    let result = check_and_apply(&fetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &other.key(), &Version(1, 0, 0), &target);
    assert!(matches!(result, Err(UpdateError::BadSignature)), "{result:?}");
    assert_eq!(fs::read(&target).unwrap(), V1, "installation inchangée octet pour octet");
    assert!(!previous_path(&target).exists() && leftovers(release.dir.path()).is_empty());
    assert!(fetcher.urls.borrow().iter().all(|u| !u.ends_with("release.bin")), "le binaire n'a pas été téléchargé : {:?}", fetcher.urls.borrow());
}

#[test]
fn a_binary_that_does_not_match_the_signed_hash_replaces_nothing() {
    let release = Release::new();
    let target = release.installed(V1);
    let (manifest_url, sig_url) = release.publish("2.0.0", V2);
    // Le serveur est compromis après la signature : même taille, contenu différent.
    let mut evil = V2.to_vec();
    evil[10] ^= 0xff;
    fs::write(release.path("release.bin"), &evil).unwrap();
    let result = check_and_apply(&FileFetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &release.key(), &Version(1, 0, 0), &target);
    assert!(matches!(result, Err(UpdateError::HashMismatch)), "{result:?}");
    assert_eq!(fs::read(&target).unwrap(), V1);
    assert!(!previous_path(&target).exists() && leftovers(release.dir.path()).is_empty());

    // Taille différente : refusé aussi.
    fs::write(release.path("release.bin"), &V2[..8]).unwrap();
    let result = check_and_apply(&FileFetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &release.key(), &Version(1, 0, 0), &target);
    assert!(matches!(result, Err(UpdateError::SizeMismatch { .. })), "{result:?}");
    assert_eq!(fs::read(&target).unwrap(), V1);
}

#[test]
fn an_older_signed_version_is_refused_as_a_downgrade() {
    let release = Release::new();
    let target = release.installed(V2);
    let (manifest_url, sig_url) = release.publish("1.0.0", V1);
    let result = check_and_apply(&FileFetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &release.key(), &Version(2, 0, 0), &target);
    assert!(matches!(result, Err(UpdateError::Downgrade { .. })), "{result:?}");
    assert_eq!(fs::read(&target).unwrap(), V2);
}

#[test]
fn the_production_policy_accepts_only_https() {
    let release = Release::new();
    let target = release.installed(V1);
    let (manifest_url, sig_url) = release.publish("2.0.0", V2);
    // `file://` est refusé par la politique de production, sans même ouvrir le fichier.
    let result = check_and_apply(&FileFetcher, UrlPolicy::HttpsOnly, &manifest_url, &sig_url, &release.key(), &Version(1, 0, 0), &target);
    assert!(matches!(result, Err(UpdateError::ForbiddenUrl(_))), "{result:?}");
    for url in ["http://exemple.org/m.json", "ftp://exemple.org/m", "javascript:alert(1)", ""] {
        assert!(UrlPolicy::HttpsOnly.check(url).is_err(), "{url}");
    }
    assert!(UrlPolicy::HttpsOnly.check("https://exemple.org/m.json").is_ok());
    assert_eq!(fs::read(&target).unwrap(), V1);
}

#[test]
fn a_signed_manifest_pointing_to_a_plain_http_binary_is_refused() {
    let release = Release::new();
    let target = release.installed(V1);
    let manifest = Manifest { version: "2.0.0".into(), url: "http://exemple.org/a.bin".into(), sha256: sha256_hex(V2), size: V2.len() as u64, notes: String::new() };
    let bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(release.path("manifest.json"), &bytes).unwrap();
    fs::write(release.path("manifest.json.sig"), sign_manifest(&bytes, &release.secret).unwrap()).unwrap();
    let (m, s) = (format!("file://{}", release.path("manifest.json").display()), format!("file://{}", release.path("manifest.json.sig").display()));
    // Manifeste et signature en `file://` (autorisés ici) ; le binaire en `http://` ne passe pas la politique `HttpsOnly`.
    let result = check_and_apply(&FileFetcher, UrlPolicy::AllowFile, &m, &s, &release.key(), &Version(1, 0, 0), &target);
    assert!(matches!(result, Err(UpdateError::ForbiddenUrl(_))), "{result:?}");
    assert_eq!(fs::read(&target).unwrap(), V1);
}

#[test]
fn curl_fetches_local_files_and_refuses_oversize_and_missing_ones() {
    if Command::new("curl").arg("--version").output().is_err() {
        eprintln!("curl absent : test sauté");
        return;
    }
    let release = Release::new();
    let (manifest_url, sig_url) = release.publish("2.0.0", V2);
    let fetcher = CurlFetcher { policy: UrlPolicy::AllowFile };
    assert_eq!(fetcher.fetch(&format!("file://{}", release.path("release.bin").display()), 1024).unwrap(), V2);
    assert!(fetcher.fetch(&format!("file://{}", release.path("release.bin").display()), 4).is_err(), "plafond de taille");
    assert!(fetcher.fetch("file:///inexistant/xyz", 1024).is_err());
    assert!(matches!(CurlFetcher { policy: UrlPolicy::HttpsOnly }.fetch(&manifest_url, 1024), Err(UpdateError::ForbiddenUrl(_))));

    let target = release.installed(V1);
    let outcome = check_and_apply(&fetcher, UrlPolicy::AllowFile, &manifest_url, &sig_url, &release.key(), &Version(1, 0, 0), &target).unwrap();
    assert!(matches!(outcome, Outcome::Updated { .. }));
    assert_eq!(fs::read(&target).unwrap(), V2);
}

// ── outil en ligne de commande, réel ──────────────────────────────────────────────────

fn tool(args: &[&str]) -> (bool, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_waifu-updater")).args(args).output().expect("waifu-updater");
    (out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn the_command_line_tool_publishes_verifies_updates_and_rolls_back() {
    if Command::new("curl").arg("--version").output().is_err() {
        eprintln!("curl absent : test sauté");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let p = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
    let (keys, v2, target) = (p("keys"), p("v2.bin"), p("installed"));
    fs::write(&v2, V2).unwrap();
    fs::write(&target, V1).unwrap();

    let (ok, stdout, _) = tool(&["keygen", "--out-dir", &keys]);
    assert!(ok, "keygen");
    let secret = fs::read_to_string(format!("{keys}/update.key")).unwrap();
    assert!(!stdout.contains(secret.trim()), "la clé secrète n'est jamais affichée");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(format!("{keys}/update.key")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!tool(&["keygen", "--out-dir", &keys]).0, "une clé existante n'est jamais écrasée");

    let url = format!("file://{v2}");
    assert!(tool(&["manifest", "--version", "2.0.0", "--url", &url, "--file", &v2, "--out", &p("manifest.json")]).0);
    assert!(tool(&["sign", "--key", &format!("{keys}/update.key"), &p("manifest.json")]).0);
    let (ok, stdout, _) = tool(&["verify", "--pub", &format!("{keys}/update.pub"), &p("manifest.json")]);
    assert!(ok && stdout.contains(&sha256_hex(V2)), "{stdout}");

    // Une autre clé publique ne valide pas ce manifeste.
    let other = p("other");
    assert!(tool(&["keygen", "--out-dir", &other]).0);
    let (ok, _, stderr) = tool(&["verify", "--pub", &format!("{other}/update.pub"), &p("manifest.json")]);
    assert!(!ok && stderr.contains("signature"), "{stderr}");

    let update = |pubkey: &str| {
        tool(&[
            "update", "--manifest-url", &format!("file://{}", p("manifest.json")), "--sig-url", &format!("file://{}", p("manifest.json.sig")),
            "--pub", pubkey, "--current", "1.0.0", "--target", &target, "--allow-file",
        ])
    };
    let (ok, _, stderr) = update(&format!("{other}/update.pub"));
    assert!(!ok && stderr.contains("rien n'a été remplacé"), "{stderr}");
    assert_eq!(fs::read(&target).unwrap(), V1, "mauvaise clé : installation intacte");

    let (ok, stdout, stderr) = update(&format!("{keys}/update.pub"));
    assert!(ok, "{stderr}");
    assert!(stdout.contains("1.0.0 → 2.0.0"), "{stdout}");
    assert_eq!(run_script(Path::new(&target)), "waifu-2.0.0");

    let (ok, _, stderr) = tool(&["rollback", "--target", &target]);
    assert!(ok, "{stderr}");
    assert_eq!(run_script(Path::new(&target)), "waifu-1.0.0");
}
