// SyncPad v2 — app controller
import {
  $, $$, rid, esc, fmtBytes, clock, dayLabel, ago, shortDate, detectDeviceName, isTouch, isMobileLayout,
  isIOS, isStandalone, linkify, singleUrl, fileKind, kindIcon, extOf, noteTitle, noteSnippet, noteTags, debounce
} from './util.js';
import { Store, readV1Notes } from './store.js';
import { Sync } from './sync.js';
import { Files } from './files.js';
import { sanitizeNote, sanitizePaste, markdownToHtml, textToHtml } from './md.js';
import qrcode from '/vendor/qrcode.mjs';

const VERSION = '2.3.0';
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
  applyZoom();
  renderLockButton();
  if (pinConf()) showLock('unlock');
  else document.documentElement.classList.remove('locked');
  updateManifest();
  await importV1();
  renderAll();
  sync.start();
  files.resumeAll();
  registerSW();
  if (ui.joinedOnFirstRun) toast('Connected — everything now syncs with your other device.');
  if (joinOffer) whenUnlocked(() => offerJoin(joinOffer));
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
  sync.addEventListener('presence', () => {
    rememberDevices();
    renderStatus();
    if (el.dlgConnect.open) renderDevices();
    if (el.dlgSettings.open) renderSettingsDevices(sync.devices);
  });
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
  el.btnLock.addEventListener('click', lockNow);
  el.btnSettingsConnect.addEventListener('click', async () => { el.dlgSettings.close(); await sleepMs(80); openConnect(); });

  // text zoom (note editor)
  el.btnZoomIn.addEventListener('click', () => stepZoom(1));
  el.btnZoomOut.addEventListener('click', () => stepZoom(-1));
  el.btnZoomReset.addEventListener('click', () => { try { localStorage.setItem('sp-zoom', '1'); } catch {} applyZoom(); });
  $('.zoom').addEventListener('mousedown', (e) => e.preventDefault());

  // PIN lock
  el.keypad.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) pinKey(b.dataset.k); });
  el.lockNext.addEventListener('click', pinNext);
  el.btnPinSet.addEventListener('click', async () => { el.dlgSettings.close(); await sleepMs(80); showLock('new'); });
  el.btnPinChange.addEventListener('click', async () => {
    el.dlgSettings.close();
    await sleepMs(80);
    if (await showLock('verify')) showLock('new');
  });
  el.btnPinRemove.addEventListener('click', async () => {
    el.dlgSettings.close();
    await sleepMs(80);
    if (await showLock('verify')) {
      localStorage.removeItem('sp-pin');
      localStorage.removeItem('sp-pin-try');
      renderLockButton();
      toast('PIN turned off for this device.');
    }
  });
  el.setPinAfter.addEventListener('change', () => {
    const c = pinConf();
    if (!c) return;
    c.after = Number(el.setPinAfter.value);
    localStorage.setItem('sp-pin', JSON.stringify(c));
  });
  for (const inp of [el.fileInput, el.noteFileInput]) inp.addEventListener('click', expectAway);
  if (navigator.share) {
    const nativeShare = navigator.share.bind(navigator);
    navigator.share = (data) => { expectAway(); return nativeShare(data); };
  }

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
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
  el.editorText.addEventListener('input', onEditorInput);
  el.editorText.addEventListener('blur', () => saveNote.flush());
  el.editorText.addEventListener('keydown', onEditorKey);
  el.editorText.addEventListener('click', onEditorClick);
  document.addEventListener('selectionchange', () => {
    if (ui.selRaf) return;
    ui.selRaf = requestAnimationFrame(() => { ui.selRaf = 0; if (caretElement()) { saveSel(); updateToolbar(); } });
  });
  // toolbar buttons must not take focus away from the text (keeps the selection and the phone keyboard)
  el.fmtBar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  el.menu.addEventListener('mousedown', (e) => { if (ui.menuKeepFocus) e.preventDefault(); });
  el.btnPin.addEventListener('click', togglePin);
  el.btnNoteMore.addEventListener('click', () => noteMenu(el.btnNoteMore));
  el.btnEditorBack.addEventListener('click', () => closeEditor());
  el.fmtBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]');
    if (b) format(b.dataset.fmt, b);
  });

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
    renderSettingsDevices(sync.devices);
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
    if (!k || (k === 'text' && e.target.closest && e.target.closest('textarea, input, [contenteditable="true"]'))) return;
    e.preventDefault();
    depth++;
    el.dropOverlay.hidden = false;
  });
  addEventListener('dragover', (e) => {
    const k = dragKind(e);
    if (!k) return;
    if (k === 'text' && e.target.closest && e.target.closest('textarea, input, [contenteditable="true"]')) { el.dropOverlay.hidden = true; return; }
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
    if (k === 'text' && e.target.closest && e.target.closest('textarea, input, [contenteditable="true"]')) return;
    e.preventDefault();
    const fl = [...e.dataTransfer.files];
    if (fl.length) {
      if (overNoteEditor(e.target)) attachToNote(fl, rangeFromPoint(e.clientX, e.clientY));
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
    if (t && el.editorText.contains(t)) {
      if (fl.length) { e.preventDefault(); attachToNote(fl); } else pasteIntoEditor(e);
      return;
    }
    if (fl.length) {
      if (!editable || t === el.composerInput) { e.preventDefault(); sendFiles(fl); }
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
    if (!el.lock.hidden && !el.dlgConfirm.open) {
      if (/^\d$/.test(e.key)) pinKey(e.key);
      else if (e.key === 'Backspace') pinKey('back');
      else if (e.key === 'Enter') pinNext();
      else if (e.key === 'Escape' && lk.mode !== 'unlock') endLock(false);
      else if (e.key === 'Tab') return;
      e.preventDefault();
      return;
    }
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
      onVisibilityForLock(false);
    } else {
      onVisibilityForLock(true);
      clearUnseen();
    }
  });
  addEventListener('pagehide', () => { saveNote.flush(); commitDeletes(); });
  addEventListener('online', renderStatus);
  // a join link opened while SyncPad is already open in this tab
  addEventListener('hashchange', () => {
    const k = readParams().join;
    cleanUrl();
    if (k && KEY_RE.test(k) && k !== store.get('space')) whenUnlocked(() => offerJoin(k));
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

/* ───────── notes (rich text: what you see is what is saved) ───────── */

const SIZES = [['Small', 2, 13], ['Normal', 3, 16], ['Large', 4, 18], ['Larger', 5, 24], ['Huge', 6, 32]];
const TEXT_COLORS = [['Default', null], ['Red', '#e5484d'], ['Orange', '#f76b15'], ['Amber', '#d29e00'], ['Green', '#30a46c'], ['Teal', '#12a594'], ['Blue', '#0090ff'],
  ['Indigo', '#5b5bd6'], ['Purple', '#8e4ec6'], ['Pink', '#d6409f'], ['Brown', '#ad7f58'], ['Gray', '#8b8d98']];
const HIGHLIGHTS = [['None', null], ['Yellow', 'rgba(255, 213, 0, 0.4)'], ['Green', 'rgba(48, 164, 108, 0.28)'], ['Blue', 'rgba(0, 144, 255, 0.25)'],
  ['Purple', 'rgba(142, 78, 198, 0.26)'], ['Pink', 'rgba(214, 64, 159, 0.25)'], ['Orange', 'rgba(247, 107, 21, 0.3)']];
const SENT_FG = 'rgb(1, 2, 3)';
const SENT_BG = 'rgb(1, 2, 4)';

const noteText = (n) => (n.data.text != null ? n.data.text : n.data.body || '');
function noteHtml(n) {
  return n.data.html != null ? sanitizeNote(n.data.html) : markdownToHtml(n.data.body || '');
}

function notesSorted() {
  return store
    .list('note')
    .filter((n) => !ui.pendingDeletes.has(n.id))
    .sort((a, b) => (b.data.pinned ? 1 : 0) - (a.data.pinned ? 1 : 0) || b.updated - a.updated);
}

function renderNotesList() {
  const all = notesSorted();
  const tags = new Map();
  for (const n of all) for (const t of noteTags(noteText(n))) tags.set(t, (tags.get(t) || 0) + 1);
  if (ui.tag && !tags.has(ui.tag)) ui.tag = null;
  el.tagChips.hidden = tags.size === 0;
  el.tagChips.innerHTML = [...tags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t]) => `<button class="chip" data-tag="${esc(t)}" aria-pressed="${ui.tag === t}">#${esc(t)}</button>`)
    .join('');
  const q = ui.query.toLowerCase();
  const list = all.filter((n) => (!ui.tag || noteTags(noteText(n)).includes(ui.tag)) && (!q || noteText(n).toLowerCase().includes(q)));
  if (!list.length) {
    el.noteList.innerHTML = `<div class="list-empty">${q || ui.tag ? 'No notes match.' : 'No notes yet.<br>Notes sync to all your devices as you type.'}</div>`;
    return;
  }
  el.noteList.innerHTML = list
    .map((n) => `<button class="note-item" role="listitem" data-id="${n.id}" aria-current="${n.id === ui.noteId}">
      <div class="t">${n.data.pinned ? '<svg class="ic"><use href="#i-pin"/></svg>' : ''}<span>${esc(noteTitle(noteText(n)))}</span></div>
      <div class="s">${esc(noteSnippet(noteText(n))) || '&nbsp;'}</div>
      <div class="d">${esc(shortDate(n.updated))}${n.data.conflictOf ? ' · <span class="warn">Conflict copy</span>' : ''}</div>
    </button>`)
    .join('');
}

function openNote(id, { focus = true } = {}) {
  if (ui.noteId && ui.noteId !== id) saveNote.flush();
  ui.noteId = id;
  ui.savedRange = null;
  if (isMobileLayout() && !el.app.classList.contains('editing')) {
    el.app.classList.add('editing');
    pushLayer({ key: 'editor', close: () => closeEditor(true) });
  }
  renderEditor(true);
  renderNotesList();
  if (focus && !isTouch()) focusEditorEnd();
}

function newNote() {
  if (ui.tab !== 'notes') setTab('notes');
  const now = Date.now();
  ui.newNote = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { html: '', text: '', pinned: false } };
  openNote(ui.newNote.id, { focus: false });
  focusEditorEnd();
}

async function createNote(text) {
  const now = Date.now();
  const n = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { html: textToHtml(text), text, pinned: false } };
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
  if (n && store.items.has(n.id) && !noteText(n).trim() && !/data-file/.test(n.data.html || '')) {
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
  const ed = el.editorText;
  if (force) {
    setEditorHtml(noteHtml(n));
    ed.scrollTop = 0;
    ui.dirty = false;
  } else if (!ui.dirty && !store.outbox.has(n.id)) {
    const html = noteHtml(n);
    if (html !== ui.loadedHtml) {
      // an edit from another device arrived while this note is open: keep the cursor in place
      const off = ed.contains(document.activeElement) || document.activeElement === ed ? caretOffset() : null;
      setEditorHtml(html);
      if (off != null) setCaretOffset(off);
    }
  }
  el.btnPin.setAttribute('aria-pressed', String(!!n.data.pinned));
  el.btnPin.setAttribute('aria-label', n.data.pinned ? 'Unpin note' : 'Pin note');
  el.conflictBar.hidden = !n.data.conflictOf;
  renderFoot();
  renderSaveState();
  updateToolbar();
}

function setEditorHtml(html) {
  el.editorText.innerHTML = html;
  ui.loadedHtml = html;
  hydrateFiles(el.editorText);
  updateEmpty();
}
function hydrateFiles(root) {
  for (const img of $$('img[data-file]', root)) if (!img.getAttribute('src')) img.src = files.src(img.dataset.file);
  for (const a of $$('a[data-file]', root)) { a.setAttribute('contenteditable', 'false'); a.removeAttribute('href'); }
}
function updateEmpty() {
  const ed = el.editorText;
  ed.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img, li, hr, [data-file]'));
}

function renderFoot() {
  const t = el.editorText.innerText || '';
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
  let html;
  try { html = sanitizeNote(el.editorText.innerHTML); } catch { return; }
  ui.dirty = false;
  const text = (el.editorText.innerText || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const exists = store.items.has(n.id);
  if (exists && html === n.data.html) { renderSaveState(); return; }
  if (!exists && !text && !/data-file/.test(html)) { renderSaveState(); return; }
  const { body, ...rest } = n.data;
  n.data = { ...rest, html, text };
  ui.loadedHtml = sanitizeNote(html);
  await store.save(n);
  if (ui.newNote && ui.newNote.id === n.id) ui.newNote = null;
  sync.schedule();
  renderSaveState();
}, 450);

function onEditorInput() {
  normalizeEditor();
  updateEmpty();
  ui.dirty = true;
  renderSaveState();
  saveNote();
  renderFoot();
}

/** "Default colour" / "No highlight" use marker colours that are swapped for real values here */
function normalizeEditor() {
  for (const node of $$('[style]', el.editorText)) {
    const st = node.style;
    if (st.color === SENT_FG) {
      st.removeProperty('color');
      if (inheritsStyle(node, 'color')) st.color = 'var(--text)';
    }
    if (st.backgroundColor === SENT_BG) {
      st.removeProperty('background-color');
      if (inheritsStyle(node, 'backgroundColor')) st.backgroundColor = 'transparent';
    }
    if (!st.length) node.removeAttribute('style');
  }
}
function inheritsStyle(node, prop) {
  for (let p = node.parentElement; p && p !== el.editorText; p = p.parentElement) if (p.style && p.style[prop]) return true;
  return false;
}

function togglePin() {
  const n = openNoteItem();
  if (!n) return;
  saveNote.flush();
  n.data = { ...n.data, pinned: !n.data.pinned };
  if (!store.items.has(n.id)) { renderEditor(false); return; }
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
  const text = () => (el.editorText.innerText || '').trim();
  const m = [
    { icon: 'copy', label: 'Copy text', run: async () => { await copyText(text()); toast('Copied'); } },
    { icon: 'drops', label: 'Send as a drop', run: () => { sendClip(text()); toast('Sent to Drops'); } },
    { icon: 'download', label: 'Download (keeps colours)', run: downloadNote }
  ];
  if (navigator.share && isTouch()) m.push({ icon: 'share', label: 'Share…', run: () => navigator.share({ text: text() }).catch(() => {}) });
  if (store.items.has(n.id)) m.push({ icon: 'trash', label: 'Delete note', danger: true, run: () => deleteWithUndo(n, 'Note') });
  openMenu(anchor, m);
}

function downloadNote() {
  const clone = el.editorText.cloneNode(true);
  for (const img of $$('img[data-file]', clone)) img.src = location.origin + files.url(img.dataset.file);
  for (const a of $$('a[data-file]', clone)) { a.href = location.origin + files.url(a.dataset.file, true); a.removeAttribute('contenteditable'); }
  const title = noteTitle(el.editorText.innerText || '');
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:16px/1.65 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#16181d}img{max-width:100%;border-radius:10px}
ul[data-checklist]{list-style:none;padding-left:0}ul[data-checklist] li::before{content:"☐ "}ul[data-checklist] li[data-checked="true"]::before{content:"☑ "}
</style></head><body>${clone.innerHTML}</body></html>`;
  downloadText(doc, (title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) || 'note') + '.html', 'text/html');
}

/* selection + commands */

function saveSel() {
  const s = getSelection();
  if (s.rangeCount && el.editorText.contains(s.getRangeAt(0).commonAncestorContainer)) ui.savedRange = s.getRangeAt(0).cloneRange();
}
function restoreSel() {
  const ed = el.editorText;
  ed.focus({ preventScroll: true });
  const s = getSelection();
  if (ui.savedRange && ed.contains(ui.savedRange.commonAncestorContainer)) {
    s.removeAllRanges();
    s.addRange(ui.savedRange);
  } else if (!s.rangeCount || !ed.contains(s.getRangeAt(0).commonAncestorContainer)) {
    focusEditorEnd();
  }
}
function focusEditorEnd() {
  const ed = el.editorText;
  ed.focus({ preventScroll: true });
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
function caretOffset() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!el.editorText.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el.editorText);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaretOffset(off) {
  const w = document.createTreeWalker(el.editorText, NodeFilter.SHOW_TEXT);
  let n;
  let left = off;
  while ((n = w.nextNode())) {
    if (left <= n.length) {
      const r = document.createRange();
      r.setStart(n, left);
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    left -= n.length;
  }
}
function caretElement() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const n = s.getRangeAt(0).startContainer;
  const e = n.nodeType === 3 ? n.parentElement : n;
  return el.editorText.contains(e) ? e : null;
}

function exec(cmd, val = null) {
  restoreSel();
  try { document.execCommand('styleWithCSS', false, true); } catch {}
  document.execCommand(cmd, false, val);
  onEditorInput();
  saveSel();
  updateToolbar();
}

function updateToolbar() {
  if (el.editor.hidden) return;
  const e = caretElement();
  if (!e) return;
  const li = e.closest('li');
  const ul = li && li.parentElement;
  const isCheck = !!(ul && ul.hasAttribute('data-checklist'));
  for (const c of ['bold', 'italic', 'underline', 'strikeThrough', 'insertOrderedList', 'insertUnorderedList']) {
    let on = false;
    try { on = document.queryCommandState(c); } catch {}
    if (c === 'insertUnorderedList' && isCheck) on = false;
    const b = el.fmtBar.querySelector(`[data-fmt="${c}"]`);
    if (b) b.setAttribute('aria-pressed', String(on));
  }
  el.fmtBar.querySelector('[data-fmt="checklist"]').setAttribute('aria-pressed', String(isCheck));
  el.fmtBar.querySelector('[data-fmt="heading"]').setAttribute('aria-pressed', String(!!e.closest('h1, h2, h3')));
  const cs = getComputedStyle(e);
  const px = parseFloat(cs.fontSize);
  const hit = SIZES.find((s) => Math.abs(s[2] - px) < 0.6);
  el.fmtSizeLabel.textContent = hit ? hit[0] : `${Math.round(px)} px`;
  el.fmtColorBar.style.background = cs.color;
}

function sizeMenu(anchor) {
  saveSel();
  const e = caretElement();
  const px = e ? parseFloat(getComputedStyle(e).fontSize) : 16;
  openMenu(anchor, SIZES.map(([label, n, size]) => ({
    html: `<span class="tick">${Math.abs(size - px) < 0.6 ? '✓' : ''}</span><span class="sz" style="font-size:${Math.min(size, 26)}px">${label}</span>`,
    run: () => exec('fontSize', n)
  })), { keepFocus: true });
}

function colorMenu(anchor) {
  saveSel();
  const sw = (list, kind) => list
    .map(([name, c]) => kind === 'fg'
      ? `<button class="sw${c ? '' : ' none'}" data-fg="${c || ''}" title="${name}" style="${c ? `color:${c}` : ''}">${c ? 'A' : '⦸'}</button>`
      : `<button class="sw hl${c ? '' : ' none'}" data-bg="${c || ''}" title="${name} highlight" style="${c ? `background:${c}` : ''}">${c ? 'A' : '⦸'}</button>`)
    .join('');
  openMenu(anchor, [], {
    keepFocus: true,
    content: `<div class="palette"><div class="pal-label">Text colour</div><div class="swatches">${sw(TEXT_COLORS, 'fg')}</div>
      <div class="pal-label">Highlight</div><div class="swatches">${sw(HIGHLIGHTS, 'bg')}</div></div>`,
    onClick: (b) => {
      if (b.dataset.fg !== undefined) exec('foreColor', b.dataset.fg || SENT_FG);
      else if (b.dataset.bg !== undefined) exec('hiliteColor', b.dataset.bg || SENT_BG);
    }
  });
}

function bulletList() {
  const e = caretElement();
  const ul = e && e.closest('ul');
  if (ul && ul.hasAttribute('data-checklist')) {
    ul.removeAttribute('data-checklist');
    for (const li of ul.children) li.removeAttribute('data-checked');
    onEditorInput();
    updateToolbar();
    return;
  }
  exec('insertUnorderedList');
}
function makeChecklist() {
  restoreSel();
  const e = caretElement();
  const ul = e && e.closest('ul');
  if (ul && ul.hasAttribute('data-checklist')) return exec('insertUnorderedList'); // toggle off
  if (!ul) exec('insertUnorderedList');
  const list = caretElement() && caretElement().closest('ul');
  if (list) {
    list.setAttribute('data-checklist', '');
    for (const li of list.children) if (!li.hasAttribute('data-checked')) li.setAttribute('data-checked', 'false');
  }
  onEditorInput();
  updateToolbar();
}
function toggleHeading() {
  const e = caretElement();
  exec('formatBlock', e && e.closest('h1, h2, h3') ? 'p' : 'h2');
}
function addLink() {
  saveSel();
  const s = getSelection();
  const sel = s.toString().trim();
  let url = /^https?:\/\/\S+$/i.test(sel) ? sel : prompt('Link address', 'https://');
  if (!url || url === 'https://') return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
  if (!/^(https?|mailto|tel):/i.test(url)) return;
  restoreSel();
  if (getSelection().isCollapsed) exec('insertHTML', `<a href="${esc(url)}">${esc(url)}</a>&nbsp;`);
  else exec('createLink', url);
}
function clearFormat() {
  exec('removeFormat');
  const e = caretElement();
  if (e && e.closest('h1, h2, h3, blockquote')) exec('formatBlock', 'p');
}

function format(kind, btn) {
  if (kind === 'size') return sizeMenu(btn);
  if (kind === 'color') return colorMenu(btn);
  if (kind === 'insertUnorderedList') return bulletList();
  if (kind === 'checklist') return makeChecklist();
  if (kind === 'heading') return toggleHeading();
  if (kind === 'link') return addLink();
  if (kind === 'attach') { saveSel(); return el.noteFileInput.click(); }
  if (kind === 'clear') return clearFormat();
  exec(kind);
}

function onEditorKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNote.flush(); return; }
  if (e.key === ' ' && !mod && !e.isComposing) autoFormat(e);
  if (e.key === 'Enter' && !e.shiftKey) {
    const li = caretElement() && caretElement().closest('ul[data-checklist] > li');
    if (li) setTimeout(() => {
      const now = caretElement() && caretElement().closest('ul[data-checklist] > li');
      if (now && now !== li) { now.setAttribute('data-checked', 'false'); onEditorInput(); }
    }, 0);
  }
}

/** Typing "- ", "1. ", "[] ", "# ", "## " or "> " at the start of a line formats it */
function autoFormat(e) {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return;
  const r = s.getRangeAt(0);
  const node = r.startContainer;
  if (node.nodeType !== 3) return;
  const marker = node.textContent.slice(0, r.startOffset);
  const kinds = { '-': 'ul', '*': 'ul', '1.': 'ol', '[]': 'check', '[ ]': 'check', '#': 'h1', '##': 'h2', '###': 'h3', '>': 'blockquote' };
  const kind = kinds[marker];
  if (!kind) return;
  const parent = node.parentElement;
  if (parent.closest('li, h1, h2, h3, blockquote, pre')) return;
  let block = node;
  while (block.parentNode && block.parentNode !== el.editorText) block = block.parentNode;
  const first = document.createTreeWalker(block.nodeType === 3 ? block.parentNode : block, NodeFilter.SHOW_TEXT);
  let ft = first.nextNode();
  if (block.nodeType === 3) ft = block;
  if (ft !== node) return;
  e.preventDefault();
  const del = document.createRange();
  del.setStart(node, 0);
  del.setEnd(node, r.startOffset);
  s.removeAllRanges();
  s.addRange(del);
  document.execCommand('delete');
  saveSel();
  if (kind === 'ul') exec('insertUnorderedList');
  else if (kind === 'ol') exec('insertOrderedList');
  else if (kind === 'check') makeChecklist();
  else exec('formatBlock', kind);
}

function onEditorClick(e) {
  const li = e.target.closest('ul[data-checklist] > li');
  if (li && e.target === li && e.clientX - li.getBoundingClientRect().left < 30 * getZoom()) {
    e.preventDefault();
    li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
    onEditorInput();
    return;
  }
  const f = e.target.closest('[data-file]');
  if (f) {
    const it = store.items.get(f.dataset.file);
    if (it) { e.preventDefault(); openFile(it); }
    return;
  }
  const a = e.target.closest('a[href]');
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
}

async function attachToNote(list, point) {
  if (!list.length) return;
  let n = openNoteItem();
  if (!n) { newNote(); n = openNoteItem(); }
  if (point) ui.savedRange = point;
  const items = await files.add(list, { parent: n.id });
  if (!items.length) return;
  const html = items
    .map((it) => (fileKind(it.data.type, it.data.name) === 'image'
      ? `<img data-file="${it.id}" alt="${esc(it.data.name)}">`
      : `<a data-file="${it.id}" class="file-chip" contenteditable="false">📎 ${esc(it.data.name)}</a>&nbsp;`))
    .join('');
  exec('insertHTML', html);
  hydrateFiles(el.editorText);
  onEditorInput();
}

function pasteIntoEditor(e) {
  const cd = e.clipboardData;
  const html = cd.getData('text/html');
  const text = cd.getData('text/plain');
  e.preventDefault();
  if (html) document.execCommand('insertHTML', false, sanitizePaste(html));
  else if (text) document.execCommand('insertText', false, text);
  onEditorInput();
}

function rangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  return null;
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
  renderPinSettings();
  loadDevices();
  renderStorage();
  openDialog(el.dlgSettings);
}
async function loadDevices() {
  renderSettingsDevices(sync.devices);
  if (!navigator.onLine) return;
  try {
    const r = await fetch(`/api/s/${store.get('space')}/devices`);
    const j = await r.json();
    if (Array.isArray(j.devices)) {
      sync.devices = j.devices;
      rememberDevices();
      renderSettingsDevices(j.devices);
    }
  } catch {}
}
function devIcon(name) {
  if (/ipad|tablet/i.test(name || '')) return 'tablet';
  if (/phone|android|pixel|samsung|mobile/i.test(name || '')) return 'phone';
  return 'laptop';
}
function renderSettingsDevices(list) {
  const mine = me();
  const devices = [...(list || [])];
  if (!devices.some((d) => d.id === mine)) devices.unshift({ id: mine, name: store.get('deviceName'), seen: Date.now(), online: sync.wsOpen });
  devices.sort((a, b) => (b.id === mine) - (a.id === mine) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.seen - a.seen);
  el.devCount.textContent = devices.length > 1 ? String(devices.length) : '';
  el.settingsDevices.innerHTML = devices
    .map((d) => {
      const isMe = d.id === mine;
      const on = d.online || (isMe && sync.wsOpen);
      const name = (isMe ? store.get('deviceName') : d.name) || 'Device';
      return `<div class="dev-row${on ? ' on' : ''}">
        <span class="dev-ic"><svg class="ic"><use href="#i-${devIcon(name)}"/></svg><span class="dot"></span></span>
        <div class="dev-main"><div class="dev-name">${esc(name)}${isMe ? '<span class="me">This device</span>' : ''}</div>
        <div class="dev-when">${on ? 'Online now' : `Last seen ${esc(ago(d.seen))}`}</div></div>
      </div>`;
    })
    .join('') + (devices.length <= 1 ? '<div class="dev-empty">No other devices yet. Tap “Add a device” to connect your phone or computer.</div>' : '');
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
  if (ok) await wipeDevice();
}
async function wipeDevice() {
  saveNote.flush();
  commitDeletes();
  await sync.flush(6000);
  sync.stop();
  await store.wipe();
  try { for (const k of ['sp-pin', 'sp-pin-try', 'sp-zoom']) localStorage.removeItem(k); } catch {}
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

/* ═════════════════════════ text zoom (this device) ═════════════════════════ */

const ZOOMS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
function getZoom() {
  let z = 1;
  try { z = Number(localStorage.getItem('sp-zoom')) || 1; } catch {}
  return Math.min(2, Math.max(0.8, z));
}
function applyZoom() {
  const z = getZoom();
  document.documentElement.style.setProperty('--note-zoom', String(z));
  el.btnZoomReset.textContent = `${Math.round(z * 100)}%`;
  el.btnZoomOut.disabled = z <= ZOOMS[0];
  el.btnZoomIn.disabled = z >= ZOOMS[ZOOMS.length - 1];
}
function stepZoom(dir) {
  const z = getZoom();
  let i = ZOOMS.findIndex((v) => v >= z - 0.001);
  if (i < 0) i = ZOOMS.length - 1;
  i = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
  try { localStorage.setItem('sp-zoom', String(ZOOMS[i])); } catch {}
  applyZoom();
}

/* ═════════════════════════ PIN lock (this device only) ═════════════════════════ */

const lk = { mode: null, digits: '', first: '', done: null, busy: false, queue: [], hiddenAt: 0, away: 0 };
function pinConf() {
  try { return JSON.parse(localStorage.getItem('sp-pin') || 'null'); } catch { return null; }
}
const isLocked = () => !el.lock.hidden || document.documentElement.classList.contains('locked');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function pinHash(pin, saltB64, iters) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, key, 256));
}
async function savePin(pin) {
  const old = pinConf();
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const iters = 200000;
  const conf = { salt, iters, hash: await pinHash(pin, salt, iters), len: pin.length, after: old && old.after != null ? old.after : 60 };
  localStorage.setItem('sp-pin', JSON.stringify(conf));
  localStorage.removeItem('sp-pin-try');
  renderLockButton();
}

/** mode: unlock | verify (current PIN) | new | confirm. Resolves true/false. */
function showLock(mode) {
  return new Promise((resolve) => {
    for (const d of $$('dialog[open]')) d.close();
    closeMenu();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    lk.mode = mode;
    lk.digits = '';
    lk.done = resolve;
    el.lock.hidden = false;
    el.app.inert = true;
    renderLock();
  });
}
function renderLock(msg = '') {
  const conf = pinConf();
  el.lockTitle.textContent = { unlock: 'Enter your PIN', verify: 'Enter your current PIN', new: 'Choose a PIN', confirm: 'Enter it again' }[lk.mode] || '';
  el.lockSub.textContent = lk.mode === 'new' ? '4 to 6 digits, only for this device' : lk.mode === 'unlock' ? 'SyncPad is locked on this device' : '';
  const n = lk.mode === 'new' ? Math.max(4, lk.digits.length) : lk.mode === 'confirm' ? lk.first.length : conf ? conf.len : 4;
  el.pinDots.innerHTML = Array.from({ length: n }, (_, i) => `<span class="${i < lk.digits.length ? 'on' : ''}"></span>`).join('');
  el.lockMsg.textContent = msg;
  el.lockAlt.textContent = lk.mode === 'unlock' ? 'Forgot?' : 'Cancel';
  el.lockNext.hidden = !(lk.mode === 'new' && lk.digits.length >= 4 && lk.digits.length < 6);
}
async function pinKey(k) {
  if (lk.busy || !lk.mode) return;
  if (k === 'alt') return lk.mode === 'unlock' ? forgotPin() : endLock(false);
  if (k === 'back') lk.digits = lk.digits.slice(0, -1);
  else if (/^\d$/.test(k) && lk.digits.length < 6) lk.digits += k;
  else return;
  renderLock();
  const conf = pinConf();
  if ((lk.mode === 'unlock' || lk.mode === 'verify') && conf && lk.digits.length === conf.len) await checkPin();
  else if (lk.mode === 'new' && lk.digits.length === 6) pinNext();
  else if (lk.mode === 'confirm' && lk.digits.length === lk.first.length) {
    if (lk.digits === lk.first) {
      lk.busy = true;
      await savePin(lk.digits);
      lk.busy = false;
      endLock(true);
      toast('PIN is on. This device will ask for it.');
    } else {
      lk.mode = 'new';
      lk.first = '';
      lk.digits = '';
      shakeDots();
      renderLock('The PINs didn’t match. Choose one again.');
    }
  }
}
function pinNext() {
  if (lk.mode !== 'new' || lk.digits.length < 4) return;
  lk.first = lk.digits;
  lk.digits = '';
  lk.mode = 'confirm';
  renderLock();
}
function readTries() {
  try { return JSON.parse(localStorage.getItem('sp-pin-try')) || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; }
}
async function checkPin() {
  const conf = pinConf();
  const tries = readTries();
  const wait = () => `Too many tries. Wait ${Math.ceil((tries.until - Date.now()) / 1000)} s.`;
  if (Date.now() < tries.until) { lk.digits = ''; shakeDots(); renderLock(wait()); return; }
  lk.busy = true;
  let ok = false;
  try { ok = (await pinHash(lk.digits, conf.salt, conf.iters)) === conf.hash; } catch {}
  lk.busy = false;
  if (ok) { localStorage.removeItem('sp-pin-try'); endLock(true); return; }
  tries.n++;
  if (tries.n >= 5) tries.until = Date.now() + Math.min(900, 30 * 2 ** (tries.n - 5)) * 1000;
  localStorage.setItem('sp-pin-try', JSON.stringify(tries));
  lk.digits = '';
  shakeDots();
  renderLock(tries.until > Date.now() ? wait() : 'Wrong PIN');
}
function shakeDots() {
  el.pinDots.classList.remove('shake');
  void el.pinDots.offsetWidth;
  el.pinDots.classList.add('shake');
  try { navigator.vibrate && navigator.vibrate(70); } catch {}
}
function endLock(ok) {
  const { done, mode } = lk;
  lk.mode = null;
  lk.done = null;
  lk.digits = '';
  lk.first = '';
  el.lock.hidden = true;
  el.app.inert = false;
  document.documentElement.classList.remove('locked', 'privacy');
  if (done) done(ok);
  if (ok && mode === 'unlock') for (const f of lk.queue.splice(0)) f();
}
function lockNow() {
  if (!pinConf() || lk.mode === 'unlock') return;
  saveNote.flush();
  document.documentElement.classList.add('locked');
  showLock('unlock');
}
function whenUnlocked(fn) {
  if (isLocked()) lk.queue.push(fn);
  else fn();
}
function renderLockButton() {
  el.btnLock.hidden = !pinConf();
}
function renderPinSettings() {
  const c = pinConf();
  el.pinOffRow.hidden = !!c;
  el.pinOnRow.hidden = !c;
  if (c) el.setPinAfter.value = String(c.after != null ? c.after : 60);
}
async function forgotPin() {
  const ok = await confirmDialog(
    'Forgot your PIN?',
    'To protect your privacy, the only way back in is to disconnect this device. Your notes and files stay safe on your other devices, and you can connect this one again right after.',
    'Disconnect this device',
    true
  );
  if (ok) await wipeDevice();
}
/** File pickers and share sheets briefly leave the app — that shouldn't trigger the lock */
function expectAway() { lk.away = Date.now(); }
function onVisibilityForLock(visible) {
  const c = pinConf();
  if (!c || lk.mode === 'unlock') return;
  if (!visible) {
    lk.hiddenAt = Date.now();
    if (!lk.mode) document.documentElement.classList.add('privacy'); // hide content from the app switcher
    return;
  }
  if (lk.away && Date.now() - lk.away < 10 * 60 * 1000) {
    lk.away = 0;
    document.documentElement.classList.remove('privacy');
    return;
  }
  if (!lk.mode && Date.now() - lk.hiddenAt >= (c.after != null ? c.after : 60) * 1000) lockNow();
  else document.documentElement.classList.remove('privacy');
}

/* ═════════════════════════ small UI helpers ═════════════════════════ */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));


function overNoteEditor(target) {
  return ui.tab === 'notes' && !!openNoteItem() && !!target && !!target.closest && !!target.closest('#editor-pane');
}

function openMenu(anchor, items, opts = {}) {
  const m = el.menu;
  ui.menuKeepFocus = !!opts.keepFocus;
  m.innerHTML = opts.content || items
    .map((it, i) => `<button role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.html || `<svg class="ic"><use href="#i-${it.icon}"/></svg><span>${esc(it.label)}</span>`}</button>`)
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
    const b = e.target.closest(opts.content ? 'button' : 'button[data-i]');
    if (!b) return;
    closeMenu();
    if (opts.onClick) opts.onClick(b);
    else items[Number(b.dataset.i)].run();
  };
  const outside = (e) => {
    if (m.contains(e.target)) return;
    closeMenu();
    if (anchor.contains(e.target)) e.stopPropagation();
  };
  ui.menuOutside = outside;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  if (!opts.keepFocus) m.querySelector('button').focus({ preventScroll: true });
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

function downloadText(text, name, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
