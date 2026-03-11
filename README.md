# WaifuTxT_

Client web pour le protocole [Matrix](https://matrix.org), avec une interface inspirée de Discord et un thème cyberpunk/anime.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React_19-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS_v4-06B6D4?logo=tailwindcss&logoColor=white)
![Matrix](https://img.shields.io/badge/Matrix-000000?logo=matrix&logoColor=white)

## Fonctionnalites

- **Authentification** — login par identifiant/mot de passe, persistance de session
- **Salons & Spaces** — navigation par espaces, salons, et messages directs
- **Messagerie** — envoi/reception de messages texte en temps reel
- **Chiffrement de bout en bout (E2EE)** — via `matrix-sdk-crypto-wasm` (Rust crypto)
- **Restauration de cles** — dechiffrement de l'historique via la cle de recuperation (Secret Storage / 4S)
- **Medias chiffres** — dechiffrement et affichage des images, videos, fichiers dans les salons E2EE
- **Markdown** — rendu avec `react-markdown`, support GFM et coloration syntaxique
- **Upload** — envoi d'images et fichiers
- **Indicateurs de frappe** — affichage en temps reel
- **Notifications** — via l'API Notification du navigateur

## Stack technique

| Couche | Technologie |
|---|---|
| Framework | React 19 + TypeScript |
| Build | Vite 7 |
| Style | Tailwind CSS v4 (variables CSS custom) |
| SDK Matrix | `matrix-js-sdk` v41 |
| Crypto E2EE | `@matrix-org/matrix-sdk-crypto-wasm` |
| State | Zustand |
| Routage | React Router |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-highlight` |
| Dates | `date-fns` |

## Installation

```bash
git clone https://github.com/<ton-user>/WaifuTxT_.git
cd WaifuTxT_
npm install
```

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
├── components/
│   ├── auth/          # LoginScreen
│   ├── chat/          # ChatArea, MessageList, MessageItem, MessageInput,
│   │                  # KeyBackupBanner, TypingIndicator
│   ├── common/        # Avatar, composants reutilisables
│   └── layout/        # AppShell, SpaceSidebar, RoomSidebar, MemberList
├── lib/
│   └── matrix.ts      # Interface avec matrix-js-sdk (init, events, crypto, media)
├── stores/
│   ├── authStore.ts   # Session & authentification (Zustand)
│   ├── roomStore.ts   # Salons & espaces
│   └── messageStore.ts# Messages & indicateurs de frappe
├── types/
│   └── matrix.ts      # Types TypeScript (Session, Message, Room, etc.)
├── styles/
│   └── theme.css      # Variables de theme cyberpunk
├── App.tsx
└── main.tsx
```

## Licence

Projet personnel — pas de licence definie pour le moment.
