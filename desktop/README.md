# WaifuChat — client natif (Rust / GPUI)

Client de bureau Matrix, en Rust, avec rendu natif. C'est une **réécriture** de l'application web/Electron qui vit à la
racine de ce dépôt (`src/`), pas un portage : mêmes fonctions visées, pile complètement différente.

- Pile : `gpui-kit 0.9.1` (rendu), `matrix-sdk 0.19.1` + `matrix-sdk-ui 0.19.1` (protocole, E2EE), Tokio 1.x (réseau).
- Version : `0.67.0` — lignée de version de l'application, pas une numérotation séparée. `waifu-desktop --version` et le tag
  Git disent la même chose.
- État : **socle**. Voir « Ce qui marche » et `packaging/parity-checklist.md` (16 fonctions prouvées OK sur 62 lignes de
  référence, 30 absentes, 14 différentes, 2 non mesurées).

## Construire et lancer

```bash
cd desktop
cargo build --locked                       # debug
cargo test --locked                        # 254 tests, 14 ignorés (réseau/homeserver)
./target/debug/waifu-desktop               # connexion Matrix classique
./target/debug/waifu-desktop --demo-ui     # démonstration hors ligne : barre latérale + panneau de clés
./target/debug/waifu-desktop --demo-timeline   # démonstration hors ligne : salon, messages, actions
./target/debug/waifu-desktop --version
```

Le rendu demande un GPU (Vulkan) ; sans écran physique, un Xvfb + llvmpipe suffit pour les captures et le banc :

```bash
Xvfb :99 -screen 0 1280x800x24 & export DISPLAY=:99
./target/debug/waifu-desktop --demo-timeline & sleep 8
import -window root /tmp/wafu.png
```

Emballage et distribution : voir `packaging/` (AppImage reproductible, mise à jour signée, conteneur de build hermétique pour
compatibilité glibc, banc de recette headless, checklist de parité). Rien de tout cela n'a été validé sur une machine
utilisateur.

## Ce qui marche

- connexion Matrix sur un homeserver au choix, session persistée chiffrée, déconnexion qui invalide le jeton ;
- chiffrement de bout en bout (envoi et réception), restauration d'historique par clé de récupération ;
- timeline en temps réel, pagination vers le haut, écho local d'envoi avec échec visible et réessai ;
- édition (`m.replace`), suppression (`m.room.redaction`), pièces jointes chiffrées, indicateurs de frappe, accusés de lecture ;
- reprise hors ligne sur l'instantané local des salons.

Le détail ligne par ligne, avec le test qui le prouve, est dans `packaging/parity-checklist.md`.

## Ce qui n'existe pas encore

Sélecteur de réactions complet (catégories, recherche, emojibase, Twemoji ; les réactions rapides existent, avec 16
émojis et 8 récents), bouton d'émoji dans le composeur (complétion `:`, shortcodes), fils, épinglage, réponses,
mentions, markdown, upload et recadrage d'avatar, panneau des membres, création/renommage de salon, invitations,
notifications système, raccourcis clavier, réglage du thème clair/OLED et de l'accent (le mode sombre et l'accent par
défaut sont câblés en dur), messages et salons vocaux.

## Organisation du code

```
crates/
├── domain/    types purs (pas d'I/O, pas d'UI) : messages, salons, session, médias
├── matrix/    la seule crate qui parle matrix-sdk : login, sync, timeline, envoi, médias
├── ui/        vues GPUI et thème ; aucune logique réseau
├── app/       assemblage : fenêtre, commandes, pont Tokio <-> GPUI, mise à jour
└── updater/   manifeste signé, remplacement du binaire, retour arrière
```

Règles de dépendance : `ui` ne dépend jamais de `matrix` (elle reçoit un état, elle ne va pas le chercher) ; aucun type de
`matrix-sdk` ne sort de `matrix` ; `domain` ne connaît ni GPUI ni Tokio. Le pont entre l'exécuteur Tokio et celui de GPUI est
dans `app/bridge.rs` — c'est le point à lire en premier si vous touchez à l'asynchrone.

## Thème

`ui/theme.rs` porte les tokens (surfaces, texte, états, accent) avec les valeurs de l'application web ; `ui/theme_gpui.rs` les
convertit en `Hsla`, les publie en global GPUI et les copie dans le thème du kit pour que `Input`, `Textarea` et `Button`
suivent. Une vue ne lit jamais une couleur littérale : elle lit `Palette`. Seul le mode sombre est câblé aujourd'hui.
