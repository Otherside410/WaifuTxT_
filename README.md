# WaifuTxT_

Client web pour le protocole [Matrix](https://matrix.org), avec une interface inspirée de Discord et un thème cyberpunk/anime.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?logo=tailwindcss&logoColor=white)
![Matrix](https://img.shields.io/badge/Matrix-000000?logo=matrix&logoColor=white)

## Fonctionnalites

- **Authentification Matrix** — login identifiant/mot de passe + persistance de session
- **Salons, Spaces et DMs** — navigation inspiree de Discord (serveurs, channels, messages directs)
- **Messagerie temps reel** — timeline, historique, envoi/reception des messages
- **Chiffrement de bout en bout (E2EE)** — via `matrix-sdk-crypto-wasm` (Rust crypto)
- **Restauration de cles** — dechiffrement de l'historique via la cle de recuperation (Secret Storage / 4S)
- **Medias Matrix** — upload et affichage d'images/videos/fichiers, y compris contenus chiffres
- **Edition de messages** — support Matrix `m.replace` avec indicateur `(modifie)`
- **Reponses de messages** — support Matrix `m.in_reply_to` avec preview style Discord
- **Reactions aux messages** — picker emoji Discord-like avec categories, recherche et **reactions rapides personnalisables**
- **Emoji autocomplete** — tapez `:` pour lancer les suggestions, conversion automatique des shortcodes `:joy:` → 😂
- **Markdown** — rendu avec `react-markdown`, support GFM et coloration syntaxique
- **Mentions** — mise en avant des mentions et aide a la saisie (@user, #room tags)
- **Indicateurs de frappe** — affichage en temps reel, mode `3 points` ou `waifu`
- **Read receipts** — avatars des lecteurs sur les messages envoyes
- **Statut personnalise** — message de statut custom, visible sur le profil et en ligne
- **Personnalisation waifu (opt-in)** — choix local de waifu (Miku / Airi) dans l'apparence
- **Personnalisation reactions rapides** — gerez votre liste d'emojis pour reactions rapides via Parametres → Personnalisation
- **Notifications** — via l'API Notification du navigateur
- **Bouton emoji dans la barre de chat** — insertez des emojis directement a votre position de curseur

## Stack technique

| Couche | Technologie |
|---|---|
| Framework | React 19 + TypeScript |
| Build | Vite 7 |
| Style | Tailwind CSS v4 (variables CSS custom) |
| SDK Matrix | `matrix-js-sdk` v41 |
| Crypto E2EE | `@matrix-org/matrix-sdk-crypto-wasm` |
| Emojis | `emojibase-data` + Twemoji CDN |
| State | Zustand |
| Routage | React Router |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` |
| Dates | `date-fns` |
| Qualite dev | ESLint + Husky |

## Installation

```bash
git clone https://github.com/otherside/WaifuTxT_.git
cd WaifuTxT_
npm install
```

### Configuration du homeserver

Modifiez le `homeserver` dans `src/lib/matrix.ts` si necessaire :

```typescript
const HOMESERVER_URL = 'https://matrix.example.com'
```

Par defaut, pointe sur un serveur de test. Adaptez l'URL a votre instance Matrix.

## Lancement

```bash
npm run dev
```

L'app est accessible sur `http://localhost:5173` (ou le port suivant disponible).

## Build production

```bash
npm run build
npm run preview
```

## Structure du projet

```
src/
├── assets/
│   └── waifu/              # PNG waifu (Miku, Airi)
├── components/
│   ├── auth/               # LoginScreen
│   ├── chat/               # ChatArea, MessageList, MessageItem, MessageInput,
│   │                       # KeyBackupBanner, TypingIndicator
│   ├── common/             # Avatar, EmojiPicker, composants reutilisables
│   ├── layout/             # AppShell, SpaceSidebar, RoomSidebar, SettingsModal
│   └── settings/           # ThemePicker, AccentColorPicker, ProfileStatusSettings,
│   │                       # CustomizationSettings (reactions rapides)
│   └── verification/       # UI de verification cross-signing
├── lib/
│   ├── matrix.ts           # Interface avec matrix-js-sdk (init, events, crypto, media)
│   ├── waifu.ts            # Catalogue waifu et helpers
│   └── verification.ts     # Logique de verification E2EE
├── stores/
│   ├── authStore.ts        # Session & authentification (Zustand)
│   ├── roomStore.ts        # Salons & espaces
│   ├── messageStore.ts     # Messages, receipts, indicateurs de frappe
│   ├── uiStore.ts          # Etat UI (settings, waifu, reply preview, etc.)
│   └── verificationStore.ts# Etat de verification E2EE
├── types/
│   └── matrix.ts           # Types TypeScript (Session, Message, Room, etc.)
├── styles/
│   └── theme.css           # Variables de theme cyberpunk + animations
├── App.tsx
└── main.tsx
```

## Optimisations performance

- **React.memo sur les boutons emoji** — court-circuit des re-renders inutiles lors du survol
- **Rendu progressif des categories emoji** — premiere categorie instantanee, reste via `requestIdleCallback` pour ne pas bloquer le thread principal
- **Picker maintenu en vie** — le picker emoji dans la barre de chat reste monte apres la premiere ouverture, transitions CSS seulement
- **Animation d'entree fluide** — keyframe CSS avec scale + translateY (130ms)
- **`content-visibility: auto`** — le navigateur saute le rendu des sections hors-ecran du picker

## Known Issues

- **Affichage des images avec texte (messages entrants)**: sur certains messages Matrix qui contiennent une image + du texte (notamment depuis d'autres clients comme Element), l'image peut ne pas se charger correctement dans WaifuTxT_ alors que le fichier/image seul fonctionne.
- **Statut**: non resolu a ce stade, plusieurs fallbacks d'auth media sont deja en place, mais le cas persiste selon le homeserver/client emetteur.
- **Piste de correction**: tracer precisement les URLs media recues (`url`, `file.url`, `thumbnail_url`) et les codes HTTP au moment du rendu pour harmoniser le chargement avec le comportement d'Element.

## Versioning automatique sur commit

Le projet incremente automatiquement la version (`package.json`) a chaque commit via Husky.

- `feat: ...` -> bump **minor**
- `fix: ...` -> bump **patch**
- `feat!: ...` ou `BREAKING CHANGE:` -> bump **major**
- tout autre type de commit -> bump **patch**

Exemples:

```bash
git commit -m "feat(chat): add fullscreen image viewer"
git commit -m "fix(media): improve authenticated image loading"
git commit -m "feat!: replace legacy room store API"
```

## Licence

Projet personnel — pas de licence definie pour le moment.
