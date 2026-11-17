# WaifuChat — version 0.67.0

**L'implémentation native en Rust/GPUI a débuté.** Ce qui fonctionne aujourd'hui, de bout en bout : **l'authentification
Matrix**, le **chargement des messages** et la **reprise par clé de récupération**. Rien de plus n'est revendiqué pour cette
version : c'est un socle technique, pas encore un client de tous les jours.

Numérotation : on continue la ligne de version de l'application (dernière publiée : `v0.66.1`), et le crate natif
(`desktop/Cargo.toml`) est aligné sur `0.67.0` — `waifu-desktop --version` affiche donc la même version que le tag.

## Périmètre revendiqué

- connexion à un homeserver Matrix au choix (champ explicite, aucun domaine public imposé), session persistée chiffrée ;
- chargement de la timeline et pagination de l'historique ;
- restauration de l'historique par clé de récupération (4S), messages antérieurs compris ;
- chiffrement de bout en bout au repos et en transit (le trafic porte bien `m.room.encrypted`).

## Existe en code, mais **non livré** (aucune validation sur un poste réel)

Envoi, édition, suppression, pièces jointes chiffrées, indicateurs de frappe, accusés de lecture, reprise hors ligne : du code
et des tests existent dans `desktop/crates/`, mais rien de tout cela n'a été validé sur une vraie machine avec un vrai compte.
À traiter comme absent tant que ce n'est pas mesuré.

## Apparence : connue, pas corrigée

L'interface est utilitaire. Mesuré sous Xvfb : fond `#0b0b12` et accent `#ff2d78` conformes au web, mais **les champs et les
boutons restent clairs** (`#FDFDFD`, `#FBFBF9`) parce que le thème du kit graphique n'est jamais basculé en sombre — d'où un
contraste de placeholder à 3,37:1. Le lot de correction est en cours ; la densité (regroupement des messages, actions au
survol, avatars réels, vignettes) suit.

## Vérifier soi-même

```bash
cd desktop
cargo test --locked                              # tests du client natif
./target/release/waifu-desktop --demo-ui         # menu latéral, panneau de clé de récupération
./target/release/waifu-desktop --demo-timeline   # salon de démonstration
./target/release/waifu-desktop --version         # version du binaire
```
