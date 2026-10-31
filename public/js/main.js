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
import { Markup } from './markup.js';
import { Collage } from './collage.js';
import { ZoomView } from './zoom.js';
import * as De from './declutter.js';
import { NoteCanvas, renderStatic as renderCanvasStatic, fallback as canvasFallback, fromHtml as canvasFromHtml } from './canvas.js';
import { ImageTools } from './noteimg.js';

const VERSION = '2.15.0';
const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;
const store = new Store();
let sync;
let files;
let markup;
let collage;
let pdfEditor = null;
let docEditor = null;
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
  stickBottom: true,
  dloc: (() => { try { const v = localStorage.getItem('sp-dloc') || localStorage.getItem('sp-dview') || 'home'; return v.startsWith('f:') ? v : 'home'; } catch { return 'home'; } })(),
  dtype: (() => { try { return localStorage.getItem('sp-dtype') || 'all'; } catch { return 'all'; } })(),
  layout: (() => { try { return localStorage.getItem('sp-layout') || 'list'; } catch { return 'list'; } })(),
  selecting: false,
  selected: new Set(),
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
  if (!store.get('secret')) await store.set('secret', rid(24));

  const params = readParams();
  let joinOffer = null;
  if (!store.get('space')) {
    const k = parseLink(params.join || params.s);
    const space = k ? k.space : rid(24);
    await store.set('space', space);
    await store.set('token', k ? k.token : space);
    await store.set('seq', 0);
    if (k) ui.joinedOnFirstRun = true;
  } else {
    const k = parseLink(params.join);
    if (k && k.space !== store.get('space')) joinOffer = k;
    else if (k && k.token !== store.get('token')) await store.set('token', k.token);
  }
  if (!store.get('token')) await store.set('token', store.get('space'));
  store.set('pinOn', !!pinConf());
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
  if (params.removed) toast('This device was removed from your SyncPad by another device, and its copy was erased.', { duration: 12000 });
  if (store.get('push') && pushSupported() && Notification.permission === 'granted') subscribePush(false).catch(() => {});
  if (joinOffer) whenUnlocked(() => offerJoin(joinOffer));
  takeShared(params.shared);
  initLaunchQueue();
}

function readParams() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { join: h.get('join') || q.get('join'), s: q.get('s'), shared: q.has('shared'), removed: q.has('removed') };
}

function cleanUrl() {
  if (location.search || location.hash) history.replaceState(null, '', '/');
}

function updateManifest() {
  // lets iOS home-screen installs open already connected
  el.manifestLink.href = '/app.webmanifest?s=' + linkCode();
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
  sync.addEventListener('token', onToken);
  sync.addEventListener('revoked', onRevoked);
  sync.addEventListener('denied', () => {
    renderStatus();
    toast('This device lost access to your SyncPad. Connect it again with a code from another device.', { action: 'Connect', onAction: openConnect, duration: 12000 });
  });
  files.addEventListener('offline', () => scheduleRender(true, false));
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
  el.btnOpenTrash.addEventListener('click', async () => { el.dlgSettings.close(); await sleepMs(80); openTrash(); });
  el.trashList.addEventListener('click', onTrashClick);
  el.btnEmptyTrash.addEventListener('click', emptyTrash);
  el.historyList.addEventListener('click', (e) => { const b = e.target.closest('[data-hid]'); if (b) showVersion(b.dataset.hid); });
  el.btnRestoreVersion.addEventListener('click', restoreVersion);
  el.btnNotif.addEventListener('click', toggleNotif);
  el.settingsDevices.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) removeDevice(b.dataset.remove, b.dataset.name);
  });
  el.btnSettingsConnect.addEventListener('click', async () => { el.dlgSettings.close(); await sleepMs(80); openConnect(); });

  // text zoom (note editor)
  el.btnZoomIn.addEventListener('click', () => (canvasOpen() ? ui.canvas.zoomStep(1) : stepZoom(1)));
  el.btnZoomOut.addEventListener('click', () => (canvasOpen() ? ui.canvas.zoomStep(-1) : stepZoom(-1)));
  el.btnZoomReset.addEventListener('click', () => { if (canvasOpen()) { ui.canvas.zoomStep(0); return; } try { localStorage.setItem('sp-zoom', '1'); } catch {} applyZoom(); });
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
      store.set('pinOn', false);
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

  // home screen: filters, folders, layout, selecting
  el.feedInner.addEventListener('click', onFeedClick);
  const navClick = async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) return setDropView(v.dataset.view);
    const a = e.target.closest('[data-act="new-folder"]');
    if (a) { const f = await createFolder(); if (f) setDropView('f:' + f.id); }
  };
  el.dropsSide.addEventListener('click', navClick);
  el.dropChips.addEventListener('click', navClick);
  el.typeChips.addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) setDropType(b.dataset.type); });
  el.btnType.addEventListener('click', () => typeMenu(el.btnType));
  initMarquee();
  el.viewToggle.addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (b) setLayout(b.dataset.layout); });
  el.btnSelect.addEventListener('click', () => (ui.selecting ? exitSelect() : enterSelect()));
  el.btnFolderMore.addEventListener('click', () => folderMenu(el.btnFolderMore));
  el.selectBar.addEventListener('click', onSelectBar);
  // drag drops onto a folder (desktop)
  el.feedInner.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('[data-id]');
    if (!row) return;
    const ids = ui.selecting && ui.selected.has(row.dataset.id) ? [...ui.selected] : [row.dataset.id];
    e.dataTransfer.setData('application/x-syncpad', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    el.app.classList.add('dragging-drop');
  });
  el.feedInner.addEventListener('dragend', () => el.app.classList.remove('dragging-drop'));
  el.dropsSide.addEventListener('dragover', (e) => {
    const t = e.target.closest('[data-folder-drop]');
    const internal = [...e.dataTransfer.types].includes('application/x-syncpad');
    for (const n of $$('.drop-target', el.dropsSide)) if (n !== t) n.classList.remove('drop-target');
    if (!t || !internal) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.classList.add('drop-target');
  });
  el.dropsSide.addEventListener('dragleave', (e) => { const t = e.target.closest('[data-folder-drop]'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-target'); });
  el.dropsSide.addEventListener('drop', (e) => {
    const t = e.target.closest('[data-folder-drop]');
    for (const n of $$('.drop-target', el.dropsSide)) n.classList.remove('drop-target');
    const raw = e.dataTransfer.getData('application/x-syncpad');
    if (!t || !raw) return;
    e.preventDefault();
    e.stopPropagation();
    try { moveTo(JSON.parse(raw), t.dataset.folderDrop); } catch {}
  });
  // long-press a drop on a phone to start selecting
  el.feedInner.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || ui.selecting) return;
    const row = e.target.closest('[data-id]');
    if (!row) return;
    clearTimeout(ui.lpTimer);
    const x = e.clientX;
    const y = e.clientY;
    ui.lpTimer = setTimeout(() => {
      ui.suppressClick = true;
      try { navigator.vibrate && navigator.vibrate(30); } catch {}
      enterSelect();
      toggleSelect(row.dataset.id);
    }, 480);
    const cancel = (ev) => {
      if (ev.type === 'pointermove' && Math.hypot(ev.clientX - x, ev.clientY - y) < 10) return;
      clearTimeout(ui.lpTimer);
      removeEventListener('pointerup', cancel);
      removeEventListener('pointermove', cancel);
      removeEventListener('pointercancel', cancel);
    };
    addEventListener('pointerup', cancel);
    addEventListener('pointermove', cancel);
    addEventListener('pointercancel', cancel);
  });
  // right-click / two-finger tap on a touchpad → SyncPad's own menus (Shift + right-click = browser menu)
  addEventListener('pointerdown', (e) => { ui.lastPointer = e.pointerType; }, true);
  // phones: while the keyboard is up, hide the bottom tab bar so it doesn't sit on top of the keyboard
  const typing = (t) => t && (t.matches('input:not([type=checkbox]):not([type=radio]), textarea, select') || t.isContentEditable);
  document.addEventListener('focusin', (e) => { if (isTouch() && typing(e.target)) el.app.classList.add('kb'); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!typing(document.activeElement)) el.app.classList.remove('kb'); }, 60));
  el.feedInner.addEventListener('contextmenu', onFeedContext);
  el.dropsSide.addEventListener('contextmenu', onSideContext);
  el.noteList.addEventListener('contextmenu', onNoteListContext);
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
  ui.imgTools = new ImageTools({
    editor: el.editorText,
    onChange: onEditorInput,
    onView: (im) => { const it = store.items.get(im.dataset.file); if (it) openFile(it); }
  });
  el.btnNewCanvas.addEventListener('click', () => newNote({ canvas: true }));
  el.btnToggleList.addEventListener('click', () => toggleNotesList());
  el.btnShowList.addEventListener('click', () => toggleNotesList(false));
  el.btnPresent.addEventListener('click', startPresent);
  applyNotesList();
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && ui.presenting && ui.presentFs) stopPresent(); });
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
  el.setDeclutter.addEventListener('change', () => {
    const cur = store.items.get('settings');
    const item = cur || { id: 'settings', kind: 'settings', rev: 0, created: Date.now(), data: {} };
    item.data = { ...item.data, declutter: el.setDeclutter.value };
    store.save(item).then(() => sync.schedule());
  });
  el.btnDisconnect.addEventListener('click', disconnect);
  el.btnInstall.addEventListener('click', install);
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); ui.installPrompt = e; });
  addEventListener('appinstalled', () => { ui.installPrompt = null; toast('SyncPad installed.'); });

  // viewer
  el.viewerDownload.addEventListener('click', () => ui.viewing && files.download(ui.viewing));
  el.viewerShare.addEventListener('click', () => ui.viewing && files.share(ui.viewing).catch(() => {}));
  el.viewerMarkup.addEventListener('click', () => {
    const it = ui.viewing;
    if (!it) return;
    if (canEditDoc(it)) openDocEdit(it);
    else if (canEditPdf(it)) (ui.docSource ? editDocument(it, { kind: 'html', html: ui.docSource }) : openPdfEdit(it));
    else openMarkup(it);
  });
  el.btnNewDoc.addEventListener('click', newDocument);
  el.dlgViewer.addEventListener('close', () => {
    if (ui.zoom) { ui.zoom.destroy(); ui.zoom = null; }
    el.viewerBody.innerHTML = '';
    el.viewerBody.classList.remove('is-zoom', 'is-docv');
    ui.viewing = null;
    ui.docSource = null;
  });
  el.viewerBody.addEventListener('click', (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b || !ui.zoom) return;
    if (b.dataset.zoom === 'in') ui.zoom.zoomBy(1.6);
    else if (b.dataset.zoom === 'out') ui.zoom.zoomBy(1 / 1.6);
    else if (ui.zoom.toggle) ui.zoom.toggle();
    else ui.zoom.fit();
  });
  el.dlgViewer.addEventListener('keydown', (e) => {
    if (!ui.zoom || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') ui.zoom.zoomBy(1.6);
    else if (e.key === '-') ui.zoom.zoomBy(1 / 1.6);
    else if (e.key === '0') ui.zoom.fit(true);
  });
  el.btnRefresh.addEventListener('click', refreshNow);
  markup = new Markup(el.dlgMarkup);
  collage = new Collage(el.dlgCollage);

  // drag & drop anywhere
  let depth = 0;
  const dragKind = (e) => {
    const t = e.dataTransfer ? [...e.dataTransfer.types] : [];
    if (t.includes('application/x-syncpad')) return null;
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
    const fd = e.target.closest && e.target.closest('[data-folder-drop]');
    const fdName = fd && store.items.get(fd.dataset.folderDrop) && store.items.get(fd.dataset.folderDrop).data.name;
    el.dropOverlayTitle.textContent = overNoteEditor(e.target) ? 'Drop to attach to this note'
      : fdName ? `Drop into “${fdName}”`
      : currentFolder() && ui.tab === 'drops' ? `Drop into “${viewTitle()}”` : 'Drop to send to all your devices';
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
      const fd = e.target.closest && e.target.closest('[data-folder-drop]');
      if (overNoteEditor(e.target)) attachToNote(fl, rangeFromPoint(e.clientX, e.clientY), { clientX: e.clientX, clientY: e.clientY });
      else sendFiles(fl, fd ? fd.dataset.folderDrop : undefined);
      return;
    }
    const text = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || e.dataTransfer.getData('text/plain');
    if (text && text.trim()) { setTab('drops'); sendClip(declutterDrop(text, e.dataTransfer.getData('text/html'))); }
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
    if (t === el.composerInput) { cleanComposerPaste(e); return; }
    if (!editable && ui.tab === 'drops') {
      const text = e.clipboardData.getData('text');
      if (text) {
        e.preventDefault();
        el.composerInput.value += declutterDrop(text, e.clipboardData.getData('text/html'));
        autosize();
        updateSend();
        el.composerInput.focus();
      }
    }
  });

  // Ctrl+Shift+V pastes exactly what was copied (no de-clutter)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') ui.rawPasteUntil = Date.now() + 1500;
  }, true);

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
    if (ui.presenting && e.key === 'Escape') { e.preventDefault(); stopPresent(); return; }
    if (mod && e.key === '\\' && ui.tab === 'notes') { e.preventDefault(); toggleNotesList(); return; }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      el.app.classList.add('searching');
      el.search.focus();
      el.search.select();
    } else if (e.key === 'Escape' && !el.menu.hidden) {
      closeMenu();
    } else if (e.key === 'Escape' && ui.selecting && !$('dialog[open]')) {
      exitSelect();
    } else if (ui.tab === 'drops' && !$('dialog[open]') && !(e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]'))) {
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(new Set(visibleDrops().map((i) => i.id))); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selecting && ui.selected.size) { e.preventDefault(); selAction('trash'); }
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
      onVisibilityForLock(false);
    } else {
      onVisibilityForLock(true);
      clearUnseen();
    }
  });
  addEventListener('pagehide', () => saveNote.flush());
  addEventListener('online', renderStatus);
  // a join link opened while SyncPad is already open in this tab
  addEventListener('hashchange', () => {
    const k = parseLink(readParams().join);
    cleanUrl();
    if (k && k.space !== store.get('space')) whenUnlocked(() => offerJoin(k));
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
  const drops = kinds.some((it) => !it || isDrop(it) || it.kind === 'folder');
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
  if (sync.state === 'denied') {
    state = 'offline';
    text = 'Not connected';
  } else if (!navigator.onLine || sync.state === 'offline') {
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

/* ───────── drops (home screen): filters, folders, compact list / grid ───────── */

const isDrop = (i) => i.kind === 'clip' || (i.kind === 'file' && !i.data.parent);
const TYPES = [
  ['all', 'All'],
  ['media', 'Photos & videos'],
  ['files', 'Files'],
  ['links', 'Links'],
  ['text', 'Text'],
  ['pinned', 'Pinned']
];

function dropType(it) {
  if (it.kind === 'clip') return singleUrl(it.data.text || '') ? 'links' : 'text';
  const k = fileKind(it.data.type, it.data.name);
  return k === 'image' || k === 'video' ? 'media' : 'files';
}
function folders() {
  return store.list('folder').sort((a, b) => String(a.data.name || '').localeCompare(String(b.data.name || ''), undefined, { sensitivity: 'base' }));
}
function folderOf(it) {
  const f = it.data.folder && store.items.get(it.data.folder);
  return f && f.kind === 'folder' ? f : null;
}
function currentFolder() {
  return ui.dloc.startsWith('f:') && store.items.get(ui.dloc.slice(2)) ? ui.dloc.slice(2) : null;
}
function dropItems() {
  return store.list().filter((i) => isDrop(i) && !i.data.trashed).sort((a, b) => b.created - a.created);
}
/** Home shows only drops that aren't in a folder; a folder shows only its own drops */
function inLocation(it, loc = ui.dloc) {
  const f = folderOf(it);
  return loc === 'home' ? !f : !!f && f.id === loc.slice(2);
}
function ofType(it, type = ui.dtype) {
  if (type === 'all') return true;
  if (type === 'pinned') return !!it.data.keep;
  return dropType(it) === type;
}
function visibleDrops(all = dropItems()) {
  const q = ui.query.toLowerCase();
  if (q) {
    // search looks everywhere, folders included
    return all.filter((i) => ofType(i) && [i.data.text, i.data.name, i.data.link && i.data.link.title].some((s) => s && s.toLowerCase().includes(q)));
  }
  return all.filter((i) => inLocation(i) && ofType(i));
}
function viewTitle() {
  if (ui.query) return 'Search results';
  const f = currentFolder();
  return f ? store.items.get(f).data.name || 'Folder' : 'Home';
}
function setDropView(loc) {
  ui.dloc = loc;
  try { localStorage.setItem('sp-dloc', loc); } catch {}
  exitSelect();
  el.feed.scrollTop = 0;
  renderDrops();
}
function setDropType(type) {
  ui.dtype = type;
  try { localStorage.setItem('sp-dtype', type); } catch {}
  exitSelect();
  renderDrops();
}
function setLayout(l) {
  ui.layout = l;
  try { localStorage.setItem('sp-layout', l); } catch {}
  cards.clear();
  renderDrops();
}

function renderDropsNav(all) {
  if (ui.dloc.startsWith('f:') && !currentFolder()) ui.dloc = 'home';
  const countLoc = (loc) => all.filter((i) => inLocation(i, loc)).length;
  const fl = folders();
  const nav = (loc, label, icon, n, folderId) => `<button class="nav-item${ui.dloc === loc && !ui.query ? ' on' : ''}" data-view="${loc}"${folderId ? ` data-folder-drop="${folderId}"` : ''}>
      <svg class="ic"><use href="#i-${icon}"/></svg><span class="nav-label">${esc(label)}</span><span class="nav-count">${n || ''}</span></button>`;
  el.dropsSide.innerHTML =
    nav('home', 'Home', 'drops', countLoc('home')) +
    `<div class="nav-head"><span>Folders</span><button class="icon-btn sm" data-act="new-folder" aria-label="New folder" title="New folder"><svg class="ic"><use href="#i-plus"/></svg></button></div>` +
    (fl.length
      ? fl.map((f) => nav('f:' + f.id, f.data.name || 'Folder', 'folder', countLoc('f:' + f.id), f.id)).join('') +
        (isTouch() ? '' : '<p class="nav-hint">Drag drops onto a folder to move them. Drag across empty space to select several.</p>')
      : '<button class="nav-empty" data-act="new-folder"><svg class="ic"><use href="#i-plus"/></svg>New folder</button>');
  const chip = (loc, label) => `<button class="chip" data-view="${loc}" aria-pressed="${ui.dloc === loc}">${label}</button>`;
  el.dropChips.innerHTML = [
    chip('home', `<svg class="ic"><use href="#i-drops"/></svg>Home`),
    ...fl.map((f) => chip('f:' + f.id, `<svg class="ic"><use href="#i-folder"/></svg>${esc(f.data.name || 'Folder')}`)),
    '<button class="chip add" data-act="new-folder"><svg class="ic"><use href="#i-plus"/></svg>Folder</button>'
  ].join('');
  // type filter: chips on a computer, one button on a phone
  const here = ui.query ? all : all.filter((i) => inLocation(i));
  const typeCount = (t) => here.filter((i) => ofType(i, t)).length;
  el.typeChips.innerHTML = TYPES.filter(([t]) => t === 'all' || t === ui.dtype || typeCount(t))
    .map(([t, l]) => `<button class="chip" data-type="${t}" aria-pressed="${ui.dtype === t}">${esc(l)}${t === 'all' ? '' : ` <span class="cnt">${typeCount(t)}</span>`}</button>`)
    .join('');
  el.typeChips.hidden = here.length === 0;
  el.btnType.querySelector('span').textContent = ui.dtype === 'all' ? 'All types' : TYPES.find((x) => x[0] === ui.dtype)[1];
  el.btnType.classList.toggle('on', ui.dtype !== 'all');
  el.btnType.hidden = here.length === 0 && ui.dtype === 'all';
  el.dhTitle.textContent = viewTitle();
  el.btnFolderMore.hidden = !currentFolder() || !!ui.query;
  for (const b of $$('[data-layout]', el.viewToggle)) b.setAttribute('aria-pressed', String(b.dataset.layout === ui.layout));
  el.composerInput.placeholder = currentFolder() ? `Send to “${viewTitle()}” — type, paste or drop…` : 'Type, paste or drop anything…';
}

function typeMenu(anchor) {
  openMenu(anchor, TYPES.map(([t, l]) => ({ icon: { all: 'drops', media: 'image', files: 'file', links: 'link', text: 'note', pinned: 'pin' }[t], label: (ui.dtype === t ? '✓ ' : '') + l, run: () => setDropType(t) })));
}

function renderDrops() {
  const all = dropItems();
  renderDropsNav(all);
  const list = visibleDrops(all);
  el.dhCount.textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : '';
  el.feed.classList.toggle('grid-mode', ui.layout === 'grid');
  if (!all.length && !ui.query) {
    cards.clear();
    el.feedInner.innerHTML = emptyDrops();
    return;
  }
  if (!list.length) {
    const inFolders = all.filter((i) => folderOf(i)).length;
    el.feedInner.innerHTML = `<div class="empty small"><p>${ui.query ? `Nothing matches “${esc(ui.query)}”.`
      : ui.dtype !== 'all' ? `No ${esc(TYPES.find((x) => x[0] === ui.dtype)[1].toLowerCase())} here. <button class="more-link" data-act="all-types">Show all types</button>`
      : currentFolder() ? 'This folder is empty. Anything you send or drop while it’s open goes into it, or use “Move to folder” on any drop.'
      : inFolders ? 'All tidy — everything is in folders. New drops arrive here.'
      : 'Nothing here yet.'}</p></div>`;
    return;
  }
  const nodes = [];
  const seen = new Set();
  let day = '';
  let group = null;
  for (const it of list) {
    const d = dayLabel(it.created);
    if (d !== day) {
      day = d;
      const h = document.createElement('div');
      h.className = 'day';
      h.textContent = d;
      group = document.createElement('div');
      group.className = ui.layout === 'grid' ? 'tile-grid' : 'row-group';
      nodes.push(h, group);
    }
    group.appendChild(cardNode(it));
    seen.add(it.id);
  }
  for (const id of cards.keys()) if (!seen.has(id)) cards.delete(id);
  el.feedInner.replaceChildren(...nodes);
  if (ui.scrollTop) { el.feed.scrollTop = 0; ui.scrollTop = false; }
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
  const f = folderOf(it);
  const sig = [ui.namesVer || 0, ui.layout, ui.selecting ? 1 : 0, ui.selected.has(it.id) ? 1 : 0, f ? f.data.name : '', ui.dloc,
    it.kind === 'file' && files.isOffline(it.id) ? 'off' : '', it.rev, it.updated, it.data.keep ? 1 : 0,
    prog ? prog.state + (prog.err || '') : '', ui.expanded.has(it.id) ? 1 : 0].join('|');
  const c = cards.get(it.id);
  if (c && c.sig === sig) {
    c.node.classList.toggle('fresh', ui.fresh.has(it.id));
    return c.node;
  }
  const t = document.createElement('template');
  t.innerHTML = ui.layout === 'grid' ? tileHTML(it, prog) : rowHTML(it, prog);
  const node = t.content.firstElementChild;
  node.classList.toggle('fresh', ui.fresh.has(it.id));
  cards.set(it.id, { sig, node });
  return node;
}

function thumbHTML(it) {
  if (it.kind === 'clip') {
    const url = singleUrl(it.data.text || '');
    return `<span class="ti" data-k="${url ? 'link' : 'text'}"><svg class="ic"><use href="#i-${url ? 'link' : 'note'}"/></svg></span>`;
  }
  const d = it.data;
  const kind = fileKind(d.type, d.name);
  if (d.thumb) return `<img src="${esc(d.thumb)}" alt="" draggable="false" decoding="async">${kind === 'video' ? '<span class="mini-play"><svg class="ic" viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg></span>' : ''}`;
  const ext = extOf(d.name);
  return `<span class="ti" data-k="${kind}">${ext && ext.length <= 4 && !['image', 'video', 'audio'].includes(kind) ? `<span class="ext">${esc(ext)}</span>` : `<svg class="ic"><use href="#i-${kindIcon(kind)}"/></svg>`}</span>`;
}

function dropTitle(it) {
  if (it.kind === 'file') return it.data.name || 'File';
  const url = singleUrl(it.data.text || '');
  if (url) return (it.data.link && it.data.link.title) || url.replace(/^https?:\/\/(www\.)?/, '');
  return it.data.text || '';
}

function metaParts(it, prog) {
  const parts = [];
  if (it.kind === 'file') {
    if (prog) {
      if (prog.state === 'err') parts.push(`<span class="err">${esc(prog.err || 'Upload failed')}</span>`);
      else if (prog.state === 'wait') parts.push('Waiting for connection…');
      else parts.push(`Sending <span class="pct">${pct(prog)}%</span>`);
    } else parts.push(esc(fmtBytes(it.data.size)));
  } else {
    const url = singleUrl(it.data.text || '');
    if (url) parts.push(esc((it.data.link && it.data.link.site) || new URL(url).hostname.replace(/^www\./, '')));
  }
  parts.push(esc(deviceLabel(it.device)), clock(it.created));
  const f = folderOf(it);
  let extra = '';
  if (f && ui.dloc !== 'f:' + f.id) extra += `<span class="fchip"><svg class="ic"><use href="#i-folder"/></svg>${esc(f.data.name || 'Folder')}</span>`;
  if (it.kind === 'file' && files.isOffline(it.id)) extra += '<span class="pin-flag off" title="Saved on this device — opens without internet"><svg class="ic"><use href="#i-ondevice"/></svg></span>';
  if (it.data.keep) extra += '<span class="pin-flag" title="Pinned — never cleaned up"><svg class="ic"><use href="#i-pin"/></svg></span>';
  return parts.join('<span class="sep"></span>') + extra;
}

function primaryAction(it, prog) {
  if (it.kind === 'clip') {
    const url = singleUrl(it.data.text || '');
    return url
      ? `<a class="icon-btn act" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open link" title="Open link"><svg class="ic"><use href="#i-link"/></svg></a>`
      : `<button class="icon-btn act" data-act="copy" aria-label="Copy text" title="Copy"><svg class="ic"><use href="#i-copy"/></svg></button>`;
  }
  if (prog) return '';
  const kind = fileKind(it.data.type, it.data.name);
  if (isIOS() && (kind === 'image' || kind === 'video') && files.canShare()) {
    return `<button class="icon-btn act" data-act="share" aria-label="Save to Photos" title="Save"><svg class="ic"><use href="#i-download"/></svg></button>`;
  }
  return `<button class="icon-btn act" data-act="download" aria-label="Download" title="Download"><svg class="ic"><use href="#i-download"/></svg></button>`;
}

function rowHTML(it, prog) {
  const isText = it.kind === 'clip' && !singleUrl(it.data.text || '');
  const expanded = ui.expanded.has(it.id);
  const sel = ui.selected.has(it.id);
  const dr = !isTouch();
  return `<article class="ri${sel ? ' selected' : ''}${ui.selecting ? ' selecting' : ''}" data-id="${it.id}">
    ${ui.selecting ? `<span class="ri-check" aria-hidden="true"><svg class="ic"><use href="#i-check"/></svg></span>` : ''}
    <button class="ri-thumb" data-act="open" aria-label="Open" draggable="${dr}">${thumbHTML(it)}</button>
    <div class="ri-main" data-act="${isText ? 'expand' : 'open'}">
      ${isText && expanded
        ? `<div class="ri-text">${linkify(it.data.text || '')}</div>`
        : `<div class="ri-title${isText ? ' is-text' : ''}" draggable="${dr}" title="${esc(dropTitle(it).slice(0, 300))}">${esc(dropTitle(it).slice(0, 400))}</div>`}
      <div class="ri-meta">${metaParts(it, prog)}</div>
      ${prog && prog.state !== 'err' ? `<div class="progress"><span style="width:${pct(prog)}%"></span></div>` : ''}
    </div>
    <div class="ri-actions">${primaryAction(it, prog)}<button class="icon-btn" data-act="menu" aria-label="More actions"><svg class="ic"><use href="#i-more"/></svg></button></div>
  </article>`;
}

function tileHTML(it, prog) {
  const sel = ui.selected.has(it.id);
  const isText = it.kind === 'clip' && !singleUrl(it.data.text || '');
  return `<article class="tile${sel ? ' selected' : ''}${ui.selecting ? ' selecting' : ''}" data-id="${it.id}">
    <button class="tile-media" data-act="${isText ? 'expand-tile' : 'open'}" aria-label="Open" draggable="${!isTouch()}">
      ${isText ? `<span class="tile-text">${esc((it.data.text || '').slice(0, 220))}</span>` : thumbHTML(it)}
    </button>
    ${ui.selecting ? `<span class="ri-check" aria-hidden="true"><svg class="ic"><use href="#i-check"/></svg></span>` : ''}
    <button class="tile-more icon-btn sm" data-act="menu" aria-label="More actions"><svg class="ic"><use href="#i-more"/></svg></button>
    <div class="tile-name" title="${esc(dropTitle(it).slice(0, 300))}">${esc(dropTitle(it).slice(0, 120))}</div>
    <div class="tile-meta">${it.kind === 'file' && !prog ? esc(fmtBytes(it.data.size)) + ' · ' : ''}${clock(it.created)}</div>
    ${prog && prog.state !== 'err' ? `<div class="progress"><span style="width:${pct(prog)}%"></span></div>` : ''}
  </article>`;
}

const pct = (p) => (p.total ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0);

function updateProgress(id) {
  const c = cards.get(id);
  const p = files.progress.get(id);
  if (!c || !p || p.state !== 'up') { scheduleRender(); renderStatus(); return; }
  const bar = c.node.querySelector('.progress > span');
  const pc = c.node.querySelector('.pct');
  if (!bar) { scheduleRender(); return; }
  bar.style.width = pct(p) + '%';
  if (pc) pc.textContent = pct(p);
}

async function onFeedClick(e) {
  if (ui.suppressClick) { ui.suppressClick = false; e.preventDefault(); return; }
  const a = e.target.closest('[data-act]');
  const card = e.target.closest('[data-id]');
  const it = card && store.items.get(card.dataset.id);
  if (a && a.dataset.act === 'all-types') return setDropType('all');
  if (it && !isTouch() && (e.ctrlKey || e.metaKey || e.shiftKey) && !(a && a.dataset.act === 'menu')) {
    e.preventDefault();
    const order = visibleDrops().map((i) => i.id);
    if (e.shiftKey && ui.lastPicked && order.includes(ui.lastPicked)) {
      const [x, y] = [order.indexOf(ui.lastPicked), order.indexOf(it.id)].sort((p, q) => p - q);
      setSelection(new Set([...ui.selected, ...order.slice(x, y + 1)]));
    } else {
      const next = new Set(ui.selected);
      next.has(it.id) ? next.delete(it.id) : next.add(it.id);
      setSelection(next);
    }
    ui.lastPicked = it.id;
    return;
  }
  if (ui.selecting && it && !(a && a.dataset.act === 'menu')) {
    e.preventDefault();
    toggleSelect(it.id);
    ui.lastPicked = it.id;
    return;
  }
  if (ui.selecting && !it && !a) { exitSelect(); return; }
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'pick') return el.fileInput.click();
  if (act === 'connect') return openConnect();
  if (!it) return;
  if (act === 'copy') {
    await copyText(it.data.text || '');
    toast('Copied');
  } else if (act === 'expand') {
    if (e.target.closest('a')) return;
    ui.expanded.has(it.id) ? ui.expanded.delete(it.id) : ui.expanded.add(it.id);
    renderDrops();
  } else if (act === 'expand-tile') {
    openTextViewer(it);
  } else if (act === 'open') {
    if (it.kind === 'file') openFile(it);
    else if (singleUrl(it.data.text || '')) window.open(singleUrl(it.data.text), '_blank', 'noopener');
    else openTextViewer(it);
  } else if (act === 'download') {
    files.download(it);
  } else if (act === 'share') {
    files.share(it).catch(() => files.download(it));
  } else if (act === 'menu') {
    dropMenu(a, it);
  }
}

function openTextViewer(it) {
  ui.viewing = null;
  el.viewerTitle.textContent = 'Message';
  el.viewerShare.hidden = true;
  el.viewerDownload.hidden = true;
  el.viewerMarkup.hidden = true;
  el.viewerBody.innerHTML = `<pre class="text-view">${linkify(it.data.text || '')}</pre>`;
  openDialog(el.dlgViewer);
}

function dropMenu(anchor, it, at) {
  const m = [];
  if (it.kind === 'clip') {
    const url = singleUrl(it.data.text || '');
    m.push({ icon: 'copy', label: 'Copy text', run: async () => { await copyText(it.data.text); toast('Copied'); } });
    if (De.isAiText(it.data.text || '')) m.push({ icon: 'sparkle', label: 'Copy clean text', run: async () => { await copyText(De.plainText(it.data.text, declutterOpts() || {})); toast('Clean text copied'); } });
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
    if (!p) {
      if (files.isOffline(it.id)) m.push({ icon: 'ondevice', label: 'Remove offline copy', run: () => files.removeOffline(it.id).then(() => toast('Offline copy removed from this device')) });
      else m.push({ icon: 'ondevice', label: 'Keep on this device (offline)', run: async () => {
        toast('Saving for offline use…');
        try { await files.keepOffline(it); toast(`“${it.data.name}” now opens without internet on this device.`); }
        catch { toast('Could not save it for offline use. Check your connection.'); }
      } });
    }
    if (canMarkup(it)) m.splice(1, 0, { icon: 'crop', label: 'Edit (crop / hide details)', run: () => openMarkup(it) });
    if (canEditPdf(it)) m.splice(1, 0, { icon: 'pen', label: 'Edit text', run: () => openPdfEdit(it) });
    if (canEditDoc(it)) m.splice(1, 0, { icon: 'pen', label: 'Edit document', run: () => openDocEdit(it) });
    if (kind === 'image' && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      m.push({ icon: 'copy', label: 'Copy image', run: () => files.copyImage(it).then(() => toast('Image copied')).catch(() => toast('Copy is not supported for this image.')) });
    }
  }
  m.push({ icon: 'folder', label: folderOf(it) ? 'Move to another folder…' : 'Move to folder…', run: () => moveMenu(anchor, [it.id], at) });
  m.push({ icon: 'check', label: 'Select', run: () => { enterSelect(); toggleSelect(it.id); } });
  m.push({ icon: 'pin', label: it.data.keep ? 'Unpin' : 'Pin (never auto-delete)', run: () => { it.data = { ...it.data, keep: !it.data.keep }; store.save(it).then(() => sync.schedule()); } });
  m.push({ icon: 'trash', label: 'Move to Trash', danger: true, run: () => deleteWithUndo(it, it.kind === 'clip' ? 'Message' : 'File') });
  openMenu(anchor, m, { at });
}

/* ───────── drag a box across empty space to select drops (mouse) ───────── */

function initMarquee() {
  const feed = el.feed;
  let st = null;
  feed.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || ui.tab !== 'drops') return;
    if (e.target.closest('button, a, input, textarea, [draggable="true"], .ri-text, .empty')) return;
    const fr = feed.getBoundingClientRect();
    if (e.clientX > fr.right - 14) return; // scrollbar
    st = {
      x: e.clientX - fr.left + feed.scrollLeft,
      y: e.clientY - fr.top + feed.scrollTop,
      cx: e.clientX,
      cy: e.clientY,
      base: e.ctrlKey || e.metaKey || e.shiftKey ? new Set(ui.selected) : new Set(),
      active: false
    };
  });
  addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.cx, e.clientY - st.cy) < 6) return;
      st.active = true;
      el.app.classList.add('marquee-on');
      try { getSelection().removeAllRanges(); } catch {}
      st.box = document.createElement('div');
      st.box.className = 'marquee';
      feed.appendChild(st.box);
      if (!ui.selecting) {
        ui.selecting = true;
        ui.selected = new Set(st.base);
        el.app.classList.add('selecting');
        renderDrops();
      }
    }
    e.preventDefault();
    const fr = feed.getBoundingClientRect();
    if (e.clientY > fr.bottom - 36) feed.scrollTop += 18;
    else if (e.clientY < fr.top + 36) feed.scrollTop -= 18;
    const x = Math.max(0, Math.min(e.clientX - fr.left, fr.width)) + feed.scrollLeft;
    const y = Math.max(0, Math.min(e.clientY - fr.top, fr.height)) + feed.scrollTop;
    const L = Math.min(st.x, x);
    const T = Math.min(st.y, y);
    const R = Math.max(st.x, x);
    const B = Math.max(st.y, y);
    Object.assign(st.box.style, { left: `${L}px`, top: `${T}px`, width: `${R - L}px`, height: `${B - T}px` });
    const sel = new Set(st.base);
    for (const [id, c] of cards) {
      if (!c.node.isConnected) continue;
      const r = c.node.getBoundingClientRect();
      const l = r.left - fr.left + feed.scrollLeft;
      const t = r.top - fr.top + feed.scrollTop;
      if (l < R && l + r.width > L && t < B && t + r.height > T) sel.add(id);
    }
    for (const [id, c] of cards) c.node.classList.toggle('selected', sel.has(id));
    ui.selected = sel;
    renderSelectBar();
  });
  const end = () => {
    if (!st) return;
    const was = st.active;
    if (st.box) st.box.remove();
    st = null;
    el.app.classList.remove('marquee-on');
    if (!was) return;
    ui.suppressClick = true; // the click that ends a drag shouldn't open anything
    setTimeout(() => { ui.suppressClick = false; }, 0);
    if (!ui.selected.size) exitSelect();
    else { renderSelectBar(); renderDrops(); }
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}

/* ───────── photo markup: cover / draw over sensitive details ───────── */

function canMarkup(it) {
  return it && it.kind === 'file' && !it.data.parent && !files.progress.get(it.id) &&
    fileKind(it.data.type, it.data.name) === 'image' && !/svg/i.test(it.data.type || '');
}

async function openMarkup(it) {
  let blob = null;
  try { blob = await files.blobOf(it); } catch {}
  if (!blob) { toast('Could not load this photo. Check your connection and try again.'); return; }
  let res;
  try { res = await markup.open(blob, it.data.type || blob.type, openDialog); }
  catch { toast('This image type can’t be edited here.'); return; }
  if (!res) return;
  await saveEdited(it, res.blob, res.keep);
}

/** Store an edited version: replaces the original in place (and deletes it everywhere), or adds a copy */
async function saveEdited(it, blob, keepOriginal, newName) {
  const res = { blob, keep: keepOriginal };
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' }[res.blob.type] || 'png';
  const base = String(it.data.name || 'file').replace(/\.[a-z0-9]{2,5}$/i, '');
  const sameExt = new RegExp(`\\.(${ext === 'jpg' ? 'jpe?g' : ext})$`, 'i').test(it.data.name || '');
  const name = newName || (sameExt ? it.data.name : `${base}.${ext}`);
  const file = new File([res.blob], name, { type: res.blob.type });
  const f = folderOf(it);
  const added = await files.add([file], res.keep
    ? { folder: f && f.id }
    : { folder: f && f.id, created: it.created, keep: !!it.data.keep });
  if (!added.length) return;
  if (ui.viewing && ui.viewing.id === it.id) el.dlgViewer.close();
  if (!res.keep) {
    await deleteForever(it.id);
    toast('Saved. The old version is deleted from every device.');
  } else toast('Saved as a new copy. The original is unchanged.');
  scheduleRender(true, false);
}

/* ───────── PDF text editing ───────── */

function canEditPdf(it) {
  return it && it.kind === 'file' && !it.data.parent && !files.progress.get(it.id) && fileKind(it.data.type, it.data.name) === 'pdf';
}

async function openPdfEdit(it) {
  let blob = null;
  try { blob = await files.blobOf(it); } catch {}
  if (!blob) { toast('Could not load this PDF. Check your connection and try again.'); return; }
  try {
    const { pdfSource } = await import('./docview.js');
    const html = await pdfSource(blob);
    if (html) { editDocument(it, { kind: 'html', html }); return; }
  } catch {}
  toast('Opening the PDF editor…', { duration: 1500 });
  let res;
  try {
    if (!pdfEditor) {
      const { PdfEditor } = await import('./pdfedit.js');
      pdfEditor = new PdfEditor(el.dlgPdf);
    }
    res = await pdfEditor.open(blob, it.data.name, openDialog);
  } catch (e) {
    toast(e && e.message === 'password' ? 'This PDF is password-protected, so it can’t be edited here.' : 'Could not open this PDF for editing.');
    return;
  }
  if (!res) return;
  await saveEdited(it, res.blob, res.keep);
}

/* ───────── documents: view in the app, write / edit Word & PDF ───────── */

const DOC_EXT = /\.(pdf|docx|docm|dotx|xlsx|xlsm|csv|tsv|pptx)$/i;
function docKindOf(kind, name) {
  if (kind === 'pdf') return 'pdf';
  const m = DOC_EXT.exec(name || '');
  if (!m) return null;
  const e = m[1].toLowerCase();
  return e === 'pdf' ? 'pdf' : /^do/.test(e) ? 'docx' : /^xls/.test(e) ? 'xlsx' : /sv$/.test(e) ? 'csv' : 'pptx';
}
function canEditDoc(it) {
  return it && it.kind === 'file' && !it.data.parent && !files.progress.get(it.id) && /\.docx$/i.test(it.data.name || '');
}

async function openDocViewer(it, dk) {
  ui.viewing = it;
  ui.docSource = null;
  el.viewerDownload.hidden = false;
  el.viewerTitle.textContent = it.data.name;
  el.viewerShare.hidden = !files.canShare();
  el.viewerMarkup.hidden = !(dk === 'pdf' ? canEditPdf(it) : canEditDoc(it));
  if (files.canShare()) files.prefetch(it);
  if (ui.zoom) { ui.zoom.destroy(); ui.zoom = null; }
  el.viewerBody.classList.remove('is-zoom');
  el.viewerBody.classList.add('is-docv');
  el.viewerBody.innerHTML = `<div class="dv-host"><div class="dv-loading">Opening…</div></div>
    <div class="zoom-bar" role="group" aria-label="Zoom">
      <button data-zoom="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
      <button class="zoom-pct" data-zoom="fit" title="Fit to the screen">Fit</button>
      <button data-zoom="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
    </div>`;
  openDialog(el.dlgViewer);
  const host = el.viewerBody.querySelector('.dv-host');
  const pct = el.viewerBody.querySelector('.zoom-pct');
  let blob = null;
  try { blob = await files.blobOf(it); } catch {}
  if (ui.viewing !== it) return;
  if (!blob) { host.innerHTML = '<div class="dv-empty">Could not load this file. Check your connection.</div>'; return; }
  try {
    const { viewDocument } = await import('./docview.js');
    const ctl = await viewDocument(host, blob, { kind: dk, onLabel: (t) => { pct.textContent = t; } });
    if (ui.viewing !== it) { ctl.destroy(); return; }
    ui.zoom = ctl;
    ui.docSource = ctl.source || null;
  } catch (e) {
    console.warn('view document', e);
    if (ui.viewing === it) host.innerHTML = '<div class="dv-empty">This file can’t be shown here. Use Download to open it.</div>';
  }
}

async function getDocEditor() {
  if (!docEditor) {
    const { DocEditor } = await import('./docedit.js');
    docEditor = new DocEditor(el.dlgDoc);
  }
  return docEditor;
}

async function newDocument() {
  let res;
  try { res = await (await getDocEditor()).open(null, 'Untitled document', 'docx', openDialog); }
  catch (e) { console.warn(e); toast('Could not open the document editor.'); return; }
  if (!res) return;
  const added = await files.add([new File([res.blob], res.name, { type: res.blob.type })], { folder: currentFolder() });
  if (added.length) toast(`Saved “${res.name}”.`);
  scheduleRender(true, false);
}

async function editDocument(it, src) {
  const fmt = src.kind === 'docx' ? 'docx' : 'pdf';
  let res;
  try { res = await (await getDocEditor()).open(src, it.data.name, fmt, openDialog); }
  catch (e) { console.warn(e); toast('Could not open this document for editing.'); return; }
  if (!res) return;
  if (ui.viewing && ui.viewing.id === it.id) el.dlgViewer.close();
  if (res.format === fmt) await saveEdited(it, res.blob, false, res.name);
  else {
    const f = folderOf(it);
    await files.add([new File([res.blob], res.name, { type: res.blob.type })], { folder: f && f.id });
    toast(`Saved as a new file “${res.name}”.`);
    scheduleRender(true, false);
  }
}

async function openDocEdit(it) {
  let blob = null;
  try { blob = await files.blobOf(it); } catch {}
  if (!blob) { toast('Could not load this document. Check your connection and try again.'); return; }
  await editDocument(it, { kind: 'docx', bytes: new Uint8Array(await blob.arrayBuffer()) });
}

/* ───────── refresh: fresh connection + sync now ───────── */

async function refreshNow() {
  if (ui.refreshing) return;
  ui.refreshing = true;
  el.btnRefresh.classList.add('spinning');
  el.btnRefresh.disabled = true;
  const t0 = Date.now();
  let ok = false;
  try { ok = navigator.onLine && (await sync.refresh()); } catch {}
  files.resumeAll();
  await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))));
  el.btnRefresh.classList.remove('spinning');
  el.btnRefresh.disabled = false;
  ui.refreshing = false;
  renderAll();
  toast(ok ? 'Up to date' : !navigator.onLine ? 'You’re offline. Everything syncs when you’re back online.' : 'Could not reach SyncPad. Try again in a moment.');
}

/* ───────── collage: many photos in one picture ───────── */

function selectedPhotos() {
  return [...ui.selected].map((id) => store.items.get(id)).filter((it) => canMarkup(it) && !it.data.trashed);
}

async function makeCollage() {
  const list = selectedPhotos();
  if (list.length < 2) { toast('Select 2 or more photos for a collage.'); return; }
  if (list.length > 30) { toast('A collage can hold up to 30 photos.'); return; }
  toast(`Loading ${list.length} photos…`);
  const blobs = [];
  for (const it of list) {
    let b = null;
    try { b = await files.blobOf(it); } catch {}
    if (!b) { toast('Could not load all photos. Check your connection and try again.'); return; }
    blobs.push(b);
  }
  let res;
  try { res = await collage.open(blobs, openDialog); }
  catch { toast('These photos can’t be put in a collage here.'); return; }
  if (!res) return;
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const name = `Collage ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.jpg`;
  const added = await files.add([new File([res.blob], name, { type: 'image/jpeg' })], { folder: currentFolder() });
  if (!added.length) return;
  exitSelect();
  if (res.trash) {
    const t = Date.now();
    for (const it of list) { it.data = { ...it.data, trashed: t }; await store.save(it); }
    sync.schedule();
    toast(`Collage saved. ${list.length} photos moved to Trash.`, {
      action: 'Undo', duration: 6000,
      onAction: async () => { for (const it of list) await restoreItem(it.id); }
    });
  } else toast('Collage saved.');
  scheduleRender(true, false);
}

/* ───────── right-click menus ───────── */

function onFeedContext(e) {
  if (e.shiftKey) return;
  if (ui.lastPointer === 'touch') { e.preventDefault(); return; } // a long press selects instead
  const picked = String(getSelection() || '');
  if (picked && e.target.closest('.ri-text')) return; // keep "Copy" for selected text
  e.preventDefault();
  const at = { x: e.clientX, y: e.clientY };
  ui.ctxAt = at;
  const card = e.target.closest('[data-id]');
  const it = card && store.items.get(card.dataset.id);
  if (!it) {
    openMenu(null, [
      { icon: 'clip', label: 'Send files…', run: () => el.fileInput.click() },
      { icon: 'doc', label: 'New document…', run: newDocument },
      { icon: 'folder', label: 'New folder…', run: async () => { const f = await createFolder(); if (f) setDropView('f:' + f.id); } },
      { icon: 'check', label: 'Select all', run: () => setSelection(new Set(visibleDrops().map((i) => i.id))) }
    ], { at });
    return;
  }
  if (ui.selecting && ui.selected.has(it.id) && ui.selected.size > 1) {
    const n = ui.selected.size;
    openMenu(null, [
      ...(selectedPhotos().length >= 2 ? [{ icon: 'grid', label: `Make a collage (${selectedPhotos().length} photos)`, run: makeCollage }] : []),
      { icon: 'folder', label: `Move ${n} to folder…`, run: () => moveMenu(null, [...ui.selected], at) },
      { icon: 'download', label: `Download ${n}`, run: () => selAction('download') },
      { icon: 'trash', label: `Move ${n} to Trash`, danger: true, run: () => selAction('trash') },
      { icon: 'x', label: 'Clear selection', run: exitSelect }
    ], { at });
    return;
  }
  if (ui.selecting) exitSelect();
  const node = cards.get(it.id) && cards.get(it.id).node;
  dropMenu(null, it, at);
  if (node) { node.classList.add('ctx'); ui.ctxNode = node; }
}

function onSideContext(e) {
  if (ui.lastPointer === 'touch') { e.preventDefault(); return; }
  const f = e.target.closest('[data-folder-drop]');
  if (!f || e.shiftKey) return;
  e.preventDefault();
  folderMenu(null, f.dataset.folderDrop, { x: e.clientX, y: e.clientY });
}

function onNoteListContext(e) {
  if (ui.lastPointer === 'touch') { e.preventDefault(); return; }
  const b = e.target.closest('.note-item');
  if (!b || e.shiftKey) return;
  e.preventDefault();
  const n = store.items.get(b.dataset.id);
  if (!n) return;
  b.classList.add('ctx');
  ui.ctxNode = b;
  openMenu(null, [
    { icon: 'note', label: 'Open', run: () => openNote(n.id) },
    { icon: 'pin', label: n.data.pinned ? 'Unpin' : 'Pin to top', run: () => { n.data = { ...n.data, pinned: !n.data.pinned }; store.save(n).then(() => { sync.schedule(); if (ui.noteId === n.id) renderEditor(false); }); } },
    { icon: 'copy', label: 'Copy text', run: async () => { await copyText(noteText(n)); toast('Copied'); } },
    { icon: 'trash', label: 'Move to Trash', danger: true, run: () => deleteWithUndo(n, 'Note') }
  ], { at: { x: e.clientX, y: e.clientY } });
}

/* ───────── folders ───────── */

async function createFolder() {
  const name = await promptDialog('New folder', 'e.g. School, Receipts, Photos', '');
  if (!name) return null;
  const now = Date.now();
  const f = { id: rid(16), kind: 'folder', rev: 0, created: now, updated: now, device: me(), data: { name: name.slice(0, 60) } };
  await store.save(f);
  sync.schedule();
  return f;
}
async function renameFolder(id) {
  const f = store.items.get(id);
  if (!f) return;
  const name = await promptDialog('Rename folder', 'Folder name', f.data.name || '');
  if (!name || name === f.data.name) return;
  f.data = { ...f.data, name: name.slice(0, 60) };
  await store.save(f);
  sync.schedule();
}
async function deleteFolder(id) {
  const f = store.items.get(id);
  if (!f) return;
  const n = dropItems().filter((i) => i.data.folder === id).length;
  const ok = await confirmDialog(`Delete the folder “${f.data.name}”?`, n ? `The ${n} item${n === 1 ? '' : 's'} inside stay${n === 1 ? 's' : ''} in All drops.` : 'It is empty.', 'Delete folder', true);
  if (!ok) return;
  if (ui.dloc === 'f:' + id) ui.dloc = 'home';
  await store.remove(f);
  sync.schedule();
  renderDrops();
}
function folderMenu(anchor, id = currentFolder(), at) {
  if (!id) return;
  const items = [
    { icon: 'note', label: 'Rename folder', run: () => renameFolder(id) },
    { icon: 'trash', label: 'Delete folder', danger: true, run: () => deleteFolder(id) }
  ];
  if (at && ui.dloc !== 'f:' + id) items.unshift({ icon: 'folder', label: 'Open', run: () => setDropView('f:' + id) });
  openMenu(anchor, items, { at });
}
function moveMenu(anchor, ids, at) {
  const items = folders().map((f) => ({ icon: 'folder', label: f.data.name || 'Folder', run: () => moveTo(ids, f.id) }));
  if (ids.some((id) => { const it = store.items.get(id); return it && folderOf(it); })) items.push({ icon: 'drops', label: 'Take out of folder', run: () => moveTo(ids, null) });
  items.push({ icon: 'plus', label: 'New folder…', run: async () => { const f = await createFolder(); if (f) moveTo(ids, f.id); } });
  openMenu(anchor, items, { at });
}
async function moveTo(ids, folderId) {
  let n = 0;
  for (const id of ids) {
    const it = store.items.get(id);
    if (!it || (it.data.folder || null) === folderId) continue;
    const { folder, ...rest } = it.data;
    it.data = folderId ? { ...rest, folder: folderId } : rest;
    await store.save(it);
    n++;
  }
  sync.schedule();
  exitSelect();
  const f = folderId && store.items.get(folderId);
  if (n) toast(f ? `Moved ${n} item${n === 1 ? '' : 's'} to “${f.data.name}”` : `Took ${n} item${n === 1 ? '' : 's'} out of the folder`);
}

/* ───────── selecting several drops ───────── */

function enterSelect() {
  if (ui.selecting) return;
  ui.selecting = true;
  ui.selected.clear();
  el.app.classList.add('selecting');
  renderSelectBar();
  renderDrops();
}
function exitSelect() {
  if (!ui.selecting) return;
  ui.selecting = false;
  ui.selected.clear();
  el.app.classList.remove('selecting');
  renderSelectBar();
  renderDrops();
}
function setSelection(set) {
  ui.selected = set;
  if (!ui.selecting && set.size) {
    ui.selecting = true;
    el.app.classList.add('selecting');
  }
  renderSelectBar();
  renderDrops();
}
function toggleSelect(id) {
  ui.selected.has(id) ? ui.selected.delete(id) : ui.selected.add(id);
  renderSelectBar();
  renderDrops();
}
function renderSelectBar() {
  el.selectBar.hidden = !ui.selecting;
  el.composer.hidden = ui.selecting;
  el.btnSelect.textContent = ui.selecting ? 'Done' : 'Select';
  const n = ui.selected.size;
  el.selCount.textContent = n ? `${n} selected` : 'Tap items to select';
  for (const b of $$('[data-sel]', el.selectBar)) if (!['cancel', 'all'].includes(b.dataset.sel)) b.disabled = !n;
  $('[data-sel="collage"]', el.selectBar).hidden = selectedPhotos().length < 2;
}
async function onSelectBar(e) {
  const b = e.target.closest('[data-sel]');
  if (b) selAction(b.dataset.sel, b);
}
async function selAction(act, b) {
  const ids = [...ui.selected].filter((id) => store.items.has(id));
  if (act === 'cancel') return exitSelect();
  if (act === 'all') {
    const visible = visibleDrops().map((i) => i.id);
    const allOn = visible.every((id) => ui.selected.has(id));
    ui.selected = new Set(allOn ? [] : visible);
    renderSelectBar();
    renderDrops();
    return;
  }
  if (!ids.length) return;
  if (act === 'move') moveMenu(b, ids);
  else if (act === 'collage') makeCollage();
  else if (act === 'download') {
    const fl = ids.map((id) => store.items.get(id)).filter((i) => i && i.kind === 'file');
    for (const it of fl) { files.download(it); await new Promise((r) => setTimeout(r, 350)); }
    if (!fl.length) toast('Only files can be downloaded.');
    exitSelect();
  } else if (act === 'trash') {
    for (const id of ids) {
      const it = store.items.get(id);
      if (!it) continue;
      it.data = { ...it.data, trashed: Date.now() };
      await store.save(it);
    }
    sync.schedule();
    exitSelect();
    toast(`${ids.length} item${ids.length === 1 ? '' : 's'} moved to Trash`, {
      action: 'Undo', duration: 6000,
      onAction: async () => { for (const id of ids) await restoreItem(id); }
    });
  }
}

function promptDialog(title, placeholder, value) {
  return new Promise((resolve) => {
    el.promptTitle.textContent = title;
    el.promptInput.placeholder = placeholder;
    el.promptInput.value = value || '';
    let result = null;
    el.promptForm.onsubmit = (e) => { e.preventDefault(); result = el.promptInput.value.trim() || null; el.dlgPrompt.close(); };
    el.dlgPrompt.addEventListener('close', () => resolve(result), { once: true });
    openDialog(el.dlgPrompt);
    setTimeout(() => { el.promptInput.focus(); el.promptInput.select(); }, 30);
  });
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

async function sendClip(text, folder = currentFolder()) {
  const now = Date.now();
  const data = { text };
  if (folder) data.folder = folder;
  const item = { id: rid(16), kind: 'clip', rev: 0, created: now, updated: now, device: me(), data };
  ui.scrollTop = true;
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

async function sendFiles(list, folder) {
  if (!list.length) return;
  setTab('drops');
  ui.scrollTop = true;
  const items = await files.add(list, { folder: folder === undefined ? currentFolder() : folder });
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
    .filter((n) => !n.data.trashed)
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
      <div class="t">${n.data.pinned ? '<svg class="ic"><use href="#i-pin"/></svg>' : ''}${n.data.canvas ? '<svg class="ic"><use href="#i-canvas"/></svg>' : ''}<span>${esc(noteTitle(noteText(n)))}</span></div>
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

function newNote(opts) {
  const canvas = !!(opts && opts.canvas);
  if (ui.tab !== 'notes') setTab('notes');
  const now = Date.now();
  ui.newNote = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { html: '', text: '', pinned: false, ...(canvas ? { canvas: { v: 1, items: [] } } : {}) } };
  openNote(ui.newNote.id, { focus: false });
  if (!canvas) focusEditorEnd();
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
  if (n && store.items.has(n.id) && !noteText(n).trim() && !/data-file/.test(n.data.html || '') && !(n.data.canvas && n.data.canvas.items.length)) {
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
  let n = openNoteItem();
  if (n && n.data.trashed) {
    if (isMobileLayout() && el.app.classList.contains('editing')) closeEditor();
    ui.noteId = null;
    n = null;
  }
  if (!n) {
    el.editor.hidden = true;
    el.editorEmpty.hidden = false;
    return;
  }
  el.editor.hidden = false;
  el.editorEmpty.hidden = true;
  const ed = el.editorText;
  const isCanvas = !!n.data.canvas;
  el.editor.classList.toggle('is-canvas', isCanvas);
  el.noteCanvas.hidden = el.cvBar.hidden = !isCanvas;
  el.fmtBar.hidden = isCanvas;
  if (isCanvas) {
    const cv = getCanvas();
    const key = JSON.stringify(n.data.canvas);
    if (force) {
      if (ui.imgTools) ui.imgTools.select(null);
      setEditorHtml('');
      cv.load(n.data.canvas);
      cv.scroll.scrollTop = 0;
      ui.loadedCanvas = key;
      ui.dirty = false;
    } else if (!ui.dirty && !cv.editing && !store.outbox.has(n.id) && key !== ui.loadedCanvas) {
      cv.load(n.data.canvas, true);
      ui.loadedCanvas = key;
    }
    applyZoom();
  } else if (force) {
    if (ui.canvas) { ui.canvas.load({ items: [] }); applyZoom(); }
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
  const cn = openNoteItem();
  const t = cn && cn.data.canvas ? cn.data.text || '' : el.editorText.innerText || '';
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
  if (n.data.canvas) { await saveCanvas(n); return; }
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

async function saveCanvas(n) {
  if (!ui.canvas) { ui.dirty = false; return; }
  const canvas = ui.canvas.data();
  for (const o of canvas.items) if (o.t === 'text') o.html = sanitizeNote(o.html || '');
  ui.dirty = false;
  const key = JSON.stringify(canvas);
  const exists = store.items.has(n.id);
  if (exists && key === JSON.stringify(n.data.canvas)) { renderSaveState(); return; }
  if (!exists && !canvas.items.length) { renderSaveState(); return; }
  const { html, text } = canvasFallback(canvas, sanitizeNote);
  const { body, ...rest } = n.data;
  n.data = { ...rest, canvas, html, text };
  ui.loadedCanvas = key;
  await store.save(n);
  if (ui.newNote && ui.newNote.id === n.id) ui.newNote = null;
  sync.schedule();
  renderSaveState();
  renderFoot();
}

/* ───── privacy: hide the notes list, present one note full screen ───── */
function applyNotesList() {
  let hidden = false;
  try { hidden = localStorage.getItem('sp-notes-list') === 'hidden'; } catch {}
  el.app.classList.toggle('notes-hidden', hidden);
  el.btnToggleList.setAttribute('aria-pressed', String(hidden));
  el.btnToggleList.title = hidden ? 'Show the notes list (Ctrl+\\)' : 'Hide the notes list (Ctrl+\\)';
  el.btnToggleList.setAttribute('aria-label', hidden ? 'Show the notes list' : 'Hide the notes list');
  if (ui.canvas) ui.canvas.layout();
}
function toggleNotesList(hide) {
  const now = el.app.classList.contains('notes-hidden');
  const next = hide == null ? !now : hide;
  try { localStorage.setItem('sp-notes-list', next ? 'hidden' : 'shown'); } catch {}
  applyNotesList();
}
function startPresent() {
  const n = openNoteItem();
  if (!n || ui.presenting) return;
  closeMenu();
  saveNote.flush();
  ui.presenting = true;
  if (ui.imgTools) ui.imgTools.select(null);
  for (const t of $$('.toast', el.toasts)) t.remove();
  el.app.classList.add('presenting');
  let bar = $('.present-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'present-bar';
    bar.innerHTML = '<button class="zo" aria-label="Smaller">A−</button><button class="zv" title="Reset zoom"></button><button class="zi" aria-label="Bigger">A+</button>' +
      '<button class="px" aria-label="Stop presenting"><svg class="ic"><use href="#i-x"/></svg><span>Exit</span></button>';
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('zo')) el.btnZoomOut.click();
      else if (b.classList.contains('zi')) el.btnZoomIn.click();
      else if (b.classList.contains('zv')) el.btnZoomReset.click();
      else stopPresent();
    });
    document.body.appendChild(bar);
    const wake = () => {
      if (!ui.presenting) return;
      bar.classList.add('show');
      el.app.classList.remove('idle');
      clearTimeout(ui.presentIdle);
      ui.presentIdle = setTimeout(() => { bar.classList.remove('show'); el.app.classList.add('idle'); }, 2500);
    };
    // typing doesn't bring the bars back; moving the mouse or tapping does
    for (const ev of ['pointermove', 'pointerdown', 'wheel']) addEventListener(ev, wake, { passive: true });
    ui.presentWake = wake;
  }
  bar.hidden = false;
  ui.presentWake();
  applyZoom();
  ui.presentFs = false;
  const root = document.documentElement;
  if (root.requestFullscreen) root.requestFullscreen({ navigationUI: 'hide' }).then(() => { ui.presentFs = true; }).catch(() => {});
  pushLayer({ key: 'present', close: () => stopPresent(true) });
  if (ui.canvas && n.data.canvas) requestAnimationFrame(() => ui.canvas.layout());
  else if (!isTouch()) focusEditorEnd();
}
function stopPresent(fromLayer = false) {
  if (!ui.presenting) return;
  ui.presenting = false;
  el.app.classList.remove('presenting', 'idle');
  const bar = $('.present-bar');
  if (bar) bar.hidden = true;
  clearTimeout(ui.presentIdle);
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  ui.presentFs = false;
  if (!fromLayer) closeLayer('present');
  if (ui.canvas) requestAnimationFrame(() => ui.canvas.layout());
}

/* ───── canvas notes ───── */
function canvasOpen() { return !!(ui.canvas && !el.noteCanvas.hidden && ui.tab === 'notes'); }
function getCanvas() {
  if (ui.canvas) return ui.canvas;
  ui.canvas = new NoteCanvas({
    host: el.noteCanvas,
    bar: el.cvBar,
    fileSrc: (id) => files.src(id),
    sanitize: sanitizeNote,
    cleanText: (text, html) => { const o = declutterOpts(); return o && De.isAiText(text, html) ? De.plainText(text, o) : text; },
    menu: (at, items) => openMenu(null, items, { at }),
    upload: async (list) => {
      let n = openNoteItem();
      if (!n) return [];
      if (!store.items.has(n.id)) { await saveCanvasNow(n); n = openNoteItem(); }
      const items = await files.add(list, { parent: n.id });
      return Promise.all(items.map(async (it) => ({ id: it.id, ...(await imageSize(it.id)) })));
    },
    onChange: () => { ui.dirty = true; renderSaveState(); saveNote(); }
  });
  ui.canvas.onZoom = () => applyZoom();
  return ui.canvas;
}
async function saveCanvasNow(n) {
  // a brand-new canvas must exist before pictures can be attached to it
  n.data = { ...n.data, canvas: ui.canvas.data() };
  await store.save(n);
  if (ui.newNote && ui.newNote.id === n.id) ui.newNote = null;
  sync.schedule();
}
function imageSize(id) {
  return new Promise((resolve) => {
    const im = new Image();
    const done = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done({ w: 4, h: 3 }), 4000);
    im.onload = () => done({ w: im.naturalWidth || 4, h: im.naturalHeight || 3 });
    im.onerror = () => done({ w: 4, h: 3 });
    im.src = files.src(id);
  });
}
async function turnIntoCanvas() {
  const n = openNoteItem();
  if (!n || n.data.canvas) return;
  saveNote.flush();
  const before = { ...n.data };
  const canvas = await canvasFromHtml(sanitizeNote(el.editorText.innerHTML), { imageSize });
  const cv = getCanvas();
  n.data = { ...n.data, canvas };
  renderEditor(true);
  // stack the blocks from top to bottom now that their real heights are known
  let y = 70;
  for (const o of cv.items) { o.y = y; y += (o.h || 40) + 24; }
  cv.renderAll();
  ui.dirty = true;
  await saveCanvas(n);
  renderNotesList();
  toast('Now a canvas: drag anything anywhere', { action: 'Undo', duration: 6000, onAction: async () => {
    if (ui.noteId !== n.id) return;
    n.data = before;
    await store.save(n);
    sync.schedule();
    renderEditor(true);
    renderNotesList();
  } });
}
async function turnIntoPage() {
  const n = openNoteItem();
  if (!n || !n.data.canvas) return;
  const lose = n.data.canvas.items.some((o) => o.t === 'shape' || o.t === 'line' || o.t === 'pen');
  if (lose && !(await confirmDialog('Turn into a normal note?', 'Text, pictures and emojis are kept in order from top to bottom. Shapes, arrows and drawings are removed (Version history keeps this canvas).', 'Turn into note'))) return;
  saveNote.flush();
  const { html, text } = canvasFallback(n.data.canvas, sanitizeNote);
  const { canvas, ...rest } = n.data;
  n.data = { ...rest, html, text };
  await store.save(n, { snap: true });
  sync.schedule();
  renderEditor(true);
  renderNotesList();
}

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
  const text = () => (n.data.canvas ? n.data.text || '' : el.editorText.innerText || '').trim();
  const m = [
    { icon: 'copy', label: 'Copy text', run: async () => { await copyText(text()); toast('Copied'); } },
    { icon: 'drops', label: 'Send as a drop', run: () => { sendClip(text()); toast('Sent to Drops'); } },
    { icon: 'present', label: 'Present (full screen)', run: startPresent },
    n.data.canvas
      ? { icon: 'note', label: 'Turn into normal note', run: turnIntoPage }
      : { icon: 'canvas', label: 'Turn into canvas', run: turnIntoCanvas },
    ...(n.data.canvas ? [] : [{ icon: 'sparkle', label: 'De-clutter text', run: declutterNote }]),
    { icon: 'download', label: 'Download (keeps colours)', run: downloadNote }
  ];
  if (store.items.has(n.id)) m.splice(2, 0, { icon: 'history', label: 'Version history', run: openHistory });
  if (navigator.share && isTouch()) m.push({ icon: 'share', label: 'Share…', run: () => navigator.share({ text: text() }).catch(() => {}) });
  if (store.items.has(n.id)) m.push({ icon: 'trash', label: 'Move to Trash', danger: true, run: () => deleteWithUndo(n, 'Note') });
  openMenu(anchor, m);
}

function downloadNote() {
  const dn = openNoteItem();
  let clone = el.editorText.cloneNode(true);
  if (dn && dn.data.canvas) { clone = document.createElement('div'); clone.innerHTML = sanitizeNote(dn.data.html || ''); }
  for (const img of $$('img[data-file]', clone)) img.src = location.origin + files.url(img.dataset.file);
  for (const a of $$('a[data-file]', clone)) { a.href = location.origin + files.url(a.dataset.file, true); a.removeAttribute('contenteditable'); }
  const title = noteTitle((dn && dn.data.canvas ? dn.data.text : el.editorText.innerText) || '');
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:16px/1.65 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#16181d}img{max-width:100%;border-radius:10px}
table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}img[data-align=left]{float:left;margin:4px 16px 8px 0}img[data-align=right]{float:right;margin:4px 0 8px 16px}img[data-align=center]{display:block;margin:8px auto}img[data-align=full]{width:100%}ul[data-checklist]{list-style:none;padding-left:0}ul[data-checklist] li::before{content:"☐ "}ul[data-checklist] li[data-checked="true"]::before{content:"☑ "}
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
  if (f && f.tagName !== 'IMG') {
    const it = store.items.get(f.dataset.file);
    if (it) { e.preventDefault(); openFile(it); }
    return;
  }
  const a = e.target.closest('a[href]');
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
}

async function attachToNote(list, point, at) {
  if (!list.length) return;
  let n = openNoteItem();
  if (!n) { newNote(); n = openNoteItem(); }
  if (n.data.canvas && canvasOpen()) { ui.canvas.addFiles(list, at && ui.canvas.pt(at)); return; }
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
  const o = declutterOpts();
  if (o && text && De.isAiText(text, html)) {
    const out = noteFromAi(text, html, o);
    if (out && out.replace(/<[^>]+>/g, '').trim()) {
      const sel = getSelection();
      if (sel.rangeCount && el.editorText.contains(sel.anchorNode)) {
        // remember where the paste went, so Undo can put the original back there
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const mark = document.createElement('span');
        mark.setAttribute('data-pmark', '');
        r.insertNode(mark);
        const snapshot = el.editorText.innerHTML;
        const at = document.createRange();
        at.setStartBefore(mark);
        at.collapse(true);
        mark.remove();
        sel.removeAllRanges();
        sel.addRange(at);
        document.execCommand('insertHTML', false, out);
        onEditorInput();
        const noteId = ui.noteId;
        cleanedToast(() => {
          if (ui.noteId !== noteId) return;
          setEditorHtml(snapshot);
          const m = el.editorText.querySelector('[data-pmark]');
          if (m) {
            el.editorText.focus();
            const r2 = document.createRange();
            r2.setStartBefore(m);
            r2.collapse(true);
            m.remove();
            const s2 = getSelection();
            s2.removeAllRanges();
            s2.addRange(r2);
            if (html) document.execCommand('insertHTML', false, sanitizePaste(html));
            else document.execCommand('insertText', false, text);
          }
          onEditorInput();
        });
        return;
      }
    }
  }
  if (html) document.execCommand('insertHTML', false, sanitizePaste(html));
  else if (text) document.execCommand('insertText', false, text);
  onEditorInput();
}

/* ───── De-clutter: clean text copied from AI chats (no API, on this device) ───── */
function declutterOpts() {
  if (ui.rawPasteUntil && Date.now() < ui.rawPasteUntil) { ui.rawPasteUntil = 0; return null; }
  const st = store.items.get('settings');
  const v = (st && st.data.declutter) || 'on';
  return v === 'off' ? null : { punct: v === 'plain' };
}
function cleanedToast(undo) {
  for (const t of $$('.toast', el.toasts)) if (t.firstElementChild && t.firstElementChild.textContent === 'Cleaned AI text') t.remove();
  toast('Cleaned AI text', undo ? { action: 'Undo', onAction: undo, duration: 6000 } : {});
}
function noteFromAi(text, html, o) {
  if (De.looksMarkdown(text) || !html) return markdownToHtml(De.markdown(text, o));
  return De.tidyHtml(sanitizePaste(html.replace(/<(\/?)h[4-6](?=[\s>])/gi, '<$1h3')), o);
}
/** Text that goes straight into a drop (dragged or pasted outside the box) */
function declutterDrop(text, html) {
  const o = declutterOpts();
  if (!o || !De.isAiText(text, html)) return text.trim();
  const out = De.plainText(text, o);
  if (out && out !== text.trim()) cleanedToast(null);
  return out || text.trim();
}
function cleanComposerPaste(e) {
  const text = e.clipboardData.getData('text/plain');
  const html = e.clipboardData.getData('text/html');
  const o = text ? declutterOpts() : null;
  if (!o || !De.isAiText(text, html)) return false;
  const out = De.plainText(text, o);
  if (!out || out === text.trim()) return false;
  e.preventDefault();
  const ta = el.composerInput;
  const before = ta.value;
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  ta.focus();
  if (!document.execCommand('insertText', false, out)) ta.setRangeText(out, s, en, 'end');
  autosize();
  updateSend();
  cleanedToast(() => {
    ta.value = before.slice(0, s) + text + before.slice(en);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    autosize();
    updateSend();
    ta.focus();
  });
  return true;
}
function declutterNote() {
  const before = el.editorText.innerHTML;
  const o = declutterOpts() || { punct: false };
  const text = el.editorText.innerText || '';
  const md = De.looksMarkdown(text) && !el.editorText.querySelector('[data-file], [style]');
  const out = sanitizeNote(md ? markdownToHtml(De.markdown(text, o)) : De.tidyHtml(before, o));
  const norm = (h) => h.replace(/\s+/g, ' ').trim();
  if (!out.replace(/<[^>]+>/g, '').trim() || norm(out) === norm(sanitizeNote(before))) { toast('Nothing to clean here'); return; }
  setEditorHtml(out);
  onEditorInput();
  const noteId = ui.noteId;
  toast('Note de-cluttered', { action: 'Undo', duration: 6000, onAction: () => { if (ui.noteId === noteId) { setEditorHtml(before); onEditorInput(); } } });
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

/* ═════════════════════════ viewer ═════════════════════════ */

async function openFile(it) {
  const d = it.data;
  const kind = fileKind(d.type, d.name);
  const src = files.src(it.id);
  const textual = (kind === 'doc' || kind === 'code') && d.size <= 1024 * 1024 &&
    (/^text\/|json|xml|javascript/.test(d.type || '') || /^(txt|md|csv|tsv|json|js|mjs|ts|css|html?|py|xml|ya?ml|sh|log|ini|sql|dart|kt|java|c|cpp|h|go|rs|php|rb)$/.test(extOf(d.name)));
  const dk = docKindOf(kind, d.name);
  if (dk) { openDocViewer(it, dk); return; }
  if (!['image', 'video', 'audio', 'pdf'].includes(kind) && !textual) { files.download(it); return; }
  ui.viewing = it;
  el.viewerDownload.hidden = false;
  el.viewerMarkup.hidden = !canMarkup(it) && !canEditPdf(it);
  el.viewerTitle.textContent = d.name;
  el.viewerShare.hidden = !files.canShare();
  if (files.canShare()) files.prefetch(it);
  let html = '';
  if (kind === 'image') {
    html = `<div class="zoom-stage"><img src="${esc(src)}" alt="${esc(d.name)}" draggable="false"></div>
      <div class="zoom-bar" role="group" aria-label="Zoom">
        <button data-zoom="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
        <button class="zoom-pct" data-zoom="fit" title="Whole photo / closer look (double-click)">Fit</button>
        <button data-zoom="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
      </div>`;
  }
  else if (kind === 'video') html = `<video src="${esc(src)}" controls autoplay playsinline></video>`;
  else if (kind === 'audio') html = `<audio src="${esc(src)}" controls autoplay></audio>`;
  else if (kind === 'pdf') html = `<iframe src="${esc(src)}" title="${esc(d.name)}"></iframe>`;
  else html = '<pre>Loading…</pre>';
  if (ui.zoom) { ui.zoom.destroy(); ui.zoom = null; }
  el.viewerBody.innerHTML = html;
  el.viewerBody.classList.toggle('is-zoom', kind === 'image');
  openDialog(el.dlgViewer);
  if (kind === 'image') {
    const pct = el.viewerBody.querySelector('.zoom-pct');
    ui.zoom = new ZoomView(el.viewerBody.querySelector('.zoom-stage'), el.viewerBody.querySelector('img'), (label) => { pct.textContent = label; });
  }
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

const joinLink = () => `${location.origin}/#join=${linkCode()}`;

function renderQR() {
  const qr = qrcode(0, 'M');
  qr.addData(joinLink());
  qr.make();
  el.pairQr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

async function openConnect() {
  renderQR();
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
    const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ space: store.get('space'), token: store.get('token') }) });
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
    await offerJoin({ space: j.space, token: j.token || j.space });
  } catch (err) {
    el.joinMsg.textContent = navigator.onLine ? err.message : 'You are offline. Connect to the internet first.';
    el.joinMsg.className = 'form-msg err';
  } finally {
    ui.joining = false;
  }
}

async function offerJoin(link) {
  const count = store.list().filter((i) => i.kind !== 'settings').length;
  if (count > 0) {
    const ok = await confirmDialog(
      'Connect to your other device?',
      `The ${count} item${count === 1 ? '' : 's'} on this device will be added to the shared space, so all your devices see everything.`,
      'Connect'
    );
    if (!ok) return;
  }
  await joinSpace(link);
}

async function joinSpace(link) {
  saveNote.flush();
  await sync.flush(6000);
  const old = store.get('space');
  const oldK = store.get('token') || old;
  sync.stop();
  for (const it of store.list('file')) it.local = { ...(it.local || {}), up: true, from: old, fromK: oldK };
  await store.moveToSpace(link.space, link.token);
  sync.denied = false;
  cards.clear();
  updateManifest();
  sync.devices = [];
  sync.start();
  files.resumeAll();
  renderAll();
  if (store.get('push')) subscribePush(false).catch(() => {});
  toast('Connected — everything now syncs between your devices.');
}

/* ═════════════════════════ "Open with → SyncPad" (installed desktop app) ═════════════════════════ */

// Files opened with the installed app (right-click → Open with → SyncPad) arrive through launchQueue.
function initLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    const list = [];
    for (const h of params.files) {
      try { list.push(await h.getFile()); } catch {}
    }
    if (list.length) whenUnlocked(() => sendFiles(list, null).then(() => { if (list.length === 1) toast(`Sending “${list[0].name}”…`); }));
  });
}

function renderOpenWith() {
  const desktop = !isTouch() || /Windows NT|Macintosh|CrOS|Linux x86/.test(navigator.userAgent);
  const can = 'launchQueue' in window && desktop && !/Android|iPhone|iPad/.test(navigator.userAgent);
  el.openwithField.hidden = !can;
  if (!can) return;
  el.openwithText.textContent = isStandalone()
    ? 'Right-click a photo, PDF, document, video or zip in your files → Open with → SyncPad. It goes straight to Home on all your devices. The first time, pick SyncPad under “Choose another app” and allow it.'
    : 'Install SyncPad as an app on this computer first (Chrome menu → Cast, save and share → Install). Then right-click a file → Open with → SyncPad to send it.';
}

/* ═════════════════════════ settings ═════════════════════════ */

function openSettings() {
  el.setName.value = store.get('deviceName') || '';
  renderThemeSeg();
  const st = store.items.get('settings');
  el.setAutodel.value = String((st && st.data.autodel) || 0);
  el.setDeclutter.value = (st && st.data.declutter) || 'on';
  el.installField.hidden = !ui.installPrompt || isStandalone();
  renderOpenWith();
  el.versionText.textContent = `SyncPad ${VERSION} · ${store.get('deviceName')}`;
  renderPinSettings();
  loadDevices();
  renderNotif();
  const tc = trashedItems().length;
  el.trashBtnLabel.textContent = tc ? `Open Trash (${tc})` : 'Open Trash';
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
        ${isMe ? '' : `<button class="dev-remove" data-remove="${esc(d.id)}" data-name="${esc(name)}">Remove</button>`}
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
  await sync.flush(6000);
  sync.stop();
  await store.wipe();
  try { for (const k of ['sp-pin', 'sp-pin-try', 'sp-zoom']) localStorage.removeItem(k); } catch {}
  try { for (const n of ['sp-files', 'sp-offline']) await caches.delete(n); } catch {}
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

const ZOOMS = [0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5];
function getZoom() {
  let z = 1;
  try { z = Number(localStorage.getItem('sp-zoom')) || 1; } catch {}
  return Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
}
function applyZoom() {
  queueMicrotask(() => { const pz = document.querySelector('.present-bar .zv'); if (pz) pz.textContent = el.btnZoomReset.textContent; });
  const z = getZoom();
  document.documentElement.style.setProperty('--note-zoom', String(z));
  if (canvasOpen()) {
    const cz = ui.canvas.zoom;
    el.btnZoomReset.textContent = `${Math.round(cz * 100)}%`;
    el.btnZoomOut.disabled = cz <= 0.5;
    el.btnZoomIn.disabled = cz >= 5;
    return;
  }
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
  store.set('pinOn', true);
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

/* ═════════════════════════ links with tokens ═════════════════════════ */

function parseLink(s) {
  const m = /^([A-Za-z0-9_-]{20,64})(?:~([A-Za-z0-9_-]{20,64}))?$/.exec(String(s || ''));
  return m ? { space: m[1], token: m[2] || m[1] } : null;
}
function linkCode() {
  const s = store.get('space');
  const t = store.get('token') || s;
  return t === s ? s : `${s}~${t}`;
}

/* ═════════════════════════ removing devices ═════════════════════════ */

async function removeDevice(id, name) {
  const ok = await confirmDialog(
    `Remove “${name}”?`,
    'It will be signed out of SyncPad, and its copy of your notes and files will be erased the next time it goes online. Your other devices switch to a new private link automatically — nothing to do on them.',
    'Remove device',
    true
  );
  if (!ok) return;
  if (!navigator.onLine) { toast('Go online to remove a device.'); return; }
  const token = rid(24);
  let r = await fetch(`/api/s/${store.get('space')}/rotate`, { method: 'POST', headers: sync.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ remove: [id], token }) }).catch(() => null);
  if (r && r.status === 409) {
    const j = await r.json().catch(() => ({}));
    if (j.token) await sync.setToken(j.token);
    r = await fetch(`/api/s/${store.get('space')}/rotate`, { method: 'POST', headers: sync.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ remove: [id], token }) }).catch(() => null);
  }
  if (!r || !r.ok) { toast('Could not remove the device. Try again in a moment.'); return; }
  await sync.setToken(token);
  sync.devices = sync.devices.filter((d) => d.id !== id);
  renderSettingsDevices(sync.devices);
  toast(`“${name}” was removed. Your devices now use a new private link.`, { duration: 6000 });
}

async function onRevoked() {
  if (ui.revoking) return;
  ui.revoking = true;
  try { sync.stop(); await store.wipe(); } catch {}
  try { for (const k of ['sp-pin', 'sp-pin-try', 'sp-zoom']) localStorage.removeItem(k); } catch {}
  try { for (const n of ['sp-files', 'sp-offline']) await caches.delete(n); } catch {}
  location.replace('/?removed=1');
}

function onToken() {
  updateManifest();
  cards.clear();
  renderDrops();
  for (const img of $$('img[data-file]', el.editorText)) if ((img.getAttribute('src') || '').startsWith('/api/')) img.removeAttribute('src');
  hydrateFiles(el.editorText);
  if (el.dlgConnect.open) renderQR();
}

/* ═════════════════════════ trash ═════════════════════════ */

function deleteWithUndo(item, label) {
  const stored = store.items.get(item.id);
  if (ui.noteId === item.id) {
    if (isMobileLayout()) closeEditor();
    ui.noteId = null;
    ui.newNote = null;
    renderEditor(true);
  }
  if (!stored) { renderLists(); return; } // a note that was never saved
  if (stored.local && stored.local.up) {   // still uploading: nothing to keep
    store.remove(stored).then(() => { files.forget(stored.id); sync.schedule(); });
    toast(`${label} deleted`);
    renderLists();
    return;
  }
  stored.data = { ...stored.data, trashed: Date.now() };
  store.save(stored).then(() => sync.schedule());
  renderLists();
  toast(`${label} moved to Trash`, { action: 'Undo', duration: 6000, onAction: () => restoreItem(stored.id) });
}

async function restoreItem(id) {
  const it = store.items.get(id);
  if (!it) return;
  const { trashed, ...rest } = it.data;
  it.data = rest;
  await store.save(it);
  sync.schedule();
  renderLists();
  if (el.dlgTrash.open) renderTrash();
}

async function deleteForever(id) {
  const it = store.items.get(id);
  if (!it) return;
  await store.remove(it);
  files.forget(id);
  sync.schedule();
}

const trashedItems = () => store.list().filter((i) => i.data.trashed && i.kind !== 'settings').sort((a, b) => b.data.trashed - a.data.trashed);

function openTrash() {
  renderTrash();
  openDialog(el.dlgTrash);
}

function renderTrash() {
  const list = trashedItems();
  el.btnEmptyTrash.hidden = !list.length;
  if (!list.length) { el.trashList.innerHTML = '<div class="trash-empty">Trash is empty.</div>'; return; }
  el.trashList.innerHTML = list.map((it) => {
    const days = Math.max(0, 30 - Math.floor((Date.now() - it.data.trashed) / 86400000));
    const what = it.kind === 'note' ? 'Note' : it.kind === 'file' ? 'File' : 'Message';
    const title = it.kind === 'note' ? noteTitle(noteText(it)) : it.kind === 'file' ? it.data.name : String(it.data.text || '').slice(0, 90);
    const icon = it.kind === 'note' ? 'note' : it.kind === 'file' ? kindIcon(fileKind(it.data.type, it.data.name)) : singleUrl(it.data.text || '') ? 'link' : 'drops';
    return `<div class="trash-row" data-id="${it.id}">
      <span class="dev-ic"><svg class="ic"><use href="#i-${icon}"/></svg></span>
      <div class="trash-main"><div class="trash-title">${esc(title || what)}</div>
      <div class="trash-meta">${what} · deleted ${esc(ago(it.data.trashed))} · ${days} day${days === 1 ? '' : 's'} left</div></div>
      <button class="btn btn-soft btn-sm" data-act="restore">Restore</button>
      <button class="icon-btn sm" data-act="forever" aria-label="Delete forever" title="Delete forever"><svg class="ic"><use href="#i-trash"/></svg></button>
    </div>`;
  }).join('');
}

async function onTrashClick(e) {
  const b = e.target.closest('[data-act]');
  const row = b && b.closest('[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  if (b.dataset.act === 'restore') {
    await restoreItem(id);
    toast('Restored');
  } else if (b.dataset.act === 'forever') {
    const ok = await confirmDialog('Delete forever?', 'This can’t be undone, on any device.', 'Delete forever', true);
    if (!ok) return;
    await deleteForever(id);
    renderTrash();
  }
}

async function emptyTrash() {
  const list = trashedItems();
  if (!list.length) return;
  const ok = await confirmDialog('Empty the trash?', `${list.length} item${list.length === 1 ? '' : 's'} will be deleted forever on all devices.`, 'Empty trash', true);
  if (!ok) return;
  for (const it of list) await deleteForever(it.id);
  renderTrash();
  toast('Trash emptied');
}

/* ═════════════════════════ note history ═════════════════════════ */

async function openHistory() {
  const n = openNoteItem();
  if (!n) return;
  saveNote.flush();
  if (!store.items.has(n.id) || !n.rev) { toast('History starts once this note has synced.'); return; }
  if (!navigator.onLine) { toast('Version history needs an internet connection.'); return; }
  ui.historyNote = n.id;
  ui.historyPick = null;
  el.historyList.innerHTML = '<div class="trash-empty">Loading…</div>';
  el.historyPreview.innerHTML = '';
  el.btnRestoreVersion.disabled = true;
  openDialog(el.dlgHistory);
  try {
    const r = await fetch(`/api/s/${store.get('space')}/history/${n.id}`, { headers: sync.headers() });
    const j = await r.json();
    const versions = j.versions || [];
    el.historyList.innerHTML =
      `<button class="history-item" data-hid="current"><b>Current version</b><span>${esc(noteTitle(noteText(n)))}</span></button>` +
      versions.map((v) => `<button class="history-item" data-hid="${v.hid}"><b>${esc(dayLabel(v.created))}, ${esc(clock(v.created))}</b>
        <span>${esc(v.device === me() ? 'This device' : v.from)} · ${esc(String(v.preview || '').replace(/\s+/g, ' ').slice(0, 70))}</span></button>`).join('') +
      (versions.length ? '' : '<div class="trash-empty">Earlier versions show up here as you keep editing — one is saved every 10 minutes, and whenever another device edits the note.</div>');
    showVersion('current');
  } catch {
    el.historyList.innerHTML = '<div class="trash-empty">Could not load the history.</div>';
  }
}

async function showVersion(hid) {
  for (const b of $$('.history-item', el.historyList)) b.setAttribute('aria-current', String(b.dataset.hid === String(hid)));
  const n = store.items.get(ui.historyNote);
  if (!n) return;
  ui.historyPick = null;
  el.btnRestoreVersion.disabled = true;
  if (hid === 'current') {
    if (n.data.canvas) renderCanvasStatic(el.historyPreview, n.data.canvas, { fileSrc: (id) => files.src(id), sanitize: sanitizeNote });
    else { el.historyPreview.innerHTML = noteHtml(n); hydrateFiles(el.historyPreview); }
    return;
  }
  el.historyPreview.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const j = await (await fetch(`/api/s/${store.get('space')}/history/${n.id}/${hid}`, { headers: sync.headers() })).json();
    if (!j.data) throw new Error();
    ui.historyPick = j;
    if (j.data.canvas) renderCanvasStatic(el.historyPreview, j.data.canvas, { fileSrc: (id) => files.src(id), sanitize: sanitizeNote });
    else {
      el.historyPreview.innerHTML = j.data.html != null ? sanitizeNote(j.data.html) : markdownToHtml(j.data.body || '');
      hydrateFiles(el.historyPreview);
    }
    el.btnRestoreVersion.disabled = false;
  } catch {
    el.historyPreview.innerHTML = '<p class="muted">Could not load this version.</p>';
  }
}

async function restoreVersion() {
  const v = ui.historyPick;
  const n = store.items.get(ui.historyNote);
  if (!v || !n) return;
  const html = v.data.html != null ? sanitizeNote(v.data.html) : markdownToHtml(v.data.body || '');
  const text = v.data.text != null ? v.data.text : v.data.body || '';
  const { body, canvas, ...rest } = n.data;
  n.data = { ...rest, html, text, ...(v.data.canvas ? { canvas: v.data.canvas } : {}) };
  await store.save(n, { snap: true });
  sync.schedule();
  el.dlgHistory.close();
  if (ui.noteId === n.id) renderEditor(true);
  renderNotesList();
  toast(`Restored the version from ${dayLabel(v.created)}, ${clock(v.created)}. The text you replaced is kept in history too.`, { duration: 6000 });
}

/* ═════════════════════════ notifications ═════════════════════════ */

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function renderNotif() {
  const btn = el.btnNotif;
  const label = btn.querySelector('span');
  btn.hidden = false;
  if (!pushSupported()) {
    el.notifText.textContent = isIOS() && !isStandalone()
      ? 'On iPhone/iPad, add SyncPad to your Home Screen first (Share → Add to Home Screen), then turn this on there.'
      : 'This browser can’t show notifications.';
    btn.hidden = true;
    return;
  }
  if (Notification.permission === 'denied') {
    el.notifText.textContent = 'Notifications are blocked for this site in your browser settings.';
    btn.hidden = true;
    return;
  }
  let on = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    on = !!(reg && (await reg.pushManager.getSubscription())) && !!store.get('push');
  } catch {}
  el.notifText.textContent = on ? 'On — you’ll get a notification when a drop arrives from another device.' : 'Get a notification when a drop arrives from another device.';
  label.textContent = on ? 'Turn off' : 'Turn on';
  btn.dataset.on = on ? '1' : '';
}

async function subscribePush(create) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create) {
    const { key } = await (await fetch('/api/push/key')).json();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  }
  if (!sub) return;
  const r = await fetch(`/api/s/${store.get('space')}/push`, {
    method: 'POST',
    headers: sync.headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ endpoint: sub.endpoint })
  });
  if (!r.ok) throw new Error('register failed');
  await store.set('push', true);
}

async function toggleNotif() {
  if (el.btnNotif.dataset.on) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) await sub.unsubscribe();
    } catch {}
    fetch(`/api/s/${store.get('space')}/push`, { method: 'DELETE', headers: sync.headers() }).catch(() => {});
    await store.set('push', false);
    toast('Notifications are off for this device.');
    renderNotif();
    return;
  }
  try {
    if ((await Notification.requestPermission()) !== 'granted') { renderNotif(); return; }
    await subscribePush(true);
    toast('Notifications are on for this device.');
  } catch {
    toast(navigator.onLine ? 'Could not turn on notifications on this device.' : 'Go online to turn on notifications.');
  }
  renderNotif();
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
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    if (opts.at || !anchor) {
      const at = opts.at || { x: innerWidth / 2, y: innerHeight / 3 };
      let left = at.x + 2;
      let top = at.y + 2;
      if (left + mw > innerWidth - 8) left = Math.max(8, at.x - mw - 2);
      if (top + mh > innerHeight - 8) top = Math.max(8, at.y - mh - 2);
      m.style.top = top + 'px';
      m.style.left = left + 'px';
    } else {
      const r = anchor.getBoundingClientRect();
      let top = r.bottom + 6;
      if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
      m.style.top = top + 'px';
      m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
    }
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
    if (anchor && anchor.contains(e.target)) e.stopPropagation();
  };
  ui.menuOutside = outside;
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  if (!opts.keepFocus) m.querySelector('button').focus({ preventScroll: true });
}
function closeMenu() {
  el.menu.hidden = true;
  if (ui.ctxNode) { ui.ctxNode.classList.remove('ctx'); ui.ctxNode = null; }
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
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // the app now opens from the device, so look for a newer version whenever it comes back to the front
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (had && !reloaded && !ui.dirty && !files.queue.length) { reloaded = true; location.reload(); }
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="toasts" style="bottom:24px"><div class="toast"><span>SyncPad could not start: ${esc(err.message || err)}. Try reloading.</span></div></div>`);
});
