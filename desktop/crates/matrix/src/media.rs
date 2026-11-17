//! Médias : téléchargement, déchiffrement (par le SDK) et cache.
//!
//! Aucun chiffrement écrit à la main : `Media::get_media_content` déchiffre quand la source est
//! `MediaSource::Encrypted`. Un média chiffré n'est **jamais** demandé par une voie en clair (pas de
//! miniature serveur, pas d'URL HTTP) : voir [`plan_download`].
//!
//! Le cache vit ici (pas dans l'UI) : clé = identifiant du média + variante demandée ; deux demandes
//! identiques, même simultanées, ne téléchargent qu'une fois.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};

use domain::{format_size, too_large_message, MAX_INLINE_IMAGE_BYTES, MAX_UPLOAD_BYTES};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::UInt;
use matrix_sdk::Client;
use tokio::sync::OnceCell;

/// Plafond mémoire du cache ; au-delà, les entrées les plus anciennes sont évincées.
pub const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
/// Côté de la miniature demandée au serveur pour un média non chiffré (pixels).
const SERVER_THUMBNAIL_SIDE: u32 = 128;

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    /// Dépasse la limite d'affichage en ligne : le texte est explicite, la taille y figure.
    #[error("{}", too_large_message(*.0))]
    TooLarge(u64),
    /// Téléchargement ou déchiffrement impossible. Le détail (jamais affiché) sert au débogage.
    #[error("média indisponible")]
    Unavailable(String),
}

/// Variante d'un média dans le cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Variant {
    Thumbnail,
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MediaKey {
    pub id: String,
    pub variant: Variant,
}

#[derive(Default)]
struct CacheState {
    cells: HashMap<MediaKey, Arc<OnceCell<Arc<Vec<u8>>>>>,
    sizes: HashMap<MediaKey, usize>,
    order: VecDeque<MediaKey>,
    bytes: usize,
}

/// Cache mémoire des médias téléchargés (octets déjà déchiffrés).
#[derive(Default)]
pub struct MediaCache {
    state: Mutex<CacheState>,
}

impl MediaCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheState> {
        // Un panic ailleurs ne doit pas rendre le cache inutilisable.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Octets du média `key` ; `fetch` n'est appelé que si l'entrée est absente (et une seule fois, même
    /// pour des appels simultanés). Un échec n'est pas mémorisé : la demande suivante réessaie.
    pub async fn get_or_fetch<F, Fut>(&self, key: MediaKey, fetch: F) -> Result<Arc<Vec<u8>>, MediaError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, MediaError>>,
    {
        let cell = {
            let mut state = self.lock();
            Arc::clone(state.cells.entry(key.clone()).or_default())
        };
        let bytes = cell
            .get_or_try_init(|| async move { fetch().await.map(Arc::new) })
            .await?
            .clone();
        self.account(key, bytes.len());
        Ok(bytes)
    }

    /// Comptabilise une entrée (une fois) et évince les plus anciennes au-delà du plafond.
    fn account(&self, key: MediaKey, len: usize) {
        let mut state = self.lock();
        if state.sizes.contains_key(&key) {
            return;
        }
        state.sizes.insert(key.clone(), len);
        state.order.push_back(key);
        state.bytes += len;
        while state.bytes > MAX_CACHE_BYTES && state.order.len() > 1 {
            let Some(oldest) = state.order.pop_front() else {
                break;
            };
            if let Some(size) = state.sizes.remove(&oldest) {
                state.bytes = state.bytes.saturating_sub(size);
            }
            state.cells.remove(&oldest);
        }
    }

    /// Nombre d'entrées en cache (tests, diagnostic).
    pub fn len(&self) -> usize {
        self.lock().sizes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Comment récupérer une image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadPlan {
    /// Vignette portée par l'événement (chiffrée si l'événement l'est) : voie la plus légère et sûre.
    ProvidedThumbnail,
    /// Miniature calculée par le serveur : **uniquement pour un média non chiffré** (le serveur ne voit
    /// que du chiffré et ne peut pas la produire).
    ServerThumbnail,
    /// Fichier complet (déchiffré localement si besoin).
    Full,
}

/// Choisit la voie de téléchargement. Pure et testable.
///
/// Garanties : jamais de miniature serveur pour un média chiffré ; une image déclarée plus grande que
/// [`MAX_INLINE_IMAGE_BYTES`] sans vignette n'est pas téléchargée.
pub fn plan_download(
    encrypted: bool,
    has_provided_thumbnail: bool,
    declared_size: Option<u64>,
) -> Result<DownloadPlan, MediaError> {
    if has_provided_thumbnail {
        return Ok(DownloadPlan::ProvidedThumbnail);
    }
    if let Some(size) = declared_size.filter(|size| *size > MAX_INLINE_IMAGE_BYTES) {
        return Err(MediaError::TooLarge(size));
    }
    Ok(if encrypted { DownloadPlan::Full } else { DownloadPlan::ServerThumbnail })
}

/// Une image à récupérer, extraite d'un événement par la couche timeline.
#[derive(Debug, Clone)]
pub struct ImageRequest {
    pub key: String,
    pub source: MediaSource,
    pub thumbnail: Option<MediaSource>,
    pub declared_size: Option<u64>,
}

/// Refuse un envoi plus gros que [`MAX_UPLOAD_BYTES`], avec un message lisible.
pub fn check_upload(size: u64) -> Result<(), String> {
    if size > MAX_UPLOAD_BYTES {
        Err(format!(
            "Fichier trop volumineux ({}, limite {}).",
            format_size(size),
            format_size(MAX_UPLOAD_BYTES)
        ))
    } else {
        Ok(())
    }
}

/// Type MIME deviné d'après l'extension du fichier (`application/octet-stream` à défaut).
pub fn mime_for(path: &std::path::Path) -> mime::Mime {
    mime_guess::from_path(path).first_or_octet_stream()
}

fn unavailable(err: impl std::fmt::Display) -> MediaError {
    MediaError::Unavailable(err.to_string())
}

fn check_size(bytes: Vec<u8>) -> Result<Vec<u8>, MediaError> {
    match u64::try_from(bytes.len()) {
        Ok(len) if len <= MAX_INLINE_IMAGE_BYTES => Ok(bytes),
        Ok(len) => Err(MediaError::TooLarge(len)),
        Err(_) => Err(MediaError::Unavailable("taille illisible".to_owned())),
    }
}

async fn download(
    client: &Client,
    cache: &MediaCache,
    id: &str,
    variant: Variant,
    source: MediaSource,
    format: MediaFormat,
) -> Result<Arc<Vec<u8>>, MediaError> {
    let key = MediaKey { id: id.to_owned(), variant };
    cache
        .get_or_fetch(key, || async move {
            let params = MediaRequestParameters { source, format };
            // Le SDK déchiffre lui-même si `source` est chiffrée ; `true` : cache du SDK aussi.
            let bytes = client.media().get_media_content(&params, true).await.map_err(unavailable)?;
            check_size(bytes)
        })
        .await
}

/// Télécharge (et déchiffre) une image selon [`plan_download`], via le cache.
pub async fn fetch_image(
    client: &Client,
    cache: &MediaCache,
    request: &ImageRequest,
) -> Result<Arc<Vec<u8>>, MediaError> {
    let encrypted = matches!(request.source, MediaSource::Encrypted(_));
    match plan_download(encrypted, request.thumbnail.is_some(), request.declared_size)? {
        DownloadPlan::ProvidedThumbnail => match request.thumbnail.clone() {
            Some(thumbnail) => {
                download(client, cache, &request.key, Variant::Thumbnail, thumbnail, MediaFormat::File)
                    .await
            }
            None => Err(MediaError::Unavailable("vignette absente".to_owned())),
        },
        DownloadPlan::ServerThumbnail => {
            let side = UInt::from(SERVER_THUMBNAIL_SIDE);
            let format = MediaFormat::Thumbnail(MediaThumbnailSettings::new(side, side));
            let thumb = download(
                client,
                cache,
                &request.key,
                Variant::Thumbnail,
                request.source.clone(),
                format,
            )
            .await;
            match thumb {
                Ok(bytes) => Ok(bytes),
                // Média NON chiffré seulement : si le serveur ne sait pas redimensionner, on prend le
                // fichier (la taille est de toute façon bornée par `check_size`).
                Err(MediaError::Unavailable(_)) => {
                    download(client, cache, &request.key, Variant::Full, request.source.clone(), MediaFormat::File)
                        .await
                }
                Err(other) => Err(other),
            }
        }
        DownloadPlan::Full => {
            download(client, cache, &request.key, Variant::Full, request.source.clone(), MediaFormat::File)
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn key(id: &str, variant: Variant) -> MediaKey {
        MediaKey { id: id.to_owned(), variant }
    }

    /// Double de test : compte les « téléchargements » réels.
    async fn counted(
        cache: &MediaCache,
        counter: &AtomicUsize,
        id: &str,
        variant: Variant,
    ) -> Result<Arc<Vec<u8>>, MediaError> {
        cache
            .get_or_fetch(key(id, variant), || async {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(vec![1, 2, 3])
            })
            .await
    }

    #[tokio::test]
    async fn two_identical_requests_download_once() {
        let cache = MediaCache::new();
        let counter = AtomicUsize::new(0);
        let a = counted(&cache, &counter, "mxc://s/a", Variant::Thumbnail).await.expect("première");
        let b = counted(&cache, &counter, "mxc://s/a", Variant::Thumbnail).await.expect("seconde");
        assert_eq!(counter.load(Ordering::SeqCst), 1, "un seul téléchargement");
        assert!(Arc::ptr_eq(&a, &b), "mêmes octets partagés");
        assert_eq!(cache.len(), 1);
    }

    #[tokio::test]
    async fn simultaneous_identical_requests_download_once() {
        let cache = MediaCache::new();
        let counter = AtomicUsize::new(0);
        let (a, b, c) = tokio::join!(
            counted(&cache, &counter, "mxc://s/a", Variant::Full),
            counted(&cache, &counter, "mxc://s/a", Variant::Full),
            counted(&cache, &counter, "mxc://s/a", Variant::Full),
        );
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn another_variant_or_another_media_is_a_different_entry() {
        let cache = MediaCache::new();
        let counter = AtomicUsize::new(0);
        counted(&cache, &counter, "mxc://s/a", Variant::Thumbnail).await.expect("ok");
        counted(&cache, &counter, "mxc://s/a", Variant::Full).await.expect("ok");
        counted(&cache, &counter, "mxc://s/b", Variant::Thumbnail).await.expect("ok");
        assert_eq!(counter.load(Ordering::SeqCst), 3);
        assert_eq!(cache.len(), 3);
    }

    #[tokio::test]
    async fn a_failure_is_not_cached_so_the_next_request_retries() {
        let cache = MediaCache::new();
        let counter = AtomicUsize::new(0);
        let failed = cache
            .get_or_fetch(key("mxc://s/x", Variant::Full), || async {
                counter.fetch_add(1, Ordering::SeqCst);
                Err(MediaError::Unavailable("réseau".to_owned()))
            })
            .await;
        assert!(matches!(failed, Err(MediaError::Unavailable(_))));
        assert_eq!(failed.map(|_| ()).unwrap_err().to_string(), "média indisponible");
        assert!(cache.is_empty());
        let ok = counted(&cache, &counter, "mxc://s/x", Variant::Full).await;
        assert!(ok.is_ok());
        assert_eq!(counter.load(Ordering::SeqCst), 2, "échec puis réessai réussi");
    }

    #[test]
    fn an_encrypted_media_is_never_requested_through_the_server_thumbnail() {
        // Chiffré, sans vignette portée : fichier complet déchiffré localement, jamais de miniature serveur.
        assert_eq!(plan_download(true, false, Some(1024)).expect("plan"), DownloadPlan::Full);
        assert_eq!(plan_download(true, false, None).expect("plan"), DownloadPlan::Full);
        // Avec vignette portée par l'événement : on l'utilise.
        assert_eq!(plan_download(true, true, None).expect("plan"), DownloadPlan::ProvidedThumbnail);
        // Non chiffré : la miniature serveur est permise.
        assert_eq!(plan_download(false, false, Some(1024)).expect("plan"), DownloadPlan::ServerThumbnail);
    }

    #[test]
    fn an_oversized_image_without_thumbnail_is_refused_with_its_size() {
        for encrypted in [true, false] {
            let err = plan_download(encrypted, false, Some(MAX_INLINE_IMAGE_BYTES + 1)).expect_err("trop gros");
            assert!(matches!(err, MediaError::TooLarge(_)));
            assert!(err.to_string().starts_with("image trop volumineuse"), "{err}");
        }
        // Une vignette portée par l'événement évite le téléchargement du gros fichier.
        assert!(plan_download(true, true, Some(MAX_INLINE_IMAGE_BYTES * 10)).is_ok());
    }

    #[test]
    fn an_upload_over_the_limit_is_refused_with_a_readable_message() {
        assert!(check_upload(0).is_ok());
        assert!(check_upload(MAX_UPLOAD_BYTES).is_ok());
        let message = check_upload(MAX_UPLOAD_BYTES + 1).expect_err("trop gros");
        assert!(message.contains("trop volumineux") && message.contains("limite 50,0 Mo"), "{message}");
    }

    #[test]
    fn the_mime_type_follows_the_extension_with_a_safe_default() {
        use std::path::Path;
        assert_eq!(mime_for(Path::new("a/photo.PNG")), mime::IMAGE_PNG);
        assert_eq!(mime_for(Path::new("rapport.pdf")), mime::APPLICATION_PDF);
        assert_eq!(mime_for(Path::new("sans-extension")), mime::APPLICATION_OCTET_STREAM);
    }

    #[test]
    fn downloaded_bytes_over_the_limit_are_refused() {
        let big = vec![0u8; usize::try_from(MAX_INLINE_IMAGE_BYTES).unwrap_or(usize::MAX) + 1];
        assert!(matches!(check_size(big), Err(MediaError::TooLarge(_))));
        assert!(check_size(vec![0; 10]).is_ok());
    }
}
