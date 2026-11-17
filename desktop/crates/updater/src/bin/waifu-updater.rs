//! Outil de publication et de mise à jour de WaifuChat (W07).
//!
//! ```text
//! waifu-updater keygen   --out-dir DIR                       paire de clés ed25519 jetable (update.key 0600, update.pub)
//! waifu-updater manifest --version X.Y.Z --url URL --file F [--notes TXT] --out manifest.json
//! waifu-updater sign     --key update.key manifest.json      écrit manifest.json.sig
//! waifu-updater verify   --pub update.pub manifest.json      vérifie manifest.json avec manifest.json.sig
//! waifu-updater update   --manifest-url U --sig-url U --pub update.pub --current X.Y.Z --target FICHIER [--allow-file]
//! waifu-updater rollback --target FICHIER
//! ```
//! La clé secrète n'est jamais affichée. Codes de sortie : 0 succès, 1 échec (message sur stderr), 2 usage.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use updater::{
    check_and_apply, generate_keypair, public_key_from_hex, rollback, sha256_hex, sign_manifest, verify_manifest, CurlFetcher, Manifest,
    Outcome, UrlPolicy, Version,
};

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn need(args: &[String], name: &str) -> Result<String, String> {
    flag(args, name).ok_or_else(|| format!("option manquante : {name}"))
}

fn positional(args: &[String]) -> Option<String> {
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
        } else if arg.starts_with("--") {
            skip = arg != "--allow-file";
        } else {
            return Some(arg.clone());
        }
    }
    None
}

fn write_secret(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(text.as_bytes())
}

fn run(command: &str, args: &[String]) -> Result<String, String> {
    match command {
        "keygen" => {
            let dir = PathBuf::from(need(args, "--out-dir")?);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let (secret, public) = generate_keypair().map_err(|e| e.to_string())?;
            write_secret(&dir.join("update.key"), &secret).map_err(|e| format!("update.key : {e}"))?;
            std::fs::write(dir.join("update.pub"), &public).map_err(|e| e.to_string())?;
            Ok(format!("clés écrites dans {} (update.key : secrète, mode 0600 ; update.pub : {public})", dir.display()))
        }
        "manifest" => {
            let version = need(args, "--version")?;
            Version::parse(&version).map_err(|e| e.to_string())?;
            let file = need(args, "--file")?;
            let bytes = std::fs::read(&file).map_err(|e| format!("{file} : {e}"))?;
            let manifest = Manifest {
                version,
                url: need(args, "--url")?,
                sha256: sha256_hex(&bytes),
                size: bytes.len() as u64,
                notes: flag(args, "--notes").unwrap_or_default(),
            };
            let out = need(args, "--out")?;
            std::fs::write(&out, serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            Ok(format!("{out} : version {} sha256 {} ({} o)", manifest.version, manifest.sha256, manifest.size))
        }
        "sign" => {
            let manifest = positional(args).ok_or("fichier manifeste manquant")?;
            let secret = std::fs::read_to_string(need(args, "--key")?).map_err(|e| format!("clé : {e}"))?;
            let bytes = std::fs::read(&manifest).map_err(|e| format!("{manifest} : {e}"))?;
            let signature = sign_manifest(&bytes, secret.trim()).map_err(|e| e.to_string())?;
            std::fs::write(format!("{manifest}.sig"), &signature).map_err(|e| e.to_string())?;
            Ok(format!("{manifest}.sig écrit ({} caractères)", signature.len()))
        }
        "verify" => {
            let manifest = positional(args).ok_or("fichier manifeste manquant")?;
            let key = public_key_from_hex(&std::fs::read_to_string(need(args, "--pub")?).map_err(|e| format!("clé publique : {e}"))?)
                .map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&manifest).map_err(|e| format!("{manifest} : {e}"))?;
            let signature = std::fs::read(format!("{manifest}.sig")).map_err(|e| format!("signature : {e}"))?;
            let parsed = verify_manifest(&bytes, &signature, &key).map_err(|e| e.to_string())?;
            Ok(format!("signature valide : version {} sha256 {}", parsed.version, parsed.sha256))
        }
        "update" => {
            let policy = if args.iter().any(|a| a == "--allow-file") { UrlPolicy::AllowFile } else { UrlPolicy::HttpsOnly };
            let key = public_key_from_hex(&std::fs::read_to_string(need(args, "--pub")?).map_err(|e| format!("clé publique : {e}"))?)
                .map_err(|e| e.to_string())?;
            let current = Version::parse(&need(args, "--current")?).map_err(|e| e.to_string())?;
            let target = PathBuf::from(need(args, "--target")?);
            let outcome = check_and_apply(
                &CurlFetcher { policy },
                policy,
                &need(args, "--manifest-url")?,
                &need(args, "--sig-url")?,
                &key,
                &current,
                &target,
            )
            .map_err(|e| e.to_string())?;
            Ok(match outcome {
                Outcome::UpToDate => format!("à jour ({current})"),
                Outcome::Updated { from, to } => format!("mis à jour {from} → {to} ; version précédente conservée dans {}", updater::previous_path(&target).display()),
            })
        }
        "rollback" => {
            let target = PathBuf::from(need(args, "--target")?);
            rollback(&target).map_err(|e| e.to_string())?;
            Ok(format!("version précédente réactivée : {}", target.display()))
        }
        other => Err(format!("commande inconnue : {other}")),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = args.split_first() else {
        eprintln!("usage : waifu-updater keygen|manifest|sign|verify|update|rollback … (voir l'en-tête de src/bin/waifu-updater.rs)");
        return ExitCode::from(2);
    };
    match run(command, rest) {
        Ok(message) => {
            println!("{message}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("waifu-updater : {message}");
            ExitCode::FAILURE
        }
    }
}

