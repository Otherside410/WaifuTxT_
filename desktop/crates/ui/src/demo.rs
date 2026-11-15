//! Données factices du mode `--demo-ui` : aucune connexion, mêmes types que le flux réel.

use domain::{
    EventId, EventState, EventVm, MediaKind, MediaPayload, MediaStatus, MediaVm, RoomId, RoomKind,
    RoomVm, UNDECRYPTABLE_PLACEHOLDER,
};

/// Taille d'une page de la timeline de démonstration.
pub const DEMO_PAGE: usize = 50;
/// Nombre de messages du salon « général » de démonstration.
pub const DEMO_MESSAGES: usize = 200;
/// Rang (0 = plus ancien) du message indéchiffrable de démonstration.
pub const DEMO_UNDECRYPTABLE_AT: usize = DEMO_MESSAGES - 3;

pub const SPACE_ID: &str = "!demo-space:demo";
pub const ROOM_ID: &str = "!demo-room:demo";
pub const DM_ID: &str = "!demo-dm:demo";

/// Salons factices : un espace, un salon, un DM.
pub fn demo_rooms() -> Vec<RoomVm> {
    let room =
        |id: &str, name: &str, kind, unread| RoomVm::new(RoomId::from(id), name, kind, unread);
    vec![
        room(SPACE_ID, "Démo Serveur", RoomKind::Space, 0),
        room(ROOM_ID, "général", RoomKind::Room, 3),
        room(DM_ID, "Alice Demo", RoomKind::Dm, 1),
    ]
}

fn demo_event(rank: usize) -> EventVm {
    // Un message sur quatre est de moi : ceux-là peuvent être modifiés ou supprimés.
    let own = rank % 4 == 3;
    let (name, initials) = if own {
        ("Moi (démo)", "MD")
    } else if rank.is_multiple_of(2) {
        ("Alice Demo", "AD")
    } else {
        ("Bob Demo", "BD")
    };
    let minutes = rank % (24 * 60);
    let undecryptable = rank == DEMO_UNDECRYPTABLE_AT;
    EventVm {
        id: EventId::from(format!("$demo-{rank:04}").as_str()),
        sender_name: name.to_owned(),
        sender_initials: initials.to_owned(),
        timestamp_ms: 1_700_000_000_000 + rank as u64 * 60_000,
        time_label: format!("{:02}:{:02}", minutes / 60, minutes % 60),
        body: if undecryptable {
            UNDECRYPTABLE_PLACEHOLDER.to_owned()
        } else {
            format!("Message de démonstration n°{rank}")
        },
        state: if undecryptable { EventState::Indechiffrable } else { EventState::Normal },
        event_id: Some(EventId::from(format!("$demo-ev-{rank:04}").as_str())),
        is_own: own,
        edited: false,
        // Le dernier message a été lu par deux autres membres.
        read_by: if rank + 1 == DEMO_MESSAGES {
            vec!["alice".to_owned(), "bob".to_owned()]
        } else {
            Vec::new()
        },
        media: None,
    }
}

/// Image BMP 24 bits générée à la volée (dégradé) : aucun fichier externe, aucun réseau.
pub fn gradient_bmp(width: u32, height: u32) -> Vec<u8> {
    let row = (width * 3).div_ceil(4) * 4;
    let image_size = row * height;
    let mut out = Vec::with_capacity(54 + image_size as usize);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(54 + image_size).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&image_size.to_le_bytes());
    out.extend_from_slice(&2835u32.to_le_bytes());
    out.extend_from_slice(&2835u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    // Lignes de bas en haut, pixels en BGR.
    for y in (0..height).rev() {
        for x in 0..width {
            let red = (x * 255 / width.max(1)) as u8;
            let green = (y * 255 / height.max(1)) as u8;
            out.extend_from_slice(&[128, green, red]);
        }
        out.extend(std::iter::repeat_n(0u8, (row - width * 3) as usize));
    }
    out
}

fn media_event(
    n: usize,
    sender: &str,
    initials: &str,
    own: bool,
    state: EventState,
    media: MediaVm,
) -> EventVm {
    let ts = 1_700_000_000_000 + (DEMO_MESSAGES + n) as u64 * 60_000;
    let minutes = (DEMO_MESSAGES + n) % (24 * 60);
    EventVm {
        id: EventId::from(format!("$demo-media-{n}").as_str()),
        sender_name: sender.to_owned(),
        sender_initials: initials.to_owned(),
        timestamp_ms: ts,
        time_label: format!("{:02}:{:02}", minutes / 60, minutes % 60),
        body: media.filename.clone(),
        state,
        event_id: (state == EventState::Normal)
            .then(|| EventId::from(format!("$demo-media-ev-{n}").as_str())),
        is_own: own,
        edited: false,
        read_by: Vec::new(),
        media: Some(media),
    }
}

fn media_vm(key: &str, kind: MediaKind, name: &str, size: u64, mime: &str) -> MediaVm {
    MediaVm {
        key: key.to_owned(),
        kind,
        filename: name.to_owned(),
        size: Some(size),
        mime: Some(mime.to_owned()),
        width: None,
        height: None,
        encrypted: false,
        status: MediaStatus::Available,
    }
}

/// Messages à médias du mode `--demo-media` et octets des images (générés, sans réseau) : deux images
/// (dont une annoncée en 4000×3000), un fichier, une image chiffrée non déchiffrable, un envoi en cours
/// et une pièce jointe en échec.
pub fn media_events() -> (Vec<EventVm>, Vec<(String, MediaPayload)>) {
    let landscape = gradient_bmp(96, 64);
    let huge = gradient_bmp(64, 48);
    let mut payloads = Vec::new();

    let mut first = media_vm("mxc://demo/paysage", MediaKind::Image, "paysage.bmp", landscape.len() as u64, "image/bmp");
    first.width = Some(96);
    first.height = Some(64);
    payloads.push((first.key.clone(), MediaPayload::Ready(std::sync::Arc::new(landscape))));

    let mut second = media_vm("mxc://demo/enorme", MediaKind::Image, "photo-4000x3000.bmp", 9_437_184, "image/bmp");
    second.width = Some(4000);
    second.height = Some(3000);
    payloads.push((second.key.clone(), MediaPayload::Ready(std::sync::Arc::new(huge))));

    let pdf = media_vm("mxc://demo/rapport", MediaKind::File, "rapport-trimestriel.pdf", 2_516_582, "application/pdf");

    let mut sealed = media_vm("mxc://demo/chiffree", MediaKind::Image, "chiffree.jpg", 340_000, "image/jpeg");
    sealed.width = Some(800);
    sealed.height = Some(600);
    sealed.encrypted = true;
    payloads.push((
        sealed.key.clone(),
        MediaPayload::Failed("DecryptorError: hash mismatch".to_owned()),
    ));

    let mut sending = media_vm("local://demo/video", MediaKind::Video, "video-longue.mp4", 31_457_280, "video/mp4");
    sending.status = MediaStatus::Uploading(Some(60));

    let mut lost = media_vm("local://demo/perdue", MediaKind::Image, "photo-perdue.png", 1_048_576, "image/png");
    lost.status = MediaStatus::UploadFailed("envoi échoué".to_owned());

    let events = vec![
        media_event(0, "Alice Demo", "AD", false, EventState::Normal, first),
        media_event(1, "Bob Demo", "BD", false, EventState::Normal, second),
        media_event(2, "Alice Demo", "AD", false, EventState::Normal, pdf),
        media_event(3, "Bob Demo", "BD", false, EventState::Normal, sealed),
        media_event(4, "Moi (démo)", "MD", true, EventState::Local, sending),
        media_event(5, "Moi (démo)", "MD", true, EventState::EchecEnvoi, lost),
    ];
    (events, payloads)
}

/// Historique complet d'un salon de démonstration (le DM et l'espace sont vides).
fn history(room: &RoomId) -> Vec<EventVm> {
    if room.as_str() == ROOM_ID {
        (0..DEMO_MESSAGES).map(demo_event).collect()
    } else {
        Vec::new()
    }
}

/// Dernière page du salon : `(événements, début atteint)`.
pub fn initial_page(room: &RoomId) -> (Vec<EventVm>, bool) {
    let all = history(room);
    let start = all.len().saturating_sub(DEMO_PAGE);
    (all[start..].to_vec(), start == 0)
}

/// Page précédant l'événement `oldest` (le plus ancien déjà chargé) : `(événements, début atteint)`.
pub fn older_page(room: &RoomId, oldest: &EventId) -> (Vec<EventVm>, bool) {
    let all = history(room);
    let end = all.iter().position(|e| &e.id == oldest).unwrap_or(0);
    let start = end.saturating_sub(DEMO_PAGE);
    (all[start..end].to_vec(), start == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_history_pages_cover_everything_without_overlap() {
        let room = RoomId::from(ROOM_ID);
        let (mut loaded, mut at_start) = initial_page(&room);
        assert_eq!(loaded.len(), DEMO_PAGE);
        while !at_start {
            let (page, start) = older_page(&room, &loaded[0].id);
            let mut merged = page;
            merged.extend(loaded);
            loaded = merged;
            at_start = start;
        }
        assert_eq!(loaded.len(), DEMO_MESSAGES);
        let mut ids: Vec<_> = loaded.iter().map(|e| e.id.as_str()).collect();
        ids.dedup();
        assert_eq!(ids.len(), DEMO_MESSAGES);
    }

    #[test]
    fn dm_and_space_are_empty() {
        for id in [DM_ID, SPACE_ID] {
            assert_eq!(initial_page(&RoomId::from(id)), (Vec::new(), true));
        }
    }
}
