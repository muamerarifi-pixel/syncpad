# SyncPad

Send files, links and notes between all your devices — phone, laptop, tablet — in one tap. No accounts, no passwords. Works offline and runs entirely on Cloudflare's free plan.

## What it does

- **Drops**: drag & drop files anywhere, paste (Ctrl+V), pick files, or type a message. It appears on every connected device instantly. Any file type, up to 200 MB each. Images and videos get previews; links get a title card.
- **Notes**: markdown notes that sync as you type. The first line is the title, `#tags` organise them, `- [ ]` makes checklists you can tick in Read mode, and you can drop files straight into a note.
- **Connect a device** in one step: scan the QR code with your phone camera, or type the 6-digit code (valid 10 minutes) on a computer.
- **Install it** on every device (PWA). On Android it shows up in the system **Share** menu, so you can share any file or link to your other devices.
- **Offline-first**: everything is saved on the device first and syncs when you're back online, including queued file uploads, which resume where they stopped.

## Where files are stored

Files are kept in the same Cloudflare Durable Object (SQLite) that already powers sync, split into 1 MiB pieces. No R2 bucket, KV namespace or other extra Cloudflare resource is needed.

- The Workers free plan includes **5 GB** of Durable Object storage per account (shared with any other apps on the account). SyncPad caps itself at **3 GB** so your other apps always have room.
- **Settings → Clean up old drops automatically** can remove drops after 1/7/30 days. Pinned drops and notes are never removed.

## Privacy & security

- Each set of devices shares a private **144-bit random key** (not guessable; v1's 3-digit room codes are gone and rejected by the server).
- Pairing codes are 6 digits, expire after 10 minutes and are rate-limited.
- Uploaded files are served with a sandbox CSP and `nosniff`, so an uploaded HTML/SVG file can never run scripts inside the app.
- No trackers, no third-party requests. Link previews are fetched server-side and only text (title, site, description) is kept.

## Sync design (for developers)

- `worker.js`: routes + `SyncRoom` Durable Object (one instance per space, plus one `__global__` instance for pairing codes and the storage cap).
- Every change gets a server-assigned sequence number; clients pull `seq > lastSeen`. Clock skew between devices doesn't matter.
- Writes carry the revision they were based on. If two devices edit the same note without seeing each other's change, the server keeps both (the second becomes a "conflict copy") instead of silently overwriting.
- WebSockets (with hibernation) give instant updates and presence; the same sync call works over plain HTTP if WebSockets are blocked.

## Develop

```bash
npm install
npx wrangler dev                 # http://localhost:8787
npm test                         # API tests (needs wrangler dev running)
npm run test:e2e                 # browser tests with two simulated devices (needs Playwright)
```

Pushing to `main` deploys automatically via Cloudflare Workers Builds.

## Upgrading from v1

Notes saved on a device by v1 are imported automatically the first time v2 opens there (images included). The old local database is left untouched as a backup.

MIT © 2026 Muamer Arifi
