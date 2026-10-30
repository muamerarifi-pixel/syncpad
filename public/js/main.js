// SyncPad v2 — app controller
import {
  $, $$, rid, esc, fmtBytes, clock, dayLabel, ago, shortDate, detectDeviceName, isTouch, isMobileLayout,
  isIOS, isStandalone, linkify, singleUrl, fileKind, kindIcon, extOf, noteTitle, noteSnippet, noteTags, debounce
} from './util.js';
import { Store, readV1Notes } from './store.js';
import { Sync } from './sync.js';
import { Files } from './files.js';
import { renderMarkdown, toggleTask } from './md.js';
import qrcode from '/vendor/qrcode.mjs';

const VERSION = '2.0.0';
const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;
const store = new Store();
let sync;
let files;
const el = {};
const ui = {
  tab: 'drops',
  noteId: null,
  newNote: null,
  mode: 'edit',
  query: '',
  tag: null,
  dirty: false,
  unseen: 0,
  known: new Set(),
  fresh: new Set(),
  expanded: new Set(),
  pendingDeletes: new Map(),
  stickBottom: true,
  busy: false,
  installPrompt: null
};
const cards = new Map(); // id -> {sig, node}

/* ═════════════════════════ boot ═════════════════════════ */

async function boot() {
  for (const n of $$('[id]')) el[n.id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = n;
  el.app = $('#app');

  await store.open();
  if (!store.get('device')) await store.set('device', rid(16));
  if (!store.get('deviceName')) await store.set('deviceName', detectDeviceName());

  const params = readParams();
  let joinOffer = null;
  if (!store.get('space')) {
    const k = params.join || params.s;
    await store.set('space', k && KEY_RE.test(k) ? k : rid(24));
    await store.set('seq', 0);
    if (k && KEY_RE.test(k)) ui.joinedOnFirstRun = true;
  } else if (params.join && KEY_RE.test(params.join) && params.join !== store.get('space')) {
    joinOffer = params.join;
  }
  cleanUrl();

  sync = new Sync(store);
  files = new Files(store, sync);
  ui.known = new Set(dropItems().map((i) => i.id));
  wire();
  updateManifest();
  await importV1();
  renderAll();
  sync.start();
  files.resumeAll();
  registerSW();
  if (ui.joinedOnFirstRun) toast('Connected — everything now syncs with your other device.');
  if (joinOffer) offerJoin(joinOffer);
  takeShared(params.shared);
}

function readParams() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { join: h.get('join') || q.get('join'), s: q.get('s'), shared: q.has('shared') };
}

function cleanUrl() {
  if (location.search || location.hash) history.replaceState(null, '', '/');
}

function updateManifest() {
  // lets iOS home-screen installs open already connected
  el.manifestLink.href = '/app.webmanifest?s=' + store.get('space');
}

const me = () => store.get('device');

/* ═════════════════════════ wiring ═════════════════════════ */

function wire() {
  store.addEventListener('change', (e) => onStoreChange(e.detail));
  sync.addEventListener('state', renderStatus);
  sync.addEventListener('busy', (e) => { ui.busy = e.detail; renderStatus(); });
  sync.addEventListener('synced', () => { renderStatus(); renderSaveState(); });
  sync.addEventListener('presence', () => { rememberDevices(); renderStatus(); if (el.dlgConnect.open) renderDevices(); });
  sync.addEventListener('info', () => { if (el.dlgSettings.open) renderStorage(); });
  sync.addEventListener('conflict', (e) => {
    const { from, to } = e.detail;
    if (ui.noteId === from) { ui.noteId = to; renderEditor(true); }
    toast('This note was also edited on another device — both versions were kept.');
  });
  sync.addEventListener('rejected', (e) => toast(e.detail.err === 'too_big' ? 'That note is too large to sync.' : 'Something could not be synced.'));
  files.addEventListener('progress', (e) => updateProgress(e.detail.id));
  files.addEventListener('error', (e) => toast(e.detail.message, { duration: 6000 }));
  files.addEventListener('full', () => toast('Cloud storage is full. Delete some old drops in Settings → storage.', { action: 'Settings', onAction: openSettings, duration: 8000 }));

  // tabs
  for (const b of $$('[data-tab]')) if (b.tagName === 'BUTTON') b.addEventListener('click', () => setTab(b.dataset.tab));

  // search
  el.search.addEventListener('input', () => { ui.query = el.search.value.trim(); renderLists(); });
  el.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { el.search.value = ''; ui.query = ''; renderLists(); el.search.blur(); }
  });
  el.search.addEventListener('blur', () => { if (!el.search.value) el.app.classList.remove('searching'); });
  el.btnSearch.addEventListener('click', () => { el.app.classList.add('searching'); el.search.focus(); });

  el.statusChip.addEventListener('click', openConnect);
  el.btnConnect.addEventListener('click', openConnect);
  el.btnSettings.addEventListener('click', openSettings);

  // composer
  el.composerInput.addEventListener('input', () => { autosize(); updateSend(); });
  el.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); sendText(); }
  });
  el.composer.addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
  el.btnAttach.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { sendFiles([...el.fileInput.files]); el.fileInput.value = ''; });
  el.noteFileInput.addEventListener('change', () => { attachToNote([...el.noteFileInput.files]); el.noteFileInput.value = ''; });

  // feed actions
  el.feedInner.addEventListener('click', onFeedClick);
  el.feed.addEventListener('scroll', () => {
    ui.atBottom = el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < 60;
  }, { passive: true });

  // notes
  el.noteList.addEventListener('click', (e) => {
    const b = e.target.closest('.note-item');
    if (b) openNote(b.dataset.id);
  });
  el.tagChips.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    ui.tag = ui.tag === c.dataset.tag ? null : c.dataset.tag;
    renderNotesList();
  });
  for (const b of [el.btnNewNote, el.fabNewNote]) b.addEventListener('click', newNote);
  el.editorPane.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'new-note') newNote();
    if (a.dataset.act === 'conflict-keep') resolveConflict(true);
    if (a.dataset.act === 'conflict-drop') resolveConflict(false);
  });
  el.editorText.addEventListener('input', () => { ui.dirty = true; renderSaveState(); saveNote(); renderFoot(); });
  el.editorText.addEventListener('blur', () => saveNote.flush());
  el.editorText.addEventListener('keydown', onEditorKey);
  for (const b of $$('.seg-btn[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  el.btnPin.addEventListener('click', togglePin);
  el.btnNoteMore.addEventListener('click', () => noteMenu(el.btnNoteMore));
  el.btnEditorBack.addEventListener('click', () => closeEditor());
  el.fmtBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]');
    if (b) format(b.dataset.fmt);
  });
  el.preview.addEventListener('click', onPreviewClick);

  // dialogs
  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) d.close();
      else if (e.target === d && d.classList.contains('sheet')) d.close(); // backdrop
    });
    d.addEventListener('close', () => closeLayer(d));
  }
  el.joinForm.addEventListener('submit', (e) => { e.preventDefault(); joinWithCode(); });
  el.joinCode.addEventListener('input', () => {
    const d = el.joinCode.value.replace(/\D/g, '').slice(0, 6);
    el.joinCode.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d;
    el.joinMsg.textContent = '';
    if (d.length === 6) joinWithCode();
  });
  el.btnCopyLink.addEventListener('click', async () => {
    await copyText(joinLink());
    toast('Link copied. Open it on your other device.');
  });
  el.btnShareLink.addEventListener('click', () => navigator.share({ title: 'SyncPad', text: 'Open to connect this device to my SyncPad', url: joinLink() }).catch(() => {}));
  el.setName.addEventListener('change', async () => {
    const v = el.setName.value.trim().slice(0, 40) || detectDeviceName();
    el.setName.value = v;
    await store.set('deviceName', v);
    if (sync.wsOpen) sync.ws.send(JSON.stringify({ t: 'hi', name: v }));
  });
  el.setTheme.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    try { localStorage.setItem('sp-theme', b.dataset.themeOpt); } catch {}
    applyTheme();
    renderThemeSeg();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  el.setAutodel.addEventListener('change', () => {
    const cur = store.items.get('settings');
    const item = cur || { id: 'settings', kind: 'settings', rev: 0, created: Date.now(), data: {} };
    item.data = { ...item.data, autodel: Number(el.setAutodel.value) };
    store.save(item).then(() => sync.schedule());
  });
  el.btnDisconnect.addEventListener('click', disconnect);
  el.btnInstall.addEventListener('click', install);
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installPrompt = e; });
  addEventListener('appinstalled', () => { ui.installPrompt = null; toast('SyncPad installed.'); });

  // viewer
  el.viewerDownload.addEventListener('click', () => ui.viewing && files.download(ui.viewing));
  el.viewerShare.addEventListener('click', () => ui.viewing && files.share(ui.viewing).catch(() => {}));
  el.dlgViewer.addEventListener('close', () => { el.viewerBody.innerHTML = ''; ui.viewing = null; });

  // drag & drop anywhere
  let depth = 0;
  const dragKind = (e) => {
    const t = e.dataTransfer ? [...e.dataTransfer.types] : [];
    if (t.includes('Files')) return 'files';
    if (t.includes('text/uri-list') || t.includes('text/plain')) return 'text';
    return null;
  };
  addEventListener('dragenter', (e) => {
    const k = dragKind(e);
    if (!k || (k === 'text' && e.target.closest && e.target.closest('textarea, input'))) return;
    e.preventDefault();
    depth++;
    el.dropOverlay.hidden = false;
  });
  addEventListener('dragover', (e) => {
    const k = dragKind(e);
    if (!k) return;
    if (k === 'text' && e.target.closest && e.target.closest('textarea, input')) { el.dropOverlay.hidden = true; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.dropOverlay.hidden = false;
    el.dropOverlayTitle.textContent = overNoteEditor(e.target) ? 'Drop to attach to this note' : 'Drop to send to all your devices';
  });
  addEventListener('dragleave', (e) => {
    if (!dragKind(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0 || !e.relatedTarget) el.dropOverlay.hidden = true;
  });
  addEventListener('drop', (e) => {
    const k = dragKind(e);
    depth = 0;
    el.dropOverlay.hidden = true;
    if (!k) return;
    if (k === 'text' && e.target.closest && e.target.closest('textarea, input')) return;
    e.preventDefault();
    const fl = [...e.dataTransfer.files];
    if (fl.length) {
      if (overNoteEditor(e.target)) attachToNote(fl);
      else sendFiles(fl);
      return;
    }
    const text = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || e.dataTransfer.getData('text/plain');
    if (text && text.trim()) { setTab('drops'); sendClip(text.trim()); }
  });

  // paste anywhere
  document.addEventListener('paste', (e) => {
    const fl = [...((e.clipboardData && e.clipboardData.files) || [])];
    const t = e.target;
    const editable = t && t.closest && t.closest('textarea, input, [contenteditable]');
    if (fl.length) {
      if (t === el.editorText) { e.preventDefault(); attachToNote(fl); }
      else if (!editable || t === el.composerInput) { e.preventDefault(); sendFiles(fl); }
      return;
    }
    if (!editable && ui.tab === 'drops') {
      const text = e.clipboardData.getData('text');
      if (text) {
        e.preventDefault();
        el.composerInput.value += text;
        autosize();
        updateSend();
        el.composerInput.focus();
      }
    }
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      el.app.classList.add('searching');
      el.search.focus();
      el.search.select();
    } else if (e.key === 'Escape' && !el.menu.hidden) {
      closeMenu();
    }
  });

  // history: Android back closes sheets / the editor instead of leaving the app
  addEventListener('popstate', () => {
    if (ui.skipPop) { ui.skipPop = false; return; }
    const top = layers.pop();
    if (!top) return;
    ui.fromPop = true;
    try { top.close(); } finally { ui.fromPop = false; }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveNote.flush();
      commitDeletes();
    } else {
      clearUnseen();
    }
  });
  addEventListener('pagehide', () => { saveNote.flush(); commitDeletes(); });
  addEventListener('online', renderStatus);
  // a join link opened while SyncPad is already open in this tab
  addEventListener('hashchange', () => {
    const k = readParams().join;
    cleanUrl();
    if (k && KEY_RE.test(k) && k !== store.get('space')) offerJoin(k);
  });
  addEventListener('offline', renderStatus);
  addEventListener('resize', debounce(() => { if (!isMobileLayout()) el.app.classList.remove('editing'); }, 150));
  setInterval(() => { if (document.visibilityState === 'visible') renderDrops(); }, 60000);
}

/* ═════════════════════════ layers (dialogs, editor) + history ═════════════════════════ */

const layers = [];
function pushLayer(layer) {
  layers.push(layer);
  history.pushState({ layer: layers.length }, '');
}
function closeLayer(key) {
  const i = layers.findIndex((l) => l.key === key);
  if (i === -1) return;
  layers.splice(i, 1);
  if (!ui.fromPop) { ui.skipPop = true; history.back(); }
}
function openDialog(d) {
  if (d.open) return;
  d.showModal();
  pushLayer({ key: d, close: () => d.close() });
}

/* ═════════════════════════ rendering ═════════════════════════ */

let raf = 0;
const pendingRender = { drops: false, notes: false };
function scheduleRender(drops = true, notes = true) {
  pendingRender.drops ||= drops;
  pendingRender.notes ||= notes;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (pendingRender.drops) renderDrops();
    if (pendingRender.notes) renderNotesList();
    pendingRender.drops = pendingRender.notes = false;
    renderStatus();
  });
}

function renderAll() {
  renderTabs();
  renderLists();
  renderEditor(true);
  renderStatus();
}
function renderLists() {
  renderDrops();
  renderNotesList();
}

function onStoreChange({ ids, remote }) {
  if (remote) {
    for (const id of ids) {
      const it = store.items.get(id);
      if (!it || !isDrop(it) || ui.known.has(id)) continue;
      ui.known.add(id);
      if (it.device !== me() && Date.now() - it.created < 10 * 60 * 1000) {
        ui.fresh.add(id);
        setTimeout(() => { ui.fresh.delete(id); const c = cards.get(id); if (c) c.node.classList.remove('fresh'); }, 4000);
        if (ui.tab !== 'drops' || document.hidden) { ui.unseen++; renderBadge(); }
        if (ui.tab === 'drops' && ui.atBottom !== false) ui.stickBottom = true;
      }
    }
    if (ui.noteId && ids.includes(ui.noteId)) renderEditor(false);
  } else {
    for (const id of ids) ui.known.add(id);
  }
  const kinds = ids.map((id) => store.items.get(id));
  const drops = kinds.some((it) => !it || isDrop(it));
  const notes = kinds.some((it) => !it || it.kind === 'note');
  scheduleRender(drops, notes);
}

function setTab(tab) {
  ui.tab = tab;
  el.app.dataset.tab = tab;
  renderTabs();
  if (tab === 'drops') {
    clearUnseen();
    ui.stickBottom = true;
    renderDrops();
  } else {
    renderNotesList();
    if (!isMobileLayout() && !ui.noteId) {
      const first = notesSorted()[0];
      if (first) openNote(first.id, { focus: false });
    }
  }
}
function renderTabs() {
  for (const b of $$('[data-tab]')) if (b.tagName === 'BUTTON') b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
}
function clearUnseen() {
  if (ui.tab === 'drops' && !document.hidden) { ui.unseen = 0; renderBadge(); }
}
function renderBadge() {
  for (const b of $$('.badge')) { b.hidden = !ui.unseen; b.textContent = ui.unseen > 9 ? '9+' : ui.unseen; }
  document.title = ui.unseen ? `(${ui.unseen}) SyncPad` : 'SyncPad';
  try { ui.unseen ? navigator.setAppBadge && navigator.setAppBadge(ui.unseen) : navigator.clearAppBadge && navigator.clearAppBadge(); } catch {}
}

function renderStatus() {
  if (!sync) return;
  const pending = store.outbox.size + files.queue.length;
  let state;
  let text;
  if (!navigator.onLine || sync.state === 'offline') {
    state = 'offline';
    text = pending ? 'Offline · saved here' : 'Offline';
  } else if (sync.state === 'connecting' && !sync.lastOk) {
    state = 'syncing';
    text = 'Connecting…';
  } else if (pending || ui.busy) {
    state = 'syncing';
    text = 'Syncing…';
  } else {
    state = 'online';
    const others = Math.max(0, sync.onlineCount - 1);
    text = others ? `${others + 1} devices online` : 'Synced';
  }
  el.statusChip.dataset.state = state;
  el.statusChip.querySelector('.status-text').textContent = text;
  el.statusChip.title = state === 'offline' ? 'You are offline. Everything is saved on this device and will sync when you are back online.' : 'Devices & sync';
}

/* ───────── drops ───────── */

const isDrop = (i) => i.kind === 'clip' || (i.kind === 'file' && !i.data.parent);
function dropItems() {
  return store.list().filter((i) => isDrop(i) && !ui.pendingDeletes.has(i.id)).sort((a, b) => a.created - b.created);
}

function renderDrops() {
  const q = ui.query.toLowerCase();
  let list = dropItems();
  if (q) {
    list = list.filter((i) => [i.data.text, i.data.name, i.data.link && i.data.link.title].some((s) => s && s.toLowerCase().includes(q)));
  }
  const feed = el.feed;
  const wasBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  if (!list.length) {
    cards.clear();
    el.feedInner.innerHTML = q ? `<div class="empty"><p>No drops match “${esc(ui.query)}”.</p></div>` : emptyDrops();
    return;
  }
  const nodes = [];
  let lastDay = '';
  const seen = new Set();
  for (const it of list) {
    const d = dayLabel(it.created);
    if (d !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day';
      sep.textContent = d;
      nodes.push(sep);
      lastDay = d;
    }
    nodes.push(cardNode(it));
    seen.add(it.id);
  }
  for (const id of cards.keys()) if (!seen.has(id)) cards.delete(id);
  el.feedInner.replaceChildren(...nodes);
  if (ui.stickBottom || wasBottom) {
    feed.scrollTop = feed.scrollHeight;
    ui.stickBottom = false;
  }
}

function emptyDrops() {
  const alone = (sync && sync.devices.length <= 1) !== false;
  return `<div class="empty">
    <div class="empty-art"><svg class="ic ic-xl"><use href="#i-upload"/></svg></div>
    <h3>Send anything to your devices</h3>
    <p>${isTouch() ? 'Pick files or type a message below.' : 'Drop files anywhere, paste with Ctrl+V, or type a message below.'} It appears instantly on every connected device.</p>
    <div class="row">
      <button class="btn btn-primary" data-act="pick"><svg class="ic"><use href="#i-clip"/></svg><span>Choose files</span></button>
      ${alone ? `<button class="btn btn-soft" data-act="connect"><svg class="ic"><use href="#i-qr"/></svg><span>Connect a device</span></button>` : ''}
    </div>
  </div>`;
}

function deviceLabel(id) {
  if (id === me()) return 'This device';
  if (id === 'server') return 'Auto clean-up';
  const names = store.get('names', {});
  return names[id] || 'Another device';
}
function rememberDevices() {
  const names = { ...store.get('names', {}) };
  let changed = false;
  for (const d of sync.devices) if (d.id && names[d.id] !== d.name) { names[d.id] = d.name; changed = true; }
  if (changed) { ui.namesVer = (ui.namesVer || 0) + 1; store.set('names', names); scheduleRender(true, false); }
}

function cardNode(it) {
  const prog = files.progress.get(it.id);
  const sig = [ui.namesVer || 0, it.rev, it.updated, it.data.keep ? 1 : 0, prog ? prog.state + (prog.err || '') : '', ui.expanded.has(it.id) ? 1 : 0, Math.floor((Date.now() - it.created) / 60000) < 1 ? 'n' : 'o'].join('|');
  const c = cards.get(it.id);
  if (c && c.sig === sig) {
    c.node.classList.toggle('fresh', ui.fresh.has(it.id));
    return c.node;
  }
  const t = document.createElement('template');
  t.innerHTML = it.kind === 'clip' ? clipHTML(it) : fileHTML(it, prog);
  const node = t.content.firstElementChild;
  node.classList.toggle('fresh', ui.fresh.has(it.id));
  cards.set(it.id, { sig, node });
  return node;
}

function metaHTML(it, extra = '') {
  return `<div class="drop-meta">${extra}${extra ? '<span class="sep"></span>' : ''}<span>${esc(deviceLabel(it.device))}</span><span class="sep"></span><span>${clock(it.created)}</span>${it.data.keep ? '<span class="pin-flag" title="Pinned — never cleaned up"><svg class="ic"><use href="#i-pin"/></svg></span>' : ''}</div>`;
}

function clipHTML(it) {
  const text = it.data.text || '';
  const url = singleUrl(text);
  const long = text.length > 420 || text.split('\n').length > 8;
  const expanded = ui.expanded.has(it.id);
  const link = it.data.link;
  return `<article class="drop clip" data-id="${it.id}">
    <div class="drop-icon"><svg class="ic"><use href="#i-${url ? 'link' : 'note'}"/></svg></div>
    <div class="drop-main">
      <div class="drop-text${long && !expanded ? ' clamped' : ''}">${linkify(text)}</div>
      ${long ? `<button class="more-link" data-act="expand">${expanded ? 'Show less' : 'Show more'}</button>` : ''}
      ${url && link && link.title ? `<a class="link-card" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><b>${esc(link.title)}</b><span>${esc(link.site || '')}${link.desc ? ' · ' + esc(link.desc) : ''}</span></a>` : ''}
      ${metaHTML(it)}
    </div>
    <div class="drop-actions">
      ${url
        ? `<a class="btn btn-soft act-main" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><svg class="ic"><use href="#i-link"/></svg><span>Open</span></a>`
        : `<button class="btn btn-soft act-main" data-act="copy"><svg class="ic"><use href="#i-copy"/></svg><span>Copy</span></button>`}
      <button class="icon-btn" data-act="menu" aria-label="More actions"><svg class="ic"><use href="#i-more"/></svg></button>
    </div>
  </article>`;
}

function fileHTML(it, prog) {
  const d = it.data;
  const kind = fileKind(d.type, d.name);
  let status = esc(fmtBytes(d.size));
  let bar = '';
  if (prog) {
    if (prog.state === 'err') status = `<span class="err">${esc(prog.err || 'Upload failed')}</span>`;
    else if (prog.state === 'wait') status = 'Waiting for connection…';
    else status = `Sending <span class="pct">${pct(prog)}%</span> · ${esc(fmtBytes(d.size))}`;
    if (prog.state !== 'err') bar = `<div class="progress"><span style="width:${pct(prog)}%"></span></div>`;
  }
  const saveLabel = isIOS() && (kind === 'image' || kind === 'video') && files.canShare();
  const primary = prog
    ? ''
    : saveLabel
      ? `<button class="btn btn-soft act-main" data-act="share"><svg class="ic"><use href="#i-download"/></svg><span>Save</span></button>`
      : `<button class="btn btn-soft act-main" data-act="download"><svg class="ic"><use href="#i-download"/></svg><span class="hide-xs">Download</span></button>`;
  const actions = `<div class="drop-actions">${primary}<button class="icon-btn" data-act="menu" aria-label="More actions"><svg class="ic"><use href="#i-more"/></svg></button></div>`;
  const main = `<div class="drop-main"><div class="drop-title" title="${esc(d.name)}">${esc(d.name)}</div>${metaHTML(it, status)}${bar}</div>`;
  if (d.thumb) {
    const ratio = d.w && d.h ? Math.max(0.45, Math.min(1.8, d.w / d.h)) : 1.5;
    return `<article class="drop media" data-id="${it.id}">
      <div class="thumb-wrap"><button class="thumb" data-act="open" aria-label="Open ${esc(d.name)}"><img src="${esc(d.thumb)}" alt="" style="aspect-ratio:${ratio.toFixed(3)}" decoding="async"></button>
      ${kind === 'video' ? '<span class="play-badge"><svg class="ic" viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg></span>' : ''}</div>
      <div class="media-row">${main}${actions}</div>
    </article>`;
  }
  const ext = extOf(d.name);
  return `<article class="drop" data-id="${it.id}">
    <button class="drop-icon" data-k="${kind}" data-act="open" aria-label="Open ${esc(d.name)}">
      ${ext && ext.length <= 4 && kind !== 'image' && kind !== 'video' && kind !== 'audio' ? `<span class="ext">${esc(ext)}</span>` : `<svg class="ic"><use href="#i-${kindIcon(kind)}"/></svg>`}
    </button>
    ${main}${actions}
  </article>`;
}
const pct = (p) => (p.total ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0);

function updateProgress(id) {
  const c = cards.get(id);
  const p = files.progress.get(id);
  if (!c || !p || p.state !== 'up') { scheduleRender(); renderStatus(); return; }
  const bar = c.node.querySelector('.progress > span');
  const pc = c.node.querySelector('.pct');
  if (!bar || !pc) { scheduleRender(); return; }
  bar.style.width = pct(p) + '%';
  pc.textContent = pct(p);
}

async function onFeedClick(e) {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const card = a.closest('[data-id]');
  const it = card && store.items.get(card.dataset.id);
  const act = a.dataset.act;
  if (act === 'pick') return el.fileInput.click();
  if (act === 'connect') return openConnect();
  if (!it) return;
  if (act === 'copy') {
    await copyText(it.data.text || '');
    flashButton(a, 'Copied');
  } else if (act === 'expand') {
    ui.expanded.has(it.id) ? ui.expanded.delete(it.id) : ui.expanded.add(it.id);
    renderDrops();
  } else if (act === 'open') {
    openFile(it);
  } else if (act === 'download') {
    files.download(it);
  } else if (act === 'share') {
    files.share(it).catch(() => files.download(it));
  } else if (act === 'menu') {
    dropMenu(a, it);
  }
}

function dropMenu(anchor, it) {
  const m = [];
  if (it.kind === 'clip') {
    const url = singleUrl(it.data.text || '');
    m.push({ icon: 'copy', label: 'Copy text', run: async () => { await copyText(it.data.text); toast('Copied'); } });
    if (url) m.push({ icon: 'link', label: 'Open link', run: () => window.open(url, '_blank', 'noopener') });
    if (navigator.share && isTouch()) m.push({ icon: 'share', label: 'Share…', run: () => navigator.share(url ? { url } : { text: it.data.text }).catch(() => {}) });
    m.push({ icon: 'note', label: 'Save as note', run: () => saveClipAsNote(it) });
  } else {
    const p = files.progress.get(it.id);
    const kind = fileKind(it.data.type, it.data.name);
    if (p && p.state === 'err') m.push({ icon: 'upload', label: 'Try again', run: () => files.requeue(it.id) });
    m.push({ icon: 'eye', label: 'Open', run: () => openFile(it) });
    m.push({ icon: 'download', label: 'Download', run: () => files.download(it) });
    if (files.canShare()) {
      files.prefetch(it);
      m.push({ icon: 'share', label: 'Share…', run: () => files.share(it).catch(() => toast('Could not open the share sheet.')) });
    }
    if (kind === 'image' && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      m.push({ icon: 'copy', label: 'Copy image', run: () => files.copyImage(it).then(() => toast('Image copied')).catch(() => toast('Copy is not supported for this image.')) });
    }
  }
  m.push({ icon: 'pin', label: it.data.keep ? 'Unpin' : 'Pin (never auto-delete)', run: () => { it.data = { ...it.data, keep: !it.data.keep }; store.save(it).then(() => sync.schedule()); } });
  m.push({ icon: 'trash', label: 'Delete everywhere', danger: true, run: () => deleteWithUndo(it, it.kind === 'clip' ? 'Message' : 'File') });
  openMenu(anchor, m);
}

/* ───────── sending ───────── */

function autosize() {
  const t = el.composerInput;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}
function updateSend() { el.btnSend.disabled = !el.composerInput.value.trim(); }

async function sendText() {
  const text = el.composerInput.value.trim();
  if (!text) return;
  el.composerInput.value = '';
  autosize();
  updateSend();
  if (text.length > 50000) {
    await createNote(text);
    toast('Long text saved as a note instead.', { action: 'Open', onAction: () => { setTab('notes'); } });
    return;
  }
  sendClip(text);
}

async function sendClip(text) {
  const now = Date.now();
  const item = { id: rid(16), kind: 'clip', rev: 0, created: now, updated: now, device: me(), data: { text } };
  ui.stickBottom = true;
  await store.save(item);
  sync.schedule();
  const url = singleUrl(text);
  if (url && navigator.onLine) linkPreview(item.id, url);
}

async function linkPreview(id, url) {
  try {
    const r = await fetch(`/api/link?s=${store.get('space')}&url=${encodeURIComponent(url)}`);
    const j = await r.json();
    const cur = store.items.get(id);
    if (!cur || !j || !(j.title || j.desc)) return;
    cur.data = { ...cur.data, link: { title: j.title, site: j.site, desc: j.desc } };
    await store.save(cur);
    sync.schedule();
  } catch {}
}

async function sendFiles(list) {
  if (!list.length) return;
  setTab('drops');
  ui.stickBottom = true;
  const items = await files.add(list);
  if (items.length > 1) toast(`Sending ${items.length} files…`);
}

/* ───────── notes ───────── */

function notesSorted() {
  return store
    .list('note')
    .filter((n) => !ui.pendingDeletes.has(n.id))
    .sort((a, b) => (b.data.pinned ? 1 : 0) - (a.data.pinned ? 1 : 0) || b.updated - a.updated);
}

function renderNotesList() {
  const all = notesSorted();
  const tags = new Map();
  for (const n of all) for (const t of noteTags(n.data.body)) tags.set(t, (tags.get(t) || 0) + 1);
  if (ui.tag && !tags.has(ui.tag)) ui.tag = null;
  el.tagChips.hidden = tags.size === 0;
  el.tagChips.innerHTML = [...tags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => `<button class="chip" data-tag="${esc(t)}" aria-pressed="${ui.tag === t}">#${esc(t)}</button>`)
    .join('');
  const q = ui.query.toLowerCase();
  const list = all.filter((n) => (!ui.tag || noteTags(n.data.body).includes(ui.tag)) && (!q || (n.data.body || '').toLowerCase().includes(q)));
  if (!list.length) {
    el.noteList.innerHTML = `<div class="list-empty">${q || ui.tag ? 'No notes match.' : 'No notes yet.<br>Notes sync to all your devices as you type.'}</div>`;
    return;
  }
  el.noteList.innerHTML = list
    .map((n) => `<button class="note-item" role="listitem" data-id="${n.id}" aria-current="${n.id === ui.noteId}">
      <div class="t">${n.data.pinned ? '<svg class="ic"><use href="#i-pin"/></svg>' : ''}<span>${esc(noteTitle(n.data.body))}</span></div>
      <div class="s">${esc(noteSnippet(n.data.body)) || '&nbsp;'}</div>
      <div class="d">${esc(shortDate(n.updated))}${n.data.conflictOf ? ' · <span class="warn">Conflict copy</span>' : ''}</div>
    </button>`)
    .join('');
}

function openNote(id, { focus = true } = {}) {
  if (ui.noteId && ui.noteId !== id) saveNote.flush();
  ui.noteId = id;
  if (isMobileLayout() && !el.app.classList.contains('editing')) {
    el.app.classList.add('editing');
    pushLayer({ key: 'editor', close: () => closeEditor(true) });
  }
  renderEditor(true);
  renderNotesList();
  if (focus && ui.mode === 'edit' && !isTouch()) el.editorText.focus();
}

function newNote() {
  if (ui.tab !== 'notes') setTab('notes');
  const now = Date.now();
  ui.newNote = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { body: '', pinned: false } };
  setMode('edit', false);
  openNote(ui.newNote.id, { focus: false });
  el.editorText.focus();
}

async function createNote(body) {
  const now = Date.now();
  const n = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { body, pinned: false } };
  await store.save(n);
  sync.schedule();
  return n;
}

async function saveClipAsNote(it) {
  const n = await createNote(it.data.text || '');
  setTab('notes');
  openNote(n.id);
  toast('Saved as a note');
}

function openNoteItem() {
  return store.items.get(ui.noteId) || (ui.newNote && ui.newNote.id === ui.noteId ? ui.newNote : null);
}

function closeEditor(fromLayer = false) {
  saveNote.flush();
  const n = openNoteItem();
  if (n && store.items.has(n.id) && !(n.data.body || '').trim()) {
    store.remove(n).then(() => sync.schedule()); // leaving an empty note removes it
  }
  if (isMobileLayout()) {
    el.app.classList.remove('editing');
    if (!fromLayer) closeLayer('editor');
    ui.noteId = null;
  }
  ui.newNote = null;
  renderNotesList();
}

function renderEditor(force) {
  const n = openNoteItem();
  if (!n) {
    el.editor.hidden = true;
    el.editorEmpty.hidden = false;
    return;
  }
  el.editor.hidden = false;
  el.editorEmpty.hidden = true;
  const body = n.data.body || '';
  const ta = el.editorText;
  if (force) {
    ta.value = body;
    ta.scrollTop = 0;
    ui.dirty = false;
  } else if (ta.value !== body && !ui.dirty && !store.outbox.has(n.id)) {
    // remote edit arrived while open: keep the cursor roughly in place
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    ta.value = body;
    try { ta.setSelectionRange(Math.min(s, body.length), Math.min(e, body.length)); } catch {}
  }
  el.btnPin.setAttribute('aria-pressed', String(!!n.data.pinned));
  el.btnPin.setAttribute('aria-label', n.data.pinned ? 'Unpin note' : 'Pin note');
  el.conflictBar.hidden = !n.data.conflictOf;
  applyMode();
  renderFoot();
  renderSaveState();
}

function setMode(mode, render = true) {
  ui.mode = mode;
  if (mode === 'read') saveNote.flush();
  if (render) applyMode();
}
function applyMode() {
  for (const b of $$('.seg-btn[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === ui.mode));
  const read = ui.mode === 'read';
  el.editorText.hidden = read;
  el.fmtBar.hidden = read;
  el.preview.hidden = !read;
  if (read) renderPreview();
}
function renderPreview() {
  const n = openNoteItem();
  el.preview.innerHTML = n && (n.data.body || '').trim()
    ? renderMarkdown(n.data.body, (id) => files.src(id))
    : '<p class="muted">Nothing here yet — switch to Write.</p>';
  for (const pre of $$('pre', el.preview)) {
    const b = document.createElement('button');
    b.className = 'copy-code';
    b.textContent = 'Copy';
    b.dataset.copy = '1';
    pre.appendChild(b);
  }
}
function renderFoot() {
  const t = el.editorText.value;
  const words = (t.match(/\S+/g) || []).length;
  el.editorFoot.textContent = `${words} word${words === 1 ? '' : 's'} · ${Math.max(1, Math.round(words / 220))} min read`;
}
function renderSaveState() {
  const n = openNoteItem();
  if (!n) return;
  let s = '';
  if (ui.dirty) s = 'Saving…';
  else if (!store.items.has(n.id)) s = '';
  else if (store.outbox.has(n.id)) s = navigator.onLine ? 'Syncing…' : 'Saved on this device';
  else s = 'Saved';
  el.saveState.textContent = s;
}

const saveNote = debounce(async () => {
  const n = openNoteItem();
  if (!n) { ui.dirty = false; return; }
  const body = el.editorText.value;
  ui.dirty = false;
  const exists = store.items.has(n.id);
  if (exists && body === (n.data.body || '')) { renderSaveState(); return; }
  if (!exists && !body.trim()) { renderSaveState(); return; }
  n.data = { ...n.data, body };
  await store.save(n);
  if (ui.newNote && ui.newNote.id === n.id) ui.newNote = null;
  sync.schedule();
  renderSaveState();
}, 450);

function togglePin() {
  const n = openNoteItem();
  if (!n) return;
  saveNote.flush();
  n.data = { ...n.data, pinned: !n.data.pinned, body: el.editorText.value };
  if (!store.items.has(n.id) && !n.data.body.trim()) { renderEditor(false); return; }
  store.save(n).then(() => { sync.schedule(); renderEditor(false); });
}

function resolveConflict(keep) {
  const n = openNoteItem();
  if (!n) return;
  if (keep) {
    const { conflictOf, ...rest } = n.data;
    n.data = rest;
    store.save(n).then(() => { sync.schedule(); renderEditor(false); });
  } else {
    deleteWithUndo(n, 'Copy');
  }
}

function noteMenu(anchor) {
  const n = openNoteItem();
  if (!n) return;
  const body = () => el.editorText.value;
  const m = [
    { icon: 'copy', label: 'Copy text', run: async () => { await copyText(body()); toast('Copied'); } },
    { icon: 'drops', label: 'Send as a drop', run: () => { sendClip(body()); toast('Sent to Drops'); } },
    { icon: 'download', label: 'Download .md', run: () => downloadText(body(), noteTitle(body()).replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) + '.md') }
  ];
  if (navigator.share && isTouch()) m.push({ icon: 'share', label: 'Share…', run: () => navigator.share({ text: body() }).catch(() => {}) });
  if (store.items.has(n.id)) m.push({ icon: 'trash', label: 'Delete note', danger: true, run: () => deleteWithUndo(n, 'Note') });
  openMenu(anchor, m);
}

function onEditorKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); format('bold'); }
  else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); format('italic'); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNote.flush(); }
  else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) continueList(e);
}

/** Pressing Enter in a list continues it ("- ", "- [ ] ", "1. "); Enter on an empty item ends it */
function continueList(e) {
  const ta = el.editorText;
  if (ta.selectionStart !== ta.selectionEnd) return;
  const pos = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', pos - 1) + 1;
  const line = ta.value.slice(lineStart, pos);
  const m = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d+)\.\s+)(.*)$/.exec(line);
  if (!m) return;
  e.preventDefault();
  if (!m[4].trim()) {
    ta.setSelectionRange(lineStart, pos);
    insertText('');
    return;
  }
  let marker = m[2];
  if (m[3]) marker = `${Number(m[3]) + 1}. `;
  else if (/\[[xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, '[ ]');
  insertText('\n' + m[1] + marker);
}

function insertText(text) {
  const ta = el.editorText;
  ta.focus();
  if (!document.execCommand || !document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input'));
  }
}

function format(kind) {
  const ta = el.editorText;
  if (kind === 'attach') return el.noteFileInput.click();
  ta.focus();
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = ta.value.slice(s, e);
  const wrap = (a, b = a, ph = 'text') => {
    insertText(a + (sel || ph) + b);
    if (!sel) ta.setSelectionRange(s + a.length, s + a.length + ph.length);
  };
  const prefixLines = (p) => {
    const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
    let le = ta.value.indexOf('\n', e);
    if (le === -1) le = ta.value.length;
    const block = ta.value.slice(ls, le);
    const lines = block.split('\n');
    const all = lines.every((l) => l.startsWith(p));
    const out = lines.map((l) => (all ? l.slice(p.length) : p + l)).join('\n');
    ta.setSelectionRange(ls, le);
    insertText(out);
  };
  if (kind === 'bold') wrap('**');
  else if (kind === 'italic') wrap('_');
  else if (kind === 'code') sel.includes('\n') ? wrap('```\n', '\n```') : wrap('`', '`', 'code');
  else if (kind === 'link') {
    insertText(`[${sel || 'link text'}](https://)`);
    const end = ta.selectionStart - 1;
    ta.setSelectionRange(end - 8, end);
  } else if (kind === 'heading') prefixLines('## ');
  else if (kind === 'list') prefixLines('- ');
  else if (kind === 'task') prefixLines('- [ ] ');
}

async function attachToNote(list) {
  if (!list.length) return;
  let n = openNoteItem();
  if (!n) { newNote(); n = openNoteItem(); }
  setMode('edit');
  const items = await files.add(list, { parent: n.id });
  const md = items
    .map((it) => (fileKind(it.data.type, it.data.name) === 'image' ? `![${it.data.name}](file:${it.id})` : `[📎 ${it.data.name}](file:${it.id})`))
    .join('\n');
  if (md) insertText((el.editorText.selectionStart > 0 ? '\n' : '') + md + '\n');
}

function onPreviewClick(e) {
  const n = openNoteItem();
  if (!n) return;
  if (e.target.matches('input[type="checkbox"]')) {
    const boxes = $$('input[type="checkbox"]', el.preview);
    const idx = boxes.indexOf(e.target);
    const body = toggleTask(n.data.body || '', idx);
    el.editorText.value = body;
    n.data = { ...n.data, body };
    store.save(n).then(() => sync.schedule());
    return;
  }
  if (e.target.dataset.copy) {
    const code = e.target.parentElement.querySelector('code');
    copyText(code ? code.textContent : '').then(() => flashButton(e.target, 'Copied'));
    return;
  }
  const a = e.target.closest('a[href*="/file/"], img[src*="/file/"], img[src^="blob:"]');
  if (a) {
    const ref = a.getAttribute('href') || a.getAttribute('src');
    let id = (/\/file\/([A-Za-z0-9_-]+)/.exec(ref) || [])[1];
    if (!id) for (const [k, u] of files.urls) if (u === ref) id = k;
    const it = id && store.items.get(id);
    if (it) { e.preventDefault(); openFile(it); }
  }
}

/* ───────── delete with undo ───────── */

function deleteWithUndo(item, label) {
  if (ui.pendingDeletes.has(item.id)) return;
  ui.pendingDeletes.set(item.id, setTimeout(() => commitDelete(item.id), 5000));
  if (ui.noteId === item.id) {
    if (isMobileLayout()) closeEditor();
    ui.noteId = null;
    renderEditor(true);
  }
  if (!store.items.has(item.id)) { ui.newNote = null; }
  renderLists();
  toast(`${label} deleted`, {
    action: 'Undo',
    duration: 5000,
    onAction: () => {
      clearTimeout(ui.pendingDeletes.get(item.id));
      ui.pendingDeletes.delete(item.id);
      renderLists();
    }
  });
}
async function commitDelete(id) {
  ui.pendingDeletes.delete(id);
  const it = store.items.get(id);
  if (!it) return;
  await store.remove(it);
  files.forget(id);
  sync.schedule();
}
function commitDeletes() {
  for (const [id, t] of ui.pendingDeletes) { clearTimeout(t); commitDelete(id); }
}

/* ═════════════════════════ viewer ═════════════════════════ */

async function openFile(it) {
  const d = it.data;
  const kind = fileKind(d.type, d.name);
  const src = files.src(it.id);
  const textual = (kind === 'doc' || kind === 'code') && d.size <= 1024 * 1024 &&
    (/^text\/|json|xml|javascript/.test(d.type || '') || /^(txt|md|csv|tsv|json|js|mjs|ts|css|html?|py|xml|ya?ml|sh|log|ini|sql|dart|kt|java|c|cpp|h|go|rs|php|rb)$/.test(extOf(d.name)));
  if (kind === 'pdf' && (isTouch() || isMobileLayout())) { window.open(files.mem.has(it.id) ? src : files.url(it.id), '_blank', 'noopener'); return; }
  if (!['image', 'video', 'audio', 'pdf'].includes(kind) && !textual) { files.download(it); return; }
  ui.viewing = it;
  el.viewerTitle.textContent = d.name;
  el.viewerShare.hidden = !files.canShare();
  if (files.canShare()) files.prefetch(it);
  let html = '';
  if (kind === 'image') html = `<img src="${esc(src)}" alt="${esc(d.name)}">`;
  else if (kind === 'video') html = `<video src="${esc(src)}" controls autoplay playsinline></video>`;
  else if (kind === 'audio') html = `<audio src="${esc(src)}" controls autoplay></audio>`;
  else if (kind === 'pdf') html = `<iframe src="${esc(src)}" title="${esc(d.name)}"></iframe>`;
  else html = '<pre>Loading…</pre>';
  el.viewerBody.innerHTML = html;
  openDialog(el.dlgViewer);
  if (textual) {
    try {
      const b = await files.blobOf(it);
      const pre = el.viewerBody.querySelector('pre');
      if (pre) pre.textContent = await b.text();
    } catch {
      el.viewerBody.innerHTML = '<pre>Could not load this file.</pre>';
    }
  }
}

/* ═════════════════════════ connect devices ═════════════════════════ */

const joinLink = () => `${location.origin}/#join=${store.get('space')}`;

async function openConnect() {
  const qr = qrcode(0, 'M');
  qr.addData(joinLink());
  qr.make();
  el.pairQr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  el.btnShareLink.hidden = !(navigator.share && isTouch());
  el.joinCode.value = '';
  el.joinMsg.textContent = '';
  el.joinMsg.className = 'form-msg';
  renderDevices();
  renderInstallHint();
  openDialog(el.dlgConnect);
  loadPairCode();
}

async function loadPairCode() {
  clearInterval(ui.pairTimer);
  if (!navigator.onLine) {
    el.pairCode.textContent = '— — —';
    el.pairExpiry.textContent = 'Go online to get a code. The QR code and link work any time.';
    return;
  }
  el.pairCode.textContent = '· · ·';
  el.pairExpiry.textContent = '';
  try {
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ space: store.get('space') }) });
    const j = await r.json();
    if (!j.code) throw new Error();
    el.pairCode.textContent = j.code.slice(0, 3) + ' ' + j.code.slice(3);
    const tick = () => {
      const left = j.expires - Date.now();
      if (left <= 0) { clearInterval(ui.pairTimer); if (el.dlgConnect.open) loadPairCode(); return; }
      const m = Math.floor(left / 60000);
      const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      el.pairExpiry.textContent = `Code works for ${m}:${s}`;
    };
    tick();
    ui.pairTimer = setInterval(() => { if (!el.dlgConnect.open) return clearInterval(ui.pairTimer); tick(); }, 1000);
  } catch {
    el.pairCode.textContent = '— — —';
    el.pairExpiry.textContent = 'Could not get a code right now. Use the QR code or link instead.';
  }
}

function renderDevices() {
  const list = sync.devices.length ? sync.devices : [];
  if (list.length <= 1) {
    el.devicesList.innerHTML = '';
    return;
  }
  el.devicesList.innerHTML = `<h3>Devices in this space</h3>` + list
    .map((d) => `<div class="device${d.online ? ' on' : ''}"><span class="dot"></span><span>${esc(d.name || 'Device')}${d.id === me() ? ' <span class="muted">(this one)</span>' : ''}</span><span class="when">${d.online ? 'Online' : esc(ago(d.seen))}</span></div>`)
    .join('');
}

function renderInstallHint() {
  if (isStandalone()) { el.installHint.hidden = true; return; }
  if (ui.installPrompt) {
    el.installHint.hidden = false;
    el.installHint.innerHTML = 'Tip: install SyncPad for one-tap access and the share menu. <button class="btn btn-sm btn-primary" id="hint-install">Install</button>';
    $('#hint-install').onclick = install;
  } else if (isIOS()) {
    el.installHint.hidden = false;
    el.installHint.textContent = 'Tip: on iPhone/iPad tap Share → “Add to Home Screen” to install SyncPad. It opens already connected.';
  } else {
    el.installHint.hidden = true;
  }
}

async function joinWithCode() {
  const code = el.joinCode.value.replace(/\D/g, '');
  if (code.length !== 6) { el.joinMsg.textContent = 'Enter the 6 digits shown on your other device.'; el.joinMsg.className = 'form-msg err'; return; }
  if (ui.joining) return;
  ui.joining = true;
  el.joinMsg.textContent = 'Connecting…';
  el.joinMsg.className = 'form-msg';
  try {
    const r = await fetch('/api/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error('Too many tries. Wait a few minutes and try again.');
    if (!j.space) throw new Error('That code didn’t work. Check it, or get a fresh one on the other device.');
    if (j.space === store.get('space')) {
      el.joinMsg.textContent = 'This device is already connected to that space.';
      el.joinMsg.className = 'form-msg ok';
      return;
    }
    el.dlgConnect.close();
    await new Promise((r) => setTimeout(r, 80));
    await offerJoin(j.space);
  } catch (err) {
    el.joinMsg.textContent = navigator.onLine ? err.message : 'You are offline. Connect to the internet first.';
    el.joinMsg.className = 'form-msg err';
  } finally {
    ui.joining = false;
  }
}

async function offerJoin(key) {
  const count = store.list().filter((i) => i.kind !== 'settings').length;
  if (count > 0) {
    const ok = await confirmDialog(
      'Connect to your other device?',
      `The ${count} item${count === 1 ? '' : 's'} on this device will be added to the shared space, so all your devices see everything.`,
      'Connect'
    );
    if (!ok) return;
  }
  await joinSpace(key);
}

async function joinSpace(key) {
  saveNote.flush();
  commitDeletes();
  await sync.flush(6000);
  const old = store.get('space');
  sync.stop();
  for (const it of store.list('file')) it.local = { ...(it.local || {}), up: true, from: old };
  await store.moveToSpace(key);
  cards.clear();
  updateManifest();
  sync.devices = [];
  sync.start();
  files.resumeAll();
  renderAll();
  toast('Connected — everything now syncs between your devices.');
}

/* ═════════════════════════ settings ═════════════════════════ */

function openSettings() {
  el.setName.value = store.get('deviceName') || '';
  renderThemeSeg();
  const st = store.items.get('settings');
  el.setAutodel.value = String((st && st.data.autodel) || 0);
  el.installField.hidden = !ui.installPrompt || isStandalone();
  el.versionText.textContent = `SyncPad ${VERSION} · ${store.get('deviceName')}`;
  renderStorage();
  openDialog(el.dlgSettings);
}
function renderThemeSeg() {
  let t = 'system';
  try { t = localStorage.getItem('sp-theme') || 'system'; } catch {}
  for (const b of $$('[data-theme-opt]', el.setTheme)) b.setAttribute('aria-pressed', String(b.dataset.themeOpt === t));
}
function applyTheme() {
  let t = 'system';
  try { t = localStorage.getItem('sp-theme') || 'system'; } catch {}
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
function renderStorage() {
  const i = sync.info;
  if (!i) { el.storageText.textContent = navigator.onLine ? 'Checking…' : 'Available when online'; return; }
  const cap = i.cap || 1;
  const total = i.total != null ? i.total : i.usage;
  el.storageBar.style.width = Math.min(100, (total / cap) * 100).toFixed(1) + '%';
  el.storageText.textContent = `${fmtBytes(i.usage)} used by your files · ${fmtBytes(Math.max(0, cap - total))} free of ${fmtBytes(cap)} (free plan) · max ${fmtBytes(i.maxFile)} per file`;
}
async function install() {
  if (!ui.installPrompt) return;
  ui.installPrompt.prompt();
  await ui.installPrompt.userChoice.catch(() => {});
  ui.installPrompt = null;
  el.installField.hidden = true;
  renderInstallHint();
}
async function disconnect() {
  const ok = await confirmDialog('Disconnect this device?', 'Everything is removed from this device only. Your other devices keep all notes and files.', 'Disconnect', true);
  if (!ok) return;
  saveNote.flush();
  commitDeletes();
  await sync.flush(6000);
  sync.stop();
  await store.wipe();
  location.replace('/');
}

/* ═════════════════════════ share target + v1 import ═════════════════════════ */

function shareDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('syncpad-share', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('inbox', { autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function takeShared(explicit) {
  let entries = [];
  try {
    const db = await shareDB();
    entries = await new Promise((res) => {
      const t = db.transaction('inbox', 'readwrite');
      const q = t.objectStore('inbox').getAll();
      q.onsuccess = () => { t.objectStore('inbox').clear(); res(q.result || []); };
      q.onerror = () => res([]);
    });
    db.close();
  } catch {}
  if (!entries.length) { if (explicit) toast('Nothing was received from the share menu.'); return; }
  setTab('drops');
  for (const e of entries) {
    if (e.files && e.files.length) await sendFiles(e.files);
    if (e.text) sendClip(e.text);
  }
  toast('Sent to your devices');
}

async function importV1() {
  if (store.get('v1done')) return;
  const notes = await readV1Notes();
  let count = 0;
  for (const n of notes) {
    try {
      let body = String(n.content || '');
      const title = String(n.title || '').trim();
      if (title && title !== 'Untitled Note' && !body.trimStart().startsWith('#')) body = `# ${title}\n\n${body}`;
      if (Array.isArray(n.tags) && n.tags.length) body += `\n\n${n.tags.map((t) => '#' + String(t).replace(/\s+/g, '-')).join(' ')}`;
      const id = /^[A-Za-z0-9_-]{6,64}$/.test(n.id || '') ? n.id : rid(16);
      for (const img of Array.isArray(n.images) ? n.images : []) {
        if (!img || !img.dataUrl || !String(img.dataUrl).startsWith('data:')) continue;
        const blob = dataUrlToBlob(img.dataUrl);
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const name = `${String(img.name || 'Picture').replace(/[\\/]/g, '')}.${ext}`;
        const [item] = await files.add([new File([blob], name, { type: blob.type })], { parent: id });
        if (item) body = body.split(`attachment:${img.id}`).join(`file:${item.id}`);
      }
      const t = Date.parse(n.updatedAt) || Number(n.updatedAt) || Date.now();
      await store.save({ id, kind: 'note', rev: 0, created: t, updated: t, device: me(), data: { body, pinned: !!n.pinned } });
      count++;
    } catch {}
  }
  await store.set('v1done', true);
  if (count) {
    toast(`Moved ${count} note${count === 1 ? '' : 's'} from the previous version.`);
    sync.schedule();
  }
}

function dataUrlToBlob(u) {
  const [head, data] = u.split(',');
  const type = (/data:([^;,]+)/.exec(head) || [])[1] || 'application/octet-stream';
  const bin = head.includes(';base64') ? atob(data) : decodeURIComponent(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

/* ═════════════════════════ small UI helpers ═════════════════════════ */

function overNoteEditor(target) {
  return ui.tab === 'notes' && !!openNoteItem() && ui.mode === 'edit' && !!target && !!target.closest && !!target.closest('#editor-pane');
}

function openMenu(anchor, items) {
  const m = el.menu;
  m.innerHTML = items
    .map((it, i) => `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}"><svg class="ic"><use href="#i-${it.icon}"/></svg><span>${esc(it.label)}</span></button>`)
    .join('');
  m.hidden = false;
  const sheet = isMobileLayout();
  m.classList.toggle('as-sheet', sheet);
  if (!sheet) {
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let top = r.bottom + 6;
    if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.top = top + 'px';
    m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
  } else {
    m.style.left = '';
    m.style.top = '';
  }
  m.onclick = (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    closeMenu();
    items[Number(b.dataset.i)].run();
  };
  const outside = (e) => {
    if (m.contains(e.target)) return;
    closeMenu();
    if (anchor.contains(e.target)) e.stopPropagation();
  };
  ui.menuOutside = outside;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  m.querySelector('button').focus({ preventScroll: true });
}
function closeMenu() {
  el.menu.hidden = true;
  if (ui.menuOutside) document.removeEventListener('pointerdown', ui.menuOutside, true);
  ui.menuOutside = null;
}

function toast(msg, { action, onAction, duration = 3500 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  const remove = () => t.remove();
  if (action) t.querySelector('button').onclick = () => { remove(); onAction && onAction(); };
  el.toasts.appendChild(t);
  while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
  setTimeout(remove, duration);
}

function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = title;
    el.confirmText.textContent = text;
    el.confirmOk.textContent = okLabel;
    el.confirmOk.className = danger ? 'btn btn-danger-soft' : 'btn btn-primary';
    let result = false;
    el.confirmOk.onclick = () => { result = true; el.dlgConfirm.close(); };
    el.dlgConfirm.addEventListener('close', () => resolve(result), { once: true });
    openDialog(el.dlgConfirm);
    el.confirmOk.focus();
  });
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function flashButton(btn, label) {
  const span = btn.querySelector('span');
  if (!span) return;
  const old = span.textContent;
  span.textContent = label;
  setTimeout(() => { span.textContent = old; }, 1200);
}

function downloadText(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'note.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (had && !reloaded && !ui.dirty && !files.queue.length) { reloaded = true; location.reload(); }
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="toasts" style="bottom:24px"><div class="toast"><span>SyncPad could not start: ${esc(err.message || err)}. Try reloading.</span></div></div>`);
});
