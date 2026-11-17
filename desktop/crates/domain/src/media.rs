//! Médias de timeline vus par l'UI : types purs, aucun handle réseau, aucune dépendance GPUI.
//!
//! La couche Matrix remplit [`MediaVm`] depuis les événements `image`/`file`/`audio`/`video` ; les octets
//! (vignette ou fichier) arrivent à part, par [`MediaPayload`], une fois téléchargés et déchiffrés.

use std::fmt;
use std::sync::Arc;

/// Taille maximale d'un envoi (fichier joint). Au-delà : message lisible, rien n'est envoyé.
pub const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;
/// Taille maximale d'une image téléchargée pour être affichée en ligne. Au-delà : « image trop volumineuse ».
pub const MAX_INLINE_IMAGE_BYTES: u64 = 12 * 1024 * 1024;
/// Côté (en pixels logiques) de la vignette réservée dans une ligne de timeline.
pub const THUMBNAIL_SIDE: u32 = 44;

/// Clé logique (cache de médias, canal `TimelineUpdate::Media`, `images` de l'UI) de la photo de profil `mxc`.
/// Préfixée pour ne jamais entrer en collision avec la clé d'un média de message portant le même `mxc://`.
pub fn avatar_key(mxc: &str) -> String {
    format!("avatar:{mxc}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    File,
    Audio,
    Video,
}

impl MediaKind {
    /// Libellé court, au masculin ou féminin selon l'usage courant.
    pub fn label(self) -> &'static str {
        match self {
            Self::Image => "Image",
            Self::File => "Fichier",
            Self::Audio => "Audio",
            Self::Video => "Vidéo",
        }
    }
}

/// État d'un média tel que le message le décrit (indépendant du téléchargement des octets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaStatus {
    /// Média référencé, rien d'anormal.
    Available,
    /// Téléversement en cours (pourcentage si connu) pour mon propre envoi.
    Uploading(Option<u8>),
    /// Téléversement échoué.
    UploadFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaVm {
    /// Identifiant logique stable du média (URI `mxc://`), clé de cache et de livraison des octets.
    pub key: String,
    pub kind: MediaKind,
    pub filename: String,
    pub size: Option<u64>,
    pub mime: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Média chiffré (clé de chiffrement portée par l'événement) : jamais récupéré en clair.
    pub encrypted: bool,
    pub status: MediaStatus,
}

impl MediaVm {
    /// Ligne de résumé : `nom · 1,2 Mo · 800×600 · image/png`.
    pub fn summary(&self) -> String {
        let mut parts = vec![self.filename.clone()];
        if let Some(size) = self.size {
            parts.push(format_size(size));
        }
        if let (Some(w), Some(h)) = (self.width, self.height) {
            parts.push(format!("{w}×{h}"));
        }
        if let Some(mime) = &self.mime {
            parts.push(mime.clone());
        }
        parts.join(" · ")
    }

    /// Dimensions de la vignette dans une boîte `max × max`, ratio conservé, jamais agrandie au-delà de
    /// la boîte ; boîte carrée si les dimensions sont inconnues.
    pub fn thumbnail_size(&self, max: u32) -> (u32, u32) {
        match (self.width, self.height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => fit_within(w, h, max, max),
            _ => (max, max),
        }
    }
}

/// Plus grande taille qui tient dans `max_w × max_h` en conservant le ratio `w:h` (au moins 1×1).
pub fn fit_within(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (max_w.max(1), max_h.max(1));
    }
    // Calcul en u64 : pas de débordement avec des dimensions de 4 000 px et plus.
    let (w64, h64) = (u64::from(w), u64::from(h));
    let (mw, mh) = (u64::from(max_w), u64::from(max_h));
    let (out_w, out_h) = if w64 * mh >= h64 * mw {
        (mw, (h64 * mw / w64).max(1))
    } else {
        ((w64 * mh / h64).max(1), mh)
    };
    (u32::try_from(out_w).unwrap_or(max_w), u32::try_from(out_h).unwrap_or(max_h))
}

/// Taille lisible, séparateur décimal français : `830 o`, `1,2 Ko`, `2,4 Mo`, `1,1 Go`.
pub fn format_size(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["Ko", "Mo", "Go", "To"];
    if bytes < 1024 {
        return format!("{bytes} o");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit]).replace('.', ",")
}

/// Format d'image reconnu par ses premiers octets (jamais par l'extension ni le type annoncé).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Bmp,
}

pub fn sniff_image_format(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageKind::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageKind::Gif)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else if bytes.starts_with(b"BM") && bytes.len() > 14 {
        Some(ImageKind::Bmp)
    } else {
        None
    }
}

/// Octets (ou échec) d'un média téléchargé, livrés par la couche Matrix.
#[derive(Clone, PartialEq, Eq)]
pub enum MediaPayload {
    Ready(Arc<Vec<u8>>),
    Failed(String),
}

impl fmt::Debug for MediaPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ready(bytes) => write!(f, "Ready({} octets)", bytes.len()),
            Self::Failed(message) => write!(f, "Failed({message:?})"),
        }
    }
}

/// Message d'affichage d'un média indisponible (jamais une erreur brute du SDK).
pub const MEDIA_UNAVAILABLE: &str = "média indisponible";

/// Ce que la ligne de timeline doit montrer pour un média.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaDisplay {
    /// Image prête à être décodée.
    Thumbnail,
    /// Image en cours de téléchargement : espace réservé de même taille.
    Loading,
    /// Média non récupérable ou non déchiffrable : espace réservé lisible.
    Unavailable(String),
    /// Fichier, audio ou vidéo : carte nom + taille.
    Card,
    Uploading(Option<u8>),
    UploadFailed(String),
}

/// État de téléchargement des octets d'un média, du point de vue de l'UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaLoad {
    Loading,
    Ready,
    Failed(String),
}

/// Décide de l'affichage d'un média selon son état déclaré et l'avancement du téléchargement.
/// Pure : aucun panic quel que soit l'état (média chiffré non déchiffrable compris).
pub fn media_display(media: &MediaVm, load: &MediaLoad) -> MediaDisplay {
    match &media.status {
        MediaStatus::Uploading(percent) => return MediaDisplay::Uploading(*percent),
        MediaStatus::UploadFailed(message) => return MediaDisplay::UploadFailed(message.clone()),
        MediaStatus::Available => {}
    }
    if media.kind != MediaKind::Image {
        return MediaDisplay::Card;
    }
    match load {
        MediaLoad::Loading => MediaDisplay::Loading,
        MediaLoad::Ready => MediaDisplay::Thumbnail,
        // Message volontairement fixe, sauf une limite de taille explicite : l'erreur du SDK n'atteint
        // jamais l'écran.
        MediaLoad::Failed(reason) if reason.starts_with(TOO_LARGE_PREFIX) => {
            MediaDisplay::Unavailable(reason.clone())
        }
        MediaLoad::Failed(_) => MediaDisplay::Unavailable(MEDIA_UNAVAILABLE.to_owned()),
    }
}

/// Préfixe des échecs « trop volumineux », seuls à garder leur texte.
pub const TOO_LARGE_PREFIX: &str = "image trop volumineuse";

/// Texte de l'échec d'une image dépassant [`MAX_INLINE_IMAGE_BYTES`].
pub fn too_large_message(size: u64) -> String {
    format!(
        "{TOO_LARGE_PREFIX} ({}, limite {})",
        format_size(size),
        format_size(MAX_INLINE_IMAGE_BYTES)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: Option<u32>, h: Option<u32>) -> MediaVm {
        MediaVm {
            key: "mxc://s/i".into(),
            kind: MediaKind::Image,
            filename: "photo.png".into(),
            size: Some(1_258_291),
            mime: Some("image/png".into()),
            width: w,
            height: h,
            encrypted: false,
            status: MediaStatus::Available,
        }
    }

    #[test]
    fn an_image_summary_has_name_size_dimensions_and_type() {
        assert_eq!(
            image(Some(800), Some(600)).summary(),
            "photo.png · 1,2 Mo · 800×600 · image/png"
        );
        let unknown = MediaVm { size: None, mime: None, ..image(None, None) };
        assert_eq!(unknown.summary(), "photo.png");
    }

    #[test]
    fn sizes_are_human_readable_with_a_french_decimal_comma() {
        assert_eq!(format_size(0), "0 o");
        assert_eq!(format_size(830), "830 o");
        assert_eq!(format_size(1024), "1,0 Ko");
        assert_eq!(format_size(1_536), "1,5 Ko");
        assert_eq!(format_size(2_516_582), "2,4 Mo");
        assert_eq!(format_size(1_181_116_006), "1,1 Go");
    }

    #[test]
    fn a_huge_image_never_exceeds_the_thumbnail_box() {
        let media = image(Some(4000), Some(3000));
        let (w, h) = media.thumbnail_size(THUMBNAIL_SIDE);
        assert!(w <= THUMBNAIL_SIDE && h <= THUMBNAIL_SIDE);
        assert_eq!((w, h), (44, 33), "ratio 4:3 conservé");
        let tall = image(Some(1000), Some(4000)).thumbnail_size(44);
        assert_eq!(tall, (11, 44));
        let tiny = image(Some(10), Some(5)).thumbnail_size(44);
        assert!(tiny.0 <= 44 && tiny.1 <= 44);
    }

    #[test]
    fn extreme_or_missing_dimensions_do_not_panic_or_overflow() {
        assert_eq!(image(None, None).thumbnail_size(44), (44, 44));
        assert_eq!(image(Some(0), Some(0)).thumbnail_size(44), (44, 44));
        let (w, h) = fit_within(u32::MAX, 1, 44, 44);
        assert!(w <= 44 && h >= 1);
        let (w, h) = fit_within(1, u32::MAX, 44, 44);
        assert!(h <= 44 && w >= 1);
    }

    #[test]
    fn images_are_recognised_by_their_bytes() {
        assert_eq!(sniff_image_format(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]), Some(ImageKind::Png));
        assert_eq!(sniff_image_format(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageKind::Jpeg));
        assert_eq!(sniff_image_format(b"GIF89a...."), Some(ImageKind::Gif));
        assert_eq!(sniff_image_format(b"RIFF\0\0\0\0WEBPVP8 "), Some(ImageKind::Webp));
        assert_eq!(sniff_image_format(b"BM\0\0\0\0\0\0\0\0\0\0\0\0\0"), Some(ImageKind::Bmp));
        assert_eq!(sniff_image_format(b"<svg xmlns=...>"), None, "SVG refusé");
        assert_eq!(sniff_image_format(b"MZ\x90\0"), None);
        assert_eq!(sniff_image_format(&[]), None);
    }

    #[test]
    fn an_available_image_shows_loading_then_a_thumbnail() {
        let media = image(Some(10), Some(10));
        assert_eq!(media_display(&media, &MediaLoad::Loading), MediaDisplay::Loading);
        assert_eq!(media_display(&media, &MediaLoad::Ready), MediaDisplay::Thumbnail);
    }

    #[test]
    fn an_undecryptable_encrypted_media_shows_a_readable_placeholder_without_panic() {
        let media = MediaVm { encrypted: true, ..image(Some(10), Some(10)) };
        let failed = MediaLoad::Failed("DecryptorError: invalid hash".to_owned());
        assert_eq!(
            media_display(&media, &failed),
            MediaDisplay::Unavailable(MEDIA_UNAVAILABLE.to_owned()),
            "l'erreur brute du SDK n'est jamais affichée"
        );
    }

    #[test]
    fn a_too_large_image_keeps_its_explicit_size_message() {
        let media = image(Some(10), Some(10));
        let message = too_large_message(MAX_INLINE_IMAGE_BYTES + 1);
        match media_display(&media, &MediaLoad::Failed(message.clone())) {
            MediaDisplay::Unavailable(text) => {
                assert!(text.starts_with(TOO_LARGE_PREFIX), "{text}");
                assert!(text.contains("limite 12,0 Mo"), "{text}");
            }
            other => panic!("attendu Unavailable, obtenu {other:?}"),
        }
    }

    #[test]
    fn files_audio_and_video_are_cards_and_uploads_show_their_progress() {
        for kind in [MediaKind::File, MediaKind::Audio, MediaKind::Video] {
            let media = MediaVm { kind, ..image(None, None) };
            assert_eq!(media_display(&media, &MediaLoad::Loading), MediaDisplay::Card);
        }
        let uploading = MediaVm { status: MediaStatus::Uploading(Some(40)), ..image(None, None) };
        assert_eq!(media_display(&uploading, &MediaLoad::Loading), MediaDisplay::Uploading(Some(40)));
        let failed = MediaVm { status: MediaStatus::UploadFailed("réseau".into()), ..image(None, None) };
        assert_eq!(
            media_display(&failed, &MediaLoad::Ready),
            MediaDisplay::UploadFailed("réseau".into())
        );
    }

    #[test]
    fn payload_debug_never_prints_the_bytes() {
        let payload = MediaPayload::Ready(Arc::new(vec![1, 2, 3]));
        assert_eq!(format!("{payload:?}"), "Ready(3 octets)");
    }
}
