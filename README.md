# WaifuTxT_

Client web pour le protocole [Matrix](https://matrix.org), avec une interface inspirée de Discord et un thème cyberpunk / anime.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?logo=tailwindcss&logoColor=white)
![Matrix](https://img.shields.io/badge/Matrix-000000?logo=matrix&logoColor=white)

## Fonctionnalités

### Connexion & chiffrement

- **Authentification Matrix** — identifiant / mot de passe, choix du **homeserver** sur l’écran de connexion + persistance de session optionnelle
- **Chiffrement de bout en bout (E2EE)** — via `matrix-sdk-crypto-wasm` (crypto Rust)
- **Restauration de clés** — déchiffrement de l’historique via la clé de récupération (Secret Storage / 4S)
- **Vérification croisée** — flux de vérification d’appareils (modal dédiée)

### Navigation & salons

- **Spaces, salons et DMs** — barres latérales type Discord (serveurs, canaux, messages directs)
- **Création de salon** — dans un espace, si les droits Matrix le permettent (`m.space.child`)
- **Renommer un salon** — depuis l’en-tête du salon (selon les power levels)
- **Quitter un salon** — confirmation depuis l’en-tête
- **Salons vocaux (expérimental)** — appels vocaux Matrix / groupe (panneau dédié, réglages audio)

### Messagerie

- **Temps réel** — timeline, réception des événements, **cache en mémoire** : un salon déjà visité n’est pas rechargé entièrement depuis le SDK au prochain focus (évite un `setMessages` inutile)
- **Historique** — pagination vers le haut (`prependMessages`, indépendant du cache ci-dessus)
- **Édition** — `m.replace` avec indicateur « modifié »
- **Réponses** — `m.in_reply_to` avec aperçu type Discord
- **Réactions** — picker emoji (catégories, recherche), réactions rapides personnalisables
- **Épinglage** — état `m.room.pinned_events`, panneau « Messages épinglés » (aperçu texte / médias, désépinglage)
- **Suppression (redaction)** — selon les droits Matrix, avec confirmation
- **Copier le contenu** — bouton sur les messages éligibles
- **Mentions** — `@localpart` étendu en MXID à l’envoi, mise en forme à l’affichage
- **Markdown** — `react-markdown`, GFM, coloration syntaxique
- **Emoji** — `:` pour l’autocomplétion, shortcodes → emoji, bouton dans la barre de saisie
- **Saisie** — capitalisation automatique en début de message et après `.` `!` `?`
- **Indicateurs de frappe** — temps réel, style « points » ou « waifu »
- **Accusés de lecture** — avatars des lecteurs sur vos messages envoyés

### Médias & fichiers

- **Images, vidéos, fichiers** — envoi et affichage (y compris contenus chiffrés, déchiffrement côté client)
- **Messages vocaux** — enregistrement micro, envoi `m.audio` avec drapeaux vocaux (MSC3245 / MSC1767), lecteur dans la timeline
- **Aperçus d’URL** — récupération Open Graph côté client quand c’est possible

### Profil & interface

- **Statut personnalisé** — message de statut, visible en ligne / profil
- **Avatar profil** — recadrage / upload
- **Thème & accent** — clair / sombre, couleur d’accent
- **Waifu (opt-in)** — Miku / Airi en local
- **Notifications** — API Notifications du navigateur
- **Raccourcis clavier** — hooks dédiés selon les écrans

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Framework | React 19 + TypeScript |
| Build | Vite 7 |
| Style | Tailwind CSS v4 (variables CSS) |
| SDK Matrix | `matrix-js-sdk` v41 |
| Crypto E2EE | `@matrix-org/matrix-sdk-crypto-wasm` |
| Emojis | `emojibase-data`, `emoji-picker-react`, Twemoji (CDN) |
| State | Zustand 5 |
| Routage | React Router 7 |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` |
| Dates | `date-fns` |
| Qualité dev | ESLint + Husky |

Pas d’**axios** : HTTP via `fetch` / SDK Matrix.

## Installation

```bash
git clone https://github.com/Otherside410/WaifuTxT_.git
cd WaifuTxT_
npm install
```

### Homeserver

L’URL du homeserver est saisie **sur l’écran de connexion** (champ dédié, valeur par défaut `https://matrix.org`). Aucune constante obligatoire à modifier dans le code pour un usage normal.

## Lancement

```bash
npm run dev
```

Application sur `http://localhost:5173` (ou le port indiqué par Vite).

## Build production

```bash
npm run build
npm run preview
```

## Structure du projet

```
src/
├── assets/waifu/           # Illustrations waifu (Miku, Airi)
├── components/
│   ├── auth/               # LoginScreen
│   ├── chat/               # ChatArea, MessageList, MessageItem, MessageInput,
│   │                       # PinnedMessagesPanel, RoomHeader, KeyBackupBanner, TypingIndicator
│   ├── common/             # Avatar, EmojiPicker, Tooltip, etc.
│   ├── layout/             # AppShell, SpaceSidebar, RoomSidebar, MemberPanel,
│   │                       # VoicePanel, SettingsModal
│   ├── settings/           # Thème, accent, profil, réactions rapides, audio
│   ├── verification/       # Vérification E2EE
│   └── voice/              # Vue salon vocal
├── hooks/                  # useNotifications, useKeyboardShortcuts
├── lib/
│   ├── matrix.ts           # Client SDK, sync, médias, pièces jointes, pins, vocaux, rooms
│   ├── voice.ts            # Flux audio appels groupe
│   ├── verification.ts
│   └── waifu.ts
├── stores/
│   ├── authStore.ts
│   ├── roomStore.ts
│   ├── messageStore.ts     # Messages, typing, pins, loadedRooms (cache init par salon)
│   ├── uiStore.ts
│   ├── voiceStore.ts
│   └── verificationStore.ts
├── types/matrix.ts
├── styles/theme.css
├── App.tsx
└── main.tsx
```

## Performances & UX

- **Salons déjà chargés** — `loadedRooms` dans le store : `loadInitialMessages` ne réécrit pas la timeline si le salon a déjà été initialisé dans la session (les événements temps réel continuent d’alimenter le store)
- **React.memo / picker emoji** — limitation des re-renders, rendu progressif des catégories (`requestIdleCallback`)
- **Picker monté de façon persistante** — transitions CSS plutôt que remontage complet
- **`content-visibility: auto`** — sections hors écran du picker moins coûteuses à peindre

## Problèmes connus

- **Image + texte dans un même message** : sur certains messages venant d’autres clients (ex. Element), l’image peut mal se charger alors qu’un média seul fonctionne. Piste : tracer les URLs media et codes HTTP au rendu.

## Versioning automatique sur commit

Incrément de version dans `package.json` via Husky selon le message de commit :

- `feat: …` → **minor**
- `fix: …` → **patch**
- `feat!: …` ou `BREAKING CHANGE:` → **major**
- autre → **patch**

Exemples :

```bash
git commit -m "feat(chat): add fullscreen image viewer"
git commit -m "fix(media): improve authenticated image loading"
git commit -m "feat!: replace legacy room store API"
```

## Licence

Projet personnel — pas de licence définie pour le moment.
