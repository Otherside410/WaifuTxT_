# Checklist de parité — WaifuChat natif (Rust/GPUI) face au web actuel (W09)

Sources : `README.md` (liste « Fonctionnalités », l. 13-64 et « Problèmes connus », l. 166-167) et `.design/gpui/INVENTAIRE.md` (W02 : section A = fonctions Matrix, ligne = n° + 11 ; section B = capacités Electron, ligne = n° + 99). Code natif : `desktop/crates/{domain,matrix,ui,app,updater}`. État mesuré le 2026-11-16 à HEAD `fed22ec`.

**Statuts** (un seul par ligne) :
- **OK** : prouvé par un test automatisé nommé (fichier:ligne), exécutable ;
- **KO** : testé et en échec (aucune ligne aujourd'hui) ;
- **absent** : aucun code ; preuve = recherche mécanique `grep` à 0 résultat dans `crates/*/src` (rejouable) ;
- **différent** : présent mais autre comportement, décrit ;
- **non mesuré** : code probable mais aucune preuve ; **compte comme non-OK** pour la promotion.

**Règle de promotion** (voir `.design/gpui/PROMOTION.md`) : une seule ligne **KO** bloque. Les lignes **absent**, **différent** et **non mesuré** ne bloquent que si Otherside ne les a pas **acceptées par écrit** (commentaire sur la carte) pour la promotion visée. Aucun statut n'est « OK » sans preuve rejouable.

| fonction | référence (fichier:ligne) | attendu | statut | preuve |
|---|---|---|---|---|
| Authentification Matrix (identifiant / mot de passe) | README.md:17 ; INVENTAIRE.md:15 ; INVENTAIRE.md:16 (n° 5) | connexion à un homeserver choisi | OK | `matrix/tests/homeserver.rs:350` (login puis reprise, 1 passé) ; `ui/tests/login.rs:24,37` |
| Choix du homeserver sur l'écran de connexion | README.md:17 | champ dédié, jamais un domaine public imposé | OK | `ui/tests/login.rs:24` (champ vide sans store), `:37` (dernier serveur proposé) |
| Persistance de session optionnelle | README.md:17 | l'utilisateur peut ne rien laisser sur disque | différent | la session est toujours persistée (jeton dans le store chiffré) ; pas de mode volatile (UI-MAPPING.md §1.1) |
| Chiffrement de bout en bout (envoi / réception) | README.md:18 ; INVENTAIRE.md:23 (n° 12) | message chiffré lu en clair par le destinataire | OK | `matrix/tests/homeserver.rs:399` (reçu déchiffré, `m.room.encrypted` sur le fil) |
| Restauration de clés par clé de récupération (4S) | README.md:19 ; INVENTAIRE.md:54 | historique antérieur déchiffré après saisie | OK | `matrix/tests/homeserver.rs:1085` (`recover` seul) et `:1095` (avec téléchargement explicite) |
| Export / import des clés de salons | README.md:20 ; INVENTAIRE.md:55-56 | fichier chiffré par phrase secrète, compatible Element | absent | `grep -E 'export_room_keys\|import_room_keys' crates/*/src` : 0 fichier ; seul `matrix/tests/homeserver.rs:585` appelle le SDK directement |
| Vérification croisée (SAS) | README.md:21 | modal de vérification d'appareil | absent | `grep -i verification crates/*/src` : 0 fichier |
| Spaces, salons et DMs (barres latérales) | README.md:25 | espaces, canaux, messages directs | différent | liste groupée ESPACES / SALONS / MESSAGES DIRECTS (`ui/tests/render.rs:12`), non-lus ; pas de rail de serveurs (UI-MAPPING.md §1.3) |
| Création de salon dans un espace | README.md:26 ; INVENTAIRE.md:33 ; INVENTAIRE.md:32 (n° 21) | `m.space.child`, selon les droits | absent | `grep -E 'create_room\|set_name\|rename' crates/*/src` : aucun appel hors `updater` |
| Renommer un salon | README.md:27 ; INVENTAIRE.md:42 ; INVENTAIRE.md:43 (n° 32) | depuis l'en-tête | absent | idem |
| Quitter un salon | README.md:28 ; INVENTAIRE.md:41 | confirmation depuis l'en-tête | absent | idem |
| Salons vocaux (expérimental) | README.md:29 ; INVENTAIRE.md:35 ; INVENTAIRE.md:107 ; INVENTAIRE.md:36 (n° 25) | appels vocaux, réglages audio | absent | reporté en v2 : `.design/gpui/VOIX.md` §7 (62 à 89 j) |
| Navigation mobile (menu hamburger) | README.md:30 | panneau latéral animé | absent | abandonné (client de bureau) : UI-MAPPING.md §1.3 |
| Temps réel (timeline, réception des événements) | README.md:34 | messages affichés dès réception | OK | `ui/tests/timeline.rs:232` (message en direct collé en bas) ; `matrix/tests/homeserver.rs:399` |
| Cache mémoire : un salon déjà visité n'est pas rechargé | README.md:34 ; CLAUDE.local.md « Défauts connus » | pas de rechargement complet au focus | non mesuré | aucun test ; aucune occurrence d'un cache de timeline par salon dans `crates/ui` ou `crates/matrix` (seuls `MediaCache` et le cache d'événements du SDK) |
| Historique : pagination vers le haut | README.md:35 ; INVENTAIRE.md:46 ; INVENTAIRE.md:47 (n° 36) | page plus ancienne sans saut ni doublon | OK | `ui/tests/timeline.rs:52` ; `matrix/tests/homeserver.rs:849` (120 messages, sans doublon ni trou) |
| Threads (m.thread) : panneau et liste | README.md:36 ; INVENTAIRE.md:25-27 | fils de discussion | absent | `grep -E 'm\.thread\|thread_root\|ThreadSummary\|ThreadPanel' crates/*/src` : 0 fichier ; banc B11 SKIP |
| Édition (m.replace) avec « modifié » | README.md:37 ; INVENTAIRE.md:28 | texte remplacé, même ligne | OK | `ui/tests/actions.rs:28` ; `matrix/tests/homeserver.rs:734` (relation `m.replace` sur le fil) |
| Réponses (m.in_reply_to) | README.md:38 | aperçu type Discord | absent | `grep -E 'in_reply_to\|reply' crates/*/src` : 0 fichier |
| Réactions (picker, réactions rapides) | README.md:39 ; INVENTAIRE.md:19-20 ; INVENTAIRE.md:18 (n° 7) | ajout / retrait d'une réaction | absent | `grep -E 'm\.reaction\|toggle_reaction\|[Rr]eaction' crates/*/src` : 0 fichier ; banc B09 SKIP |
| Épinglage (m.room.pinned_events), panneau | README.md:40 ; INVENTAIRE.md:87-91 | épingler, lister, désépingler | absent | `grep -E 'pinned_events\|PinnedEvent\|unpin' crates/*/src` : 0 fichier ; banc B12 SKIP |
| Suppression (redaction) avec confirmation | README.md:41 ; INVENTAIRE.md:39 ; INVENTAIRE.md:40 (n° 29) | espace réservé « Message supprimé » | OK | `ui/tests/actions.rs:84` (confirmation puis ligne de même hauteur) ; `matrix/tests/homeserver.rs:734` (`m.room.redaction`) |
| Copier le contenu d'un message | README.md:42 | bouton sur les messages éligibles | absent | `grep -E 'ClipboardItem\|write_to_clipboard' crates/*/src` : 0 fichier |
| Mentions (@localpart → MXID) | README.md:43 | extension à l'envoi, mise en forme | absent | aucun traitement de mention dans `crates/*/src` (le seul « mention » est le texte « modifié ») |
| Markdown (GFM, coloration) | README.md:44 | rendu des messages formatés | absent | texte brut uniquement ; `grep -i markdown crates/*/src` : 0 fichier |
| Emoji (autocomplétion `:`, shortcodes, bouton) | README.md:45 | sélecteur et complétion | absent | `grep -i emoji crates/*/src` : 0 fichier |
| Saisie : capitalisation automatique | README.md:46 | majuscule en début de message et après . ! ? | absent | `grep -E 'auto_?capital\|capitalize' crates/*/src` : 0 fichier |
| Saisie : Entrée envoie, Maj+Entrée saute une ligne, champ 1 à 5 lignes | (natif) | comportement du composeur | OK | `ui/tests/composer.rs:99,138` |
| Envoi avec écho local puis confirmation, échec visible et réessai | (natif) ; INVENTAIRE.md:24 (n° 13) | pas de doublon, brouillon restitué | OK | `ui/tests/composer.rs:179,222` |
| Indicateurs de frappe | README.md:47 ; INVENTAIRE.md:49 | qui écrit, en temps réel | OK | `ui/tests/actions.rs:216,268,306` ; `matrix/tests/homeserver.rs:795` (apparition puis disparition < 3,5 s) |
| Indicateurs de frappe : style « points » ou « waifu » | README.md:47 | animation au choix | différent | texte « X écrit… » sans animation (UI-MAPPING.md §1.2) |
| Accusés de lecture (avatars des lecteurs) | README.md:48 ; INVENTAIRE.md:50-53 | « vu par … » sur le dernier message | OK | `ui/tests/actions.rs:157,333` ; `matrix/tests/homeserver.rs:795` (`m.read` du serveur, `read_by` chez l'autre) |
| Images et fichiers : envoi et affichage, y compris chiffrés | README.md:52 ; INVENTAIRE.md:37-38 ; INVENTAIRE.md:83-84 | déchiffrement côté client, md5 identique | OK | `ui/tests/media.rs:39,131,145,201` ; `matrix/tests/homeserver.rs:523` (md5 de la source = md5 reçu, taille et dimensions annoncées) |
| Vidéos : envoi et lecture | README.md:52 ; INVENTAIRE.md:44 | lecture dans la timeline | différent | carte fichier + ouverture externe ; aucune lecture intégrée (UI-MAPPING.md §1.2) |
| **Bug connu : image + texte dans un même message (Element)** | README.md:167 ; CLAUDE.local.md « Défauts connus » | l'image se charge quand elle accompagne un texte | non mesuré | aucun test ne fabrique un message mixte d'Element ; non reproduit ici ; banc B13 SKIP ; à mesurer avec un vrai message Element (image avec légende, `body` ≠ `filename`) |
| Messages vocaux (enregistrement, `m.audio` + drapeaux) | README.md:53 ; INVENTAIRE.md:45 | lecteur dans la timeline | absent | aucun code audio ; drapeau vocal à poser explicitement (CLAUDE.local.md) |
| Aperçus d'URL (Open Graph) | README.md:54 ; INVENTAIRE.md:85-86 | carte d'aperçu | absent | `grep -E 'url_preview\|preview_url' crates/*/src` : 0 fichier |
| Statut personnalisé / présence | README.md:58 ; INVENTAIRE.md:58-64 ; INVENTAIRE.md:68 (n° 57) | statut visible en ligne / profil | absent | `grep -i presence crates/*/src` : 0 fichier |
| Avatar de profil (recadrage, upload) ; avatars d'utilisateurs | README.md:59 ; INVENTAIRE.md:21-22 ; INVENTAIRE.md:66-67 ; INVENTAIRE.md:65 (n° 54) ; INVENTAIRE.md:81-82 (n° 70-71) ; INVENTAIRE.md:92 (n° 81) | image d'avatar | différent | initiales colorées seulement (`EventVm.sender_initials`) ; aucun avatar image |
| Bannière et bio de profil | INVENTAIRE.md:69-75 | upload, lecture | absent | `grep -E 'avatar_url\|set_avatar' crates/*/src` : 0 fichier |
| Thème clair / sombre et couleur d'accent | README.md:60 | choix de l'utilisateur | différent | thème sombre fixe ; clair, OLED et accent non faits (types de thème conçus dans UI-MAPPING.md §3, non intégrés) |
| Waifu (opt-in) Miku / Airi | README.md:61 | illustrations locales | absent | `grep -iE 'miku|\bairi\b' crates/*/src` : 0 fichier |
| Notifications | README.md:62 ; INVENTAIRE.md:114 | notifications système | absent | `grep -E 'notify_rust|Notification::new|send_notification' crates/*/src` : 0 fichier |
| Raccourcis clavier | README.md:63 | hooks par écran | absent | seuls Entrée / Maj+Entrée du composeur (ligne ci-dessus) ; aucun raccourci global |
| Version visible dans les paramètres (section Compte) | README.md:64 | numéro de version | différent | `waifu-desktop --version` (`app/src/update.rs`) ; aucun écran Paramètres |
| Liste des appareils, renommer, supprimer une session | INVENTAIRE.md:76-78 | gestion des sessions | absent | `grep -E 'get_devices|delete_devices|rename_device' crates/*/src` : 0 fichier |
| Vérification d'appareil / bannière de sauvegarde de clés | INVENTAIRE.md:79-80 ; README.md:19 ; INVENTAIRE.md:57 (n° 46) | bannière quand les clés manquent | OK | `ui/tests/render.rs:12,47` (fenêtre de clé de récupération ouverte puis fermée puis rouvrable) |
| Retrouver / créer un message privé | INVENTAIRE.md:31 | DM avec un utilisateur | différent | les DM existants sont listés (classés par `is_direct`, `crates/matrix/src/rooms.rs:29`) ; ni création ni recherche d'un utilisateur (`grep -E 'create_dm\|create_direct' crates/*/src` : 0 fichier) |
| Rejoindre / refuser une invitation | INVENTAIRE.md:29-30 | invitations | absent | `grep -E 'join_room\|decline' crates/*/src` : 0 fichier |
| Marquer plusieurs salons comme lus | INVENTAIRE.md:51 | lecture de masse | différent | seul le salon ouvert est marqué lu (`TimelineCommand::MarkRead`, `ui/tests/actions.rs:333`) |
| Déconnexion (serveur + purge locale) | INVENTAIRE.md:17 | jeton invalidé, session effacée | OK | `matrix/tests/homeserver.rs:948` (401 sur l'ancien jeton, dossier de session supprimé) |
| Reprise hors ligne et instantané local des salons | (natif) | salons affichés sans serveur | OK | `ui/tests/connection.rs:11,45,61` ; `crates/matrix/src/client.rs` test de reprise hors ligne |
| Instance unique + refocus | INVENTAIRE.md:100 | une seule instance | absent | `grep -iE 'single.?instance\|second.?instance' crates/*/src` : 0 fichier |
| Fenêtre sans cadre, boutons réduire / agrandir / fermer, F11 | INVENTAIRE.md:110-111 | barre de titre maison | différent | décorations du système (`TitlebarOptions` de `app/src/main.rs`) ; barre maison non faite |
| Liens externes ouverts dans le navigateur | INVENTAIRE.md:112 | http(s) dans le navigateur du système | absent | `grep -E 'open::\|open_url' crates/*/src` : 0 fichier |
| Correcteur orthographique du champ de saisie | INVENTAIRE.md:113 | soulignement des fautes | absent | aucun appel dans `crates/*/src` |
| Mise à jour automatique (vérification périodique, téléchargement, redémarrage) | INVENTAIRE.md:115 | vérifie à 5 s puis toutes les 4 h | différent | mise à jour **manuelle** signée (`--update <URL>`, `--rollback`) : 18 tests `crates/updater/tests/updater.rs` ; pas de vérification périodique |
| Lancement au démarrage du système | INVENTAIRE.md:117 | clé de registre / autostart XDG | absent | `grep -iE 'autostart' crates/*/src` : 0 fichier |
| Proxy API Steam (lien de compte) | INVENTAIRE.md:118 | GET/POST/DELETE whitelistés | absent | `grep -i steam crates/*/src` : 0 fichier |
| Partage d'écran (+ son du système) et sélecteur de source | INVENTAIRE.md:107-109 | vers le flux vidéo vocal | absent | reporté en v2 avec la voix : `.design/gpui/VOIX.md` §3, §7 |
| Liste des membres du salon (panneau : avatars, présence, carte de profil) | INVENTAIRE.md:48 (n° 37 `loadRoomMembers`) ; web `src/components/layout/MemberPanel.tsx:17` | panneau des membres du salon | absent | `grep -rIlE 'create_space\|createSpace\|MembersPanel\|member_list\|load_members' crates/*/src` : 0 fichier |
| Créer un espace | INVENTAIRE.md:34 (n° 23 `createSpace`) ; web `src/components/layout/SpaceSidebar.tsx:128` | création d'un espace depuis la barre latérale | absent | même `grep` : 0 fichier |

## Totaux (lignes : 62)

| statut | lignes |
|---|---|
| OK | 16 |
| KO | 0 |
| absent | 33 |
| différent | 11 |
| non mesuré | 2 |

## Rejouer les preuves

- Tests d'interface (sans réseau) : `cd desktop && cargo test --locked` (199 passés, 13 ignorés).
- Tests contre le homeserver de test : `packaging/bench-headless.sh` (étapes B03-B10 ; voir son rapport).
- Recherches « absent » : le banc les rejoue pour réactions, fils et épinglage (B09, B11, B12) ; les autres sont les `grep` de la colonne « preuve ».
- Rendu réel : `packaging/visual-check.sh` sur le poste Nobara (`.design/gpui/ENVIRONNEMENTS.md` §5).
