//! Point d'entrée de `waifu-desktop` : ouvre la fenêtre principale.

mod bridge;
mod root;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gpui_kit::*;
use bridge::Bridge;
use root::AppRoot;
use ui::MainView;

/// Nom de l'application, utilisé comme titre de fenêtre.
const APP_TITLE: &str = "WaifuChat";

/// Nom du dossier de données du client natif, sous le dossier de données de l'utilisateur
/// (Linux : `~/.local/share/waifu-desktop-rust/`).
///
/// Volontairement **distinct** de celui de l'app Electron, pour ne jamais écraser sa session.
const DATA_DIR_NAME: &str = "waifu-desktop-rust";

const WINDOW_WIDTH: f32 = 1200.0;
const WINDOW_HEIGHT: f32 = 800.0;

/// Sous Linux, GPUI bascule en mode headless s'il ne trouve aucun serveur d'affichage, puis attend
/// indéfiniment sans ouvrir de fenêtre : on refuse de démarrer plutôt que de rester muet.
#[cfg(target_os = "linux")]
fn has_display() -> bool {
    ["WAYLAND_DISPLAY", "DISPLAY"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
}

#[cfg(not(target_os = "linux"))]
fn has_display() -> bool {
    true
}

/// Dossier de données : `<données utilisateur>/waifu-desktop-rust` (jamais celui d'Electron).
fn data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(DATA_DIR_NAME))
}

/// Argument qui lance l'écran principal en démonstration hors ligne (voir [`MainView::demo`]).
const DEMO_FLAG: &str = "--demo-ui";
/// Variante de la démonstration : timeline du salon « général » affichée, modal fermé.
const DEMO_TIMELINE_FLAG: &str = "--demo-timeline";
/// Variante : comme `--demo-timeline`, avec un message déjà envoyé dont l'écho reste « envoi… ».
const DEMO_SEND_FLAG: &str = "--demo-send";
/// Variante : médias de démonstration (images générées, fichier, image chiffrée indisponible, échec d'envoi).
const DEMO_MEDIA_FLAG: &str = "--demo-media";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let demo_media = args.iter().any(|arg| arg == DEMO_MEDIA_FLAG);
    let demo_send = args.iter().any(|arg| arg == DEMO_SEND_FLAG);
    let demo_timeline = demo_media || demo_send || args.iter().any(|arg| arg == DEMO_TIMELINE_FLAG);
    let demo = demo_timeline || args.iter().any(|arg| arg == DEMO_FLAG);

    if !has_display() {
        eprintln!("{APP_TITLE} : aucun affichage détecté (ni WAYLAND_DISPLAY ni DISPLAY) ; impossible d'ouvrir la fenêtre.");
        return ExitCode::FAILURE;
    }

    // Mode démo : ni runtime réseau, ni dossier de données, ni client Matrix.
    let bridge = if demo {
        None
    } else {
        let Some(data_dir) = data_dir() else {
            eprintln!("{APP_TITLE} : dossier de données utilisateur introuvable.");
            return ExitCode::FAILURE;
        };
        match tokio::runtime::Runtime::new() {
            Ok(runtime) => Some(Bridge::new(Arc::new(runtime), data_dir)),
            Err(err) => {
                eprintln!("{APP_TITLE} : impossible de démarrer le runtime réseau : {err}");
                return ExitCode::FAILURE;
            }
        }
    };

    let failed = Arc::new(AtomicBool::new(false));
    let failed_in_app = Arc::clone(&failed);

    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);

        let bounds = Bounds::centered(None, size(px(WINDOW_WIDTH), px(WINDOW_HEIGHT)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(APP_TITLE.into()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let opened = match bridge {
            Some(bridge) => gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| AppRoot::new(bridge, window, cx))
            })
            .map(|_| ()),
            None => gpui_kit::open_window(options, cx, |window, cx| {
                cx.new(|cx| {
                    if demo_media {
                        MainView::demo_media(window, cx)
                    } else if demo_send {
                        MainView::demo_send(window, cx)
                    } else if demo_timeline {
                        MainView::demo_timeline(window, cx)
                    } else {
                        MainView::demo(window, cx)
                    }
                })
            })
            .map(|_| ()),
        };

        if let Err(err) = opened {
            eprintln!("{APP_TITLE} : impossible d'ouvrir la fenêtre : {err:#}");
            failed_in_app.store(true, Ordering::SeqCst);
            cx.quit();
        }
    });

    if failed.load(Ordering::SeqCst) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
