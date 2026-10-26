# SyncPad 🚀

> **Distraction-free, real-time cross-device Notes & Markdown Editor PWA** deployed on Cloudflare Workers.

SyncPad is an offline-first, zero-friction Progressive Web Application that lets you write, preview, organize, and synchronize markdown notes instantaneously across all your phones, laptops, and tablets without requiring passwords or account creation.

---

## ✨ Features

- **⚡ Zero-Friction Cross-Device Sync**:
  - Private sync room codes (e.g. `PAD-742`, `SYNC-492`).
  - Shareable link (`https://your-domain.com/?room=SYNC-492`) connects phones and tablets in 1 click.
  - Live bi-directional updates via WebSockets backed by Cloudflare Workers & Durable Objects.
- **🛡️ 100% Offline-First Architecture**:
  - Full local persistence via browser **IndexedDB**.
  - Queued offline edits sync automatically when back online.
  - Robust Last-Write-Wins (LWW) conflict resolution with UTC timestamps and version counters.
- **📝 Distraction-Free Markdown Editor**:
  - Live side-by-side **Split View**, **Editor Only**, and **Preview Only** modes.
  - Instant word count, character count, line count, and reading time statistics.
  - Rich Markdown support: headings, code blocks with syntax copy, blockquotes, tables, task lists (`- [ ]`), strikethrough, highlights, and safe link sanitization.
  - Quick formatting toolbar + keyboard shortcuts (`Ctrl+B`, `Ctrl+I`, `Ctrl+S`, `Ctrl+N`, `Ctrl+P`).
- **🏷️ Smart Organization**:
  - Instant real-time search across titles, content, and tags.
  - Tag filtering with interactive tag chips.
  - Pinned notes section (`⭐ Pin`) keeping your essential notes at the top.
  - Export notes as `.md` files or copy raw markdown to clipboard with 1 click.
- **📱 Installable PWA & Responsive Design**:
  - Full Progressive Web App (PWA) with Service Worker offline caching and Web App Manifest.
  - Works seamlessly on mobile devices with slide-out navigation and responsive split views.
  - Dark and Light themes with automatic system preference detection.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   SyncPad Client (PWA)                      │
│                                                             │
│  ┌──────────────────┐  IndexedDB  ┌──────────────────────┐  │
│  │  Markdown Editor │ ──────────> │   Local Notes Store  │  │
│  │  & Live Preview  │             │   & Sync Outbox      │  │
│  └──────────────────┘             └──────────┬───────────┘  │
│                                              │              │
│                                     WebSocket / REST        │
└──────────────────────────────────────────────┼──────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Cloudflare Workers Edge                     │
│                                                             │
│  ┌─────────────────────────┐     ┌───────────────────────┐  │
│  │ Workers Static Assets   │     │ SyncRoom (Durable     │  │
│  │ (Serves ./public)       │     │ Object / WebSockets)  │  │
│  └─────────────────────────┘     └───────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Sync Protocol

1. **Connection**: Client opens a WebSocket to `/api/room/{roomCode}/ws?deviceId={id}`.
2. **Join / Handshake**: Client sends `JOIN`, server welcomes client and returns active room notes (`ROOM_SYNC_RESPONSE`).
3. **Live Propagation**: Edits emit `NOTE_UPDATE` to all other connected peers in the same room.
4. **Presence**: Server broadcasts `PEER_PRESENCE` with active device count.
5. **Conflict Resolution**: Client and Server use deterministic Last-Write-Wins (LWW) based on UTC `updatedAt` timestamps and incremental note version counters.
6. **Fallback**: If WebSockets are blocked by proxies, client falls back to `/api/room/{roomCode}/sync` REST endpoint.

---

## 📁 Project Structure

```
syncpad/
├── public/
│   ├── css/
│   │   └── style.css            # Responsive styles & dark/light theme
│   ├── js/
│   │   ├── app.js               # Application coordinator & keyboard shortcuts
│   │   ├── db.js                # Offline-first IndexedDB manager
│   │   ├── markdown.js          # Zero-dependency Markdown parser & sanitizer
│   │   ├── sync.js              # WebSocket & room sync manager
│   │   └── ui.js                # Reactive DOM rendering & toast notifications
│   ├── icons/
│   │   ├── favicon.svg          # App favicon
│   │   ├── icon-192.svg         # PWA icon 192x192
│   │   └── icon-512.svg         # PWA icon 512x512
│   ├── index.html               # Semantic HTML5 app shell
│   ├── manifest.webmanifest     # PWA manifest
│   └── sw.js                    # PWA Service Worker for offline caching
├── test/
│   ├── markdown.test.js         # Automated Markdown parser tests
│   └── worker.test.js           # Automated Cloudflare Worker sync tests
├── worker.js                    # Cloudflare Worker & Durable Object backend
├── wrangler.jsonc               # Cloudflare Wrangler configuration
├── package.json                 # Project scripts and dependencies
└── README.md                    # Project documentation
```

---

## 🚀 Cloudflare Deployment

SyncPad is designed for deployment with [Cloudflare Workers](https://workers.cloudflare.com/) and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

### Prerequisites

Ensure you have [Node.js](https://nodejs.org/) installed and a Cloudflare account.

### 1. Install Dependencies
```bash
npm install
```

### 2. Login to Cloudflare
```bash
npx wrangler login
```

### 3. Deploy
```bash
npx wrangler deploy
```

Wrangler will upload the static assets from `./public` and deploy `worker.js` with the `SyncRoom` Durable Object binding. Your SyncPad instance is now live globally on the Cloudflare Edge network!

---

## 💻 Local Development

Run the local Cloudflare Workers development server:

```bash
npx wrangler dev
```

Open `http://localhost:8787` in your browser. You can open multiple tabs or windows to test real-time multi-device sync locally!

To run unit tests:
```bash
npm test
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + N` / `Cmd + N` | Create a new note |
| `Ctrl + S` / `Cmd + S` | Force save and sync |
| `Ctrl + P` / `Cmd + P` | Toggle Preview mode |
| `Ctrl + B` | Insert bold markdown (`**bold**`) |
| `Ctrl + I` | Insert italic markdown (`*italic*`) |
| `Escape` | Close sync room modal / close mobile menu |

---

## 🔒 Security & Privacy

- **Zero Trackers**: No third-party analytics, advertisements, or tracking scripts.
- **Private Room Codes**: Each room is isolated. Devices only receive updates for the room code they join.
- **Client-Side Sanitization**: Markdown parsing enforces strict HTML escaping and blocks dangerous URI schemes (like `javascript:`).
- **Offline Data Sovereignty**: All notes are stored locally in your browser's IndexedDB.

---

## 📄 License

MIT License &copy; 2026 Muamer Arifi
