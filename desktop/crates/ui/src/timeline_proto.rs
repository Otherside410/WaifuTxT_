//! Prototype W06 : timeline **virtualisée à hauteurs variables** de 5 000 messages, bâtie sur les composants retenus de
//! `gpui-kit` (`MessageScroller`, `Message`, `Bubble`, `Avatar`), voir `.design/gpui/UI-MAPPING.md` §1.2 et §5.
//!
//! Rendu incrémental : `MessageScroller` ne demande une ligne au rendu que si elle est visible (ou dans la marge de
//! 400 px), donc le coût d'une frame ne dépend pas du nombre de messages. Chaque construction de ligne est comptée
//! ([`TimelineProto::take_built_rows`]) : c'est la preuve mesurable de la virtualisation, sans dépendre d'un GPU.
//!
//! Les données sont générées de façon déterministe ([`generate_messages`]) : mêmes graines, mêmes messages, donc mêmes
//! hauteurs d'une exécution à l'autre. Les lignes de texte sont des enfants explicites (une ligne = un enfant), pas du
//! texte à renvoi automatique : la plateforme de test de GPUI n'a pas de moteur de texte (`NoopTextSystem`), le renvoi à
//! la ligne n'y est pas mesurable ; les hauteurs variables viennent donc du nombre de lignes, des images et des fichiers.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::avatar::Avatar;
use gpui_kit::component::bubble::{Bubble, BubbleVariant};
use gpui_kit::component::message::{Message, MessageAlignment, MessageContent, MessageHeader};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::{v_flex, ActiveTheme as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

/// Nombre de messages du prototype (cible de l'étape 5 de `ARCHITECTURE.md` §4).
pub const PROTO_MESSAGES: usize = 5_000;

const SENDERS: [&str; 6] = ["Alice Demo", "Bob Demo", "Moi (démo)", "Chloé", "Dmitri", "Emi"];

/// Contenu d'un message du prototype.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtoBody {
    /// Texte : une entrée par ligne (1 à 8).
    Text(Vec<String>),
    /// Image (boîte réservée) : hauteur en pixels.
    Image { height: u32 },
    /// Fichier joint : nom.
    File { name: String },
}

/// Un message du prototype : de quoi dessiner une ligne, rien de plus (pas d'identifiant Matrix).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtoMessage {
    /// Numéro d'ordre (0 = plus ancien) à la génération ; sert d'identifiant stable d'affichage.
    pub number: usize,
    pub sender: String,
    pub time_label: String,
    pub body: ProtoBody,
    /// En-tête (avatar + nom + heure) affiché : l'expéditeur change, ou toutes les 9 lignes (le web regroupe sous 5 min,
    /// `MessageList.tsx:75-80`).
    pub show_header: bool,
    pub own: bool,
}

/// Générateur xorshift64* : déterministe, sans dépendance.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

/// `count` messages numérotés `first_number..first_number + count`, déterministes pour une graine donnée.
///
/// Répartition : 88 % de texte (1 à 8 lignes), 8 % d'images (120 à 320 px), 4 % de fichiers.
pub fn generate_messages(first_number: usize, count: usize, seed: u64) -> Vec<ProtoMessage> {
    let mut rng = Rng(seed ^ 0x9E37_79B9_7F4A_7C15);
    let mut previous_sender: Option<usize> = None;
    (first_number..first_number + count)
        .map(|number| {
            // Le premier message d'une page n'a pas de précédent connu : il porte toujours son en-tête.
            let sender = rng.below(SENDERS.len() as u64) as usize;
            let kind = rng.below(100);
            let body = if kind < 88 {
                let lines = 1 + rng.below(8) as usize;
                ProtoBody::Text((0..lines).map(|line| format!("Message n°{number}, ligne {}/{lines}", line + 1)).collect())
            } else if kind < 96 {
                ProtoBody::Image { height: 120 + rng.below(201) as u32 }
            } else {
                ProtoBody::File { name: format!("fichier-{number}.pdf") }
            };
            let show_header = previous_sender != Some(sender) || number % 9 == 0;
            previous_sender = Some(sender);
            ProtoMessage {
                number,
                sender: SENDERS[sender].to_owned(),
                time_label: format!("{:02}:{:02}", (number / 60) % 24, number % 60),
                body,
                show_header,
                own: sender == 2,
            }
        })
        .collect()
}

impl ProtoMessage {
    /// Mémoire approximative d'un message : la structure plus les octets alloués de ses chaînes (capacités).
    pub fn approx_bytes(&self) -> usize {
        let body = match &self.body {
            ProtoBody::Text(lines) => lines.capacity() * std::mem::size_of::<String>() + lines.iter().map(String::capacity).sum::<usize>(),
            ProtoBody::Image { .. } => 0,
            ProtoBody::File { name } => name.capacity(),
        };
        std::mem::size_of::<Self>() + self.sender.capacity() + self.time_label.capacity() + body
    }
}

/// Relevé des lignes construites depuis la dernière lecture (partagé avec la fermeture de rendu).
#[derive(Default)]
struct BuildLog {
    built: Vec<usize>,
}

/// Vue de la timeline de démonstration.
pub struct TimelineProto {
    messages: Rc<RefCell<Vec<ProtoMessage>>>,
    state: Entity<MessageScrollerState>,
    log: Rc<RefCell<BuildLog>>,
    /// Prochain numéro de message à ajouter en fin de liste.
    next_number: usize,
    /// Plus petit numéro chargé (pour la pagination vers le haut).
    first_number: usize,
}

impl TimelineProto {
    /// `count` messages, liste calée en bas (suivi de la fin activé par `MessageScrollerState`).
    pub fn new(count: usize, cx: &mut Context<Self>) -> Self {
        let messages = Rc::new(RefCell::new(generate_messages(0, count, 42)));
        let state = cx.new(|cx| MessageScrollerState::new(count, cx));
        Self { messages, state, log: Rc::new(RefCell::new(BuildLog::default())), next_number: count, first_number: 0 }
    }

    /// Décale la numérotation des messages chargés (le plus ancien devient `first`) : simule une fenêtre de pagination
    /// qui ne couvre pas le début du salon. N'affecte que l'affichage ; à appeler avant le premier rendu.
    pub fn rebase_numbers(&mut self, first: usize) {
        let count = self.len();
        *self.messages.borrow_mut() = generate_messages(first, count, 42);
        self.first_number = first;
        self.next_number = first + count;
    }

    /// Numéro (`ProtoMessage::number`) du message à l'index `index`.
    pub fn message_number(&self, index: usize) -> Option<usize> {
        self.messages.borrow().get(index).map(|m| m.number)
    }

    /// Nombre de messages chargés.
    pub fn len(&self) -> usize {
        self.messages.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.messages.borrow().is_empty()
    }

    /// Indices des lignes construites depuis le dernier appel (la liste est vidée).
    pub fn take_built_rows(&self) -> Vec<usize> {
        std::mem::take(&mut self.log.borrow_mut().built)
    }

    /// État de défilement (lecture : élément du haut, suivi de la fin…).
    pub fn scroller(&self) -> &Entity<MessageScrollerState> {
        &self.state
    }

    pub fn scroll_to_item(&self, index: usize, cx: &mut Context<Self>) -> bool {
        self.state.update(cx, |state, cx| state.scroll_to_item(index, cx))
    }

    pub fn scroll_to_end(&self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.scroll_to_end(cx));
    }

    /// Ajoute `count` messages récents en fin de liste.
    pub fn append_newer(&mut self, count: usize, cx: &mut Context<Self>) {
        let newer = generate_messages(self.next_number, count, 7 + self.next_number as u64);
        self.next_number += count;
        self.messages.borrow_mut().extend(newer);
        self.state.update(cx, |state, cx| {
            state.append(count, cx);
        });
        cx.notify();
    }

    /// Charge `count` messages plus anciens en tête de liste (pagination vers le haut) ; l'ancre de lecture est conservée
    /// par `MessageScrollerState::prepend`. Les numéros décroissent : `first_number` recule de `count` (jamais sous 0 :
    /// au besoin la page est plus courte).
    pub fn prepend_older(&mut self, count: usize, cx: &mut Context<Self>) -> usize {
        let count = count.min(self.first_number);
        if count == 0 {
            return 0;
        }
        let older = generate_messages(self.first_number - count, count, 99 + self.first_number as u64);
        self.first_number -= count;
        self.messages.borrow_mut().splice(0..0, older);
        self.state.update(cx, |state, cx| {
            state.prepend(count, cx);
        });
        cx.notify();
        count
    }
}

fn avatar_for(sender: &str) -> impl IntoElement {
    Avatar::new().name(sender.to_owned())
}

/// Corps d'une ligne : texte (une entrée par ligne), image (boîte réservée), fichier.
fn body_of(message: &ProtoMessage, cx: &App) -> AnyElement {
    let colors = cx.theme().colors;
    match &message.body {
        ProtoBody::Text(lines) => v_flex().children(lines.iter().map(|line| div().child(line.clone()))).into_any_element(),
        ProtoBody::Image { height } => div()
            .w(px(260.0))
            .h(px(*height as f32))
            .rounded_md()
            .bg(colors.muted)
            .child(format!("image {}×{height}", 260))
            .into_any_element(),
        ProtoBody::File { name } => div().child(format!("📎 {name}")).into_any_element(),
    }
}

/// Une ligne : en-tête (si `show_header`), puis une bulle. L'avatar n'est posé que sur les lignes avec en-tête.
fn render_row(message: &ProtoMessage, cx: &App) -> impl IntoElement {
    let alignment = if message.own { MessageAlignment::End } else { MessageAlignment::Start };
    let variant = if message.own { BubbleVariant::Filled } else { BubbleVariant::Secondary };
    let body = body_of(message, cx);
    Message::new()
        .id(SharedString::from(format!("proto-msg-{}", message.number)))
        .alignment(alignment)
        .when(message.show_header, |row| {
            row.avatar(avatar_for(&message.sender)).header(
                MessageHeader::new().child(message.sender.clone()).child(div().child(message.time_label.clone())),
            )
        })
        .content(MessageContent::new().bubble(Bubble::new().with_variant(variant).child(body)))
}

impl Render for TimelineProto {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let messages = self.messages.clone();
        let log = self.log.clone();
        let scroller = MessageScroller::new("proto-timeline", self.state.clone(), move |index, _window, cx| {
            log.borrow_mut().built.push(index);
            let messages = messages.borrow();
            match messages.get(index) {
                // Identifiant d'accessibilité de la ligne : permet aux tests de retrouver sa boîte et de mesurer sa hauteur.
                Some(message) => div()
                    .id(SharedString::from(format!("proto-row-{}", message.number)))
                    .child(render_row(message, cx))
                    .test_support()
                    .aria_label(SharedString::from(format!("{} : message {}", message.sender, message.number)))
                    .into_any_element(),
                // La liste ne demande jamais un index hors bornes tant que `state` et `messages` sont tenus ensemble.
                None => div().into_any_element(),
            }
        });
        div().size_full().child(scroller.size_full())
    }
}

// ───────────────────────────── banc en fenêtre réelle ─────────────────────────────

/// Résultat d'un banc de défilement : intervalles entre deux rendus successifs et lignes construites par rendu.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BenchReport {
    pub frames: usize,
    /// Intervalle entre deux rendus successifs : borné par la cadence de la plateforme (voir `RAPPORT-W06.md`), donc
    /// ce n'est pas le coût d'une frame.
    pub intervals: Vec<Duration>,
    /// De l'entrée dans `render` à la fin de la peinture du dernier élément de l'arbre : construction des lignes,
    /// mise en page, préparation et peinture côté CPU ; n'inclut ni la rastérisation ni la présentation.
    pub frame_costs: Vec<Duration>,
    pub rows_per_frame: Vec<usize>,
}

/// Médiane, 95ᵉ centile et maximum d'une série de durées (millisecondes). Série vide : zéros.
pub fn summarize(durations: &[Duration]) -> (f64, f64, f64) {
    if durations.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut ms: Vec<f64> = durations.iter().map(|d| d.as_secs_f64() * 1000.0).collect();
    ms.sort_by(f64::total_cmp);
    let at = |p: f64| ms[(((ms.len() - 1) as f64) * p).round() as usize];
    (at(0.5), at(0.95), *ms.last().expect("série non vide"))
}

impl BenchReport {
    /// Texte de synthèse (une ligne) : jamais de chiffre de frame inventé, uniquement ce qui a été relevé.
    pub fn line(&self) -> String {
        let (median, p95, max) = summarize(&self.intervals);
        let mut rows = self.rows_per_frame.clone();
        rows.sort_unstable();
        let rows_max = rows.last().copied().unwrap_or(0);
        let rows_median = rows.get(rows.len() / 2).copied().unwrap_or(0);
        let (cost_median, cost_p95, cost_max) = summarize(&self.frame_costs);
        format!(
            "frames={} intervalle_ms médiane={median:.2} p95={p95:.2} max={max:.2} | coût_cpu_frame_ms (render→fin de peinture) médiane={cost_median:.3} p95={cost_p95:.3} max={cost_max:.3} | lignes_construites_par_frame médiane={rows_median} max={rows_max}",
            self.frames
        )
    }
}

/// Banc : fait défiler les 5 000 messages de la tête à la fin, `STEP` messages par rendu, en notant l'intervalle entre
/// deux rendus successifs. Lancé par `waifu-desktop --bench-timeline` (voir `RAPPORT-W06.md` pour la commande).
pub struct TimelineBench {
    proto: Entity<TimelineProto>,
    frame: usize,
    last: Option<Instant>,
    report: BenchReport,
    /// Coûts relevés par l'élément de fin d'arbre (peint après la liste) ; copiés dans le rapport à la fin.
    costs: Rc<RefCell<Vec<Duration>>>,
    done: bool,
}

/// Messages franchis à chaque rendu.
const BENCH_STEP: usize = 25;

impl TimelineBench {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let proto = cx.new(|cx| TimelineProto::new(PROTO_MESSAGES, cx));
        Self { proto, frame: 0, last: None, report: BenchReport::default(), costs: Rc::new(RefCell::new(Vec::new())), done: false }
    }

    fn total_frames() -> usize {
        PROTO_MESSAGES / BENCH_STEP
    }

    /// Consomme le rapport (appelé une fois, à la fin).
    fn finish(&mut self, cx: &mut Context<Self>) {
        self.done = true;
        self.report.frame_costs = std::mem::take(&mut *self.costs.borrow_mut());
        println!("[bench] {}", self.report.line());
        println!("[bench] rss_ko={}", resident_kib().map_or_else(|| "inconnu".to_owned(), |kib| kib.to_string()));
        cx.quit();
    }
}

/// Mémoire résidente du processus, en Kio (Linux : `/proc/self/statm`, pages de 4 Kio) ; `None` ailleurs.
fn resident_kib() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4)
}

impl Render for TimelineBench {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        let costs = self.costs.clone();
        if let Some(previous) = self.last.replace(now) {
            self.report.intervals.push(now - previous);
        }
        // Lignes construites pendant le rendu précédent de la liste (relevé consommé ici).
        let built = self.proto.read(cx).take_built_rows().len();
        if self.frame > 0 {
            self.report.rows_per_frame.push(built);
        }
        self.report.frames = self.frame;

        if !self.done {
            if self.frame >= Self::total_frames() {
                self.finish(cx);
            } else {
                // Prochain pas de défilement, appliqué après ce rendu ; il demande un nouveau rendu.
                let index = self.frame * BENCH_STEP;
                self.frame += 1;
                let proto = self.proto.clone();
                let bench = cx.entity();
                window.on_next_frame(move |_window, cx| {
                    proto.update(cx, |proto, cx| {
                        proto.scroll_to_item(index, cx);
                    });
                    bench.update(cx, |_, cx| cx.notify());
                });
            }
        }
        // Élément de fin d'arbre : peint après la liste, il note le temps écoulé depuis l'entrée dans `render`.
        let end_marker = canvas(|_, _, _| {}, move |_, (), _, _| costs.borrow_mut().push(now.elapsed())).size_0();
        div().size_full().child(self.proto.clone()).child(end_marker)
    }
}

#[cfg(test)]
mod tests {
    // Imports explicites : un `use super::*` ramènerait `gpui_kit::test` et masquerait `#[test]` (récursion de macro).
    use super::{generate_messages, summarize, ProtoBody, ProtoMessage, PROTO_MESSAGES};
    use std::time::Duration;

    #[test]
    fn generation_is_deterministic_and_numbered() {
        let (a, b) = (generate_messages(0, 200, 42), generate_messages(0, 200, 42));
        assert_eq!(a, b, "mêmes graines, mêmes messages");
        assert_eq!(a.iter().map(|m| m.number).collect::<Vec<_>>(), (0..200).collect::<Vec<_>>());
        assert_ne!(a, generate_messages(0, 200, 43), "une autre graine change le contenu");
    }

    #[test]
    fn the_mix_has_variable_heights_and_all_kinds() {
        let messages = generate_messages(0, PROTO_MESSAGES, 42);
        let texts: Vec<usize> = messages
            .iter()
            .filter_map(|m| match &m.body {
                ProtoBody::Text(lines) => Some(lines.len()),
                _ => None,
            })
            .collect();
        assert!(texts.iter().all(|n| (1..=8).contains(n)));
        assert!(texts.contains(&1) && texts.contains(&8), "de 1 à 8 lignes");
        assert!(messages.iter().any(|m| matches!(m.body, ProtoBody::Image { .. })));
        assert!(messages.iter().any(|m| matches!(m.body, ProtoBody::File { .. })));
        let images = messages.iter().filter(|m| matches!(m.body, ProtoBody::Image { .. })).count();
        assert!((250..=550).contains(&images), "≈ 8 % d'images : {images}");
        assert!(messages[0].show_header, "la première ligne a son en-tête");
    }

    #[test]
    fn five_thousand_messages_take_well_under_five_mebibytes_of_model() {
        let messages = generate_messages(0, PROTO_MESSAGES, 42);
        let bytes: usize = messages.iter().map(ProtoMessage::approx_bytes).sum();
        println!("[W06] modèle de {PROTO_MESSAGES} messages : {} Kio (≈ {} o / message)", bytes / 1024, bytes / PROTO_MESSAGES);
        assert!(bytes < 5 * 1024 * 1024, "{bytes} octets");
    }

    #[test]
    fn a_page_of_older_messages_continues_the_numbering() {
        let older = generate_messages(40, 10, 1);
        assert_eq!((older[0].number, older[9].number), (40, 49));
    }

    #[test]
    fn summarize_gives_median_p95_and_max() {
        let ms = |n: u64| Duration::from_millis(n);
        let (median, p95, max) = summarize(&[ms(1), ms(2), ms(3), ms(4), ms(100)]);
        assert_eq!((median, max), (3.0, 100.0));
        assert!(p95 >= 4.0);
        assert_eq!(summarize(&[]), (0.0, 0.0, 0.0));
    }
}
