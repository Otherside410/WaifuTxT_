//! Sonde W08 : ce que `livekit` 0.11.0 permet réellement sur cette VM (sans carte son, sans SFU, sous Xvfb).
//! Imprime des faits (durées, erreurs), jamais de jugement. Aucun compte, aucun jeton, aucun réseau applicatif.

use std::time::{Duration, Instant};

use livekit::e2ee::key_provider::{KeyProvider, KeyProviderOptions};
use livekit::id::ParticipantIdentity;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::AudioSourceOptions;
use livekit::webrtc::desktop_capturer::{DesktopCaptureSourceType, DesktopCapturer, DesktopCapturerOptions};
use livekit::webrtc::native::apm::AudioProcessingModule;
use livekit::webrtc::native::yuv_helper::i420_to_abgr;
use livekit::webrtc::video_frame::I420Buffer;
use livekit::{PlatformAudio, Room, RoomOptions};

#[tokio::main]
async fn main() {
    // 1. Périphériques audio via l'Audio Device Module de WebRTC.
    let started = Instant::now();
    match PlatformAudio::new() {
        Ok(audio) => {
            let rec: Vec<_> = audio.recording_devices().map(|d| d.name).collect();
            let out: Vec<_> = audio.playout_devices().map(|d| d.name).collect();
            println!("[1] PlatformAudio::new OK en {:?} ; entrées={rec:?} ; sorties={out:?}", started.elapsed());
        }
        Err(err) => println!("[1] PlatformAudio::new ÉCHEC en {:?} : {err}", started.elapsed()),
    }

    // 2. Pont de clés E2EE : mêmes paramètres que le web (ratchetWindowSize 10, keyringSize 256 → plafonné à 255 ici).
    let provider = KeyProvider::new(KeyProviderOptions { ratchet_window_size: 10, key_ring_size: 256, ..Default::default() });
    let id = ParticipantIdentity("@alice:example.org:DEVICE".to_owned());
    let set = provider.set_key(&id, 0, vec![7u8; 16]);
    println!("[2] KeyProvider : key_ring_size effectif={} ; set_key={set} ; get_key identique={}", provider.key_ring_size(), provider.get_key(&id, 0) == Some(vec![7u8; 16]));

    // 3. Traitement audio (AEC / AGC / filtre passe-haut / NS) fourni par libwebrtc : coût par trame de 10 ms.
    let mut apm = AudioProcessingModule::new(true, true, true, true);
    let mut frame = vec![0i16; 480]; // 10 ms, 48 kHz, mono
    for (i, s) in frame.iter_mut().enumerate() {
        *s = ((i as f32 * 0.05).sin() * 8000.0) as i16;
    }
    let n = 2000;
    let started = Instant::now();
    for _ in 0..n {
        let mut f = frame.clone();
        apm.process_stream(&mut f, 48_000, 1).expect("apm");
    }
    let per = started.elapsed().as_secs_f64() * 1e6 / n as f64;
    println!("[3] APM (AEC+AGC+HPF+NS) : {n} trames de 10 ms en {:?} → {per:.1} µs / trame (profil {})", started.elapsed(), if cfg!(debug_assertions) { "debug" } else { "release" });

    // 4. Source audio « manuelle » (capture système, TTS…) : création et poussée d'une trame.
    let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 2, 100);
    println!("[4] NativeAudioSource créée (48 kHz, 2 canaux, file 100 ms) : {}Hz", source.sample_rate());

    // 5. Capture d'écran (DesktopCapturer) : sources et cadence sur l'écran X11 courant.
    let mut options = DesktopCapturerOptions::new(DesktopCaptureSourceType::Screen);
    options.set_include_cursor(false);
    match DesktopCapturer::new(options) {
        None => println!("[5] DesktopCapturer::new → None (DISPLAY={:?})", std::env::var("DISPLAY").ok()),
        Some(mut capturer) => {
            let sources = capturer.get_source_list();
            println!("[5] sources d'écran : {:?}", sources.iter().map(|s| format!("{}#{}", s.title(), s.id())).collect::<Vec<_>>());
            let frames = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let dims = std::sync::Arc::new(std::sync::Mutex::new((0, 0)));
            let (f2, d2) = (frames.clone(), dims.clone());
            capturer.start_capture(sources.first().cloned(), move |res| {
                if let Ok(frame) = res {
                    f2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    *d2.lock().unwrap() = (frame.width(), frame.height());
                }
            });
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(2) {
                capturer.capture_frame();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let count = frames.load(std::sync::atomic::Ordering::SeqCst);
            println!("[5] capture X11 : {count} trames en 2 s (≈ {:.1}/s), résolution {:?}", count as f64 / 2.0, *dims.lock().unwrap());
        }
    }

    // 7. Coût CPU de la conversion I420 → RGBA d'une trame reçue (ce qu'il faut avant d'afficher une vidéo dans GPUI).
    for (w, h) in [(1280u32, 720u32), (1920, 1080)] {
        let mut buf = I420Buffer::new(w, h);
        let (sy, su, sv) = buf.strides();
        {
            let (y, u, v) = buf.data_mut();
            y.iter_mut().enumerate().for_each(|(i, p)| *p = (i % 251) as u8);
            u.fill(110);
            v.fill(140);
        }
        let mut dst = vec![0u8; (w * h * 4) as usize];
        let n = 200;
        let started = Instant::now();
        for _ in 0..n {
            let (y, u, v) = buf.data();
            i420_to_abgr(y, sy, u, su, v, sv, &mut dst, w * 4, w as i32, h as i32);
        }
        let per = started.elapsed().as_secs_f64() * 1000.0 / n as f64;
        println!("[7] i420→ABGR {w}×{h} : {per:.2} ms / trame ({n} trames, {} Mo d'octets RGBA par trame)", dst.len() / 1_000_000);
    }

    // 6. Connexion à un SFU inexistant : forme de l'échec et délai (aucun serveur LiveKit sur la VM).
    let started = Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(20), Room::connect("wss://127.0.0.1:1", "jeton-factice", RoomOptions::default())).await;
    match res {
        Ok(Ok(_)) => println!("[6] connexion inattendue réussie"),
        Ok(Err(err)) => println!("[6] Room::connect vers 127.0.0.1:1 → erreur en {:?} : {err}", started.elapsed()),
        Err(_) => println!("[6] Room::connect : pas de réponse en 20 s"),
    }
}
