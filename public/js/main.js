// SyncPad v2 — app controller
import {
  $, $$, rid, esc, fmtBytes, clock, dayLabel, ago, shortDate, detectDeviceName, isTouch, isMobileLayout,
  isIOS, isStandalone, haptic, linkify, singleUrl, fileKind, kindIcon, extOf, noteTitle, noteSnippet, noteTags, debounce
} from './util.js';
import { Store, readV1Notes } from './store.js';
import { Sync } from './sync.js';
import { Files, makeFileThumb } from './files.js';
import { sanitizeNote, sanitizePaste, markdownToHtml, textToHtml } from './md.js';
import qrcode from '/vendor/qrcode.mjs';
import { Markup } from './markup.js';
import { Collage } from './collage.js';
import { ZoomView } from './zoom.js';
import * as De from './declutter.js';
import { ZipWriter, namer } from './backup.js';
import { speak, warmUp as warmVoice } from './speak.js';
import { NoteCanvas, renderStatic as renderCanvasStatic, fallback as canvasFallback, fromHtml as canvasFromHtml } from './canvas.js';
import { ImageTools } from './noteimg.js';
import { openExport } from './cvexport.js';
import { cycleCase, CASE_LABEL } from './textcase.js';
import { fold, terms, matches, snippet, pageOf, indexable, extractText, INDEX_VERSION } from './search.js';
import { touchReorder, slot, between } from './reorder.js';
import { BIG, splitHtml, textOf, partId } from './bignote.js';
import { createKeyboard } from './keyboard.js';

const VERSION = '3.0.72';
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
  nselecting: false,
  nsel: new Set(),
  busy: false,
  installPrompt: null
};
const cards = new Map(); // id -> {sig, node}

/* ═════════════════════════ boot ═════════════════════════ */

async function boot() {
  for (const n of $$('[id]')) el[n.id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = n;
  el.app = $('#app');
  el.notesPane = $('.notes-pane');

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
  applyTheme();
  renderBgGrid();
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
  if (params.note && store.items.get(params.note)) whenUnlocked(() => openNote(params.note));
  scheduleLocalReminders();
  setTimeout(indexBacklog, 6000);
  syncThemeColor();
  window.__spAndroidBack = () => {
    if (lk && lk.mode) { if (lk.mode === 'unlock') return false; endLock(false); return true; }
    if (!el.menu.hidden && !el.menu.classList.contains('is-leaving')) { closeMenu(); return true; }
    if (layers.length) {
      const top = layers.pop();
      ui.fromPop = true;
      try { top.close(); } finally { ui.fromPop = false; }
      return true;
    }
    if (ui.selecting) { exitSelect(); return true; }
    if (ui.nselecting) { exitNoteSelect(); return true; }
    if (el.app.classList.contains('searching')) {
      el.search.value = ''; ui.query = ''; renderLists(); el.search.blur();
      el.app.classList.remove('searching');
      return true;
    }
    return false;
  };
  window.__spReceiveAndroidShare = (payload) => {
    if (!payload) return;
    whenUnlocked(async () => {
      setTab('drops');
      const list = [];
      for (const f of payload.files || []) {
        if (!f || !f.base64) continue;
        try {
          const bin = atob(f.base64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          list.push(new File([u8], f.name || 'shared-file', { type: f.type || 'application/octet-stream' }));
        } catch {}
      }
      if (list.length) await sendFiles(list);
      if (payload.text && String(payload.text).trim()) sendClip(String(payload.text).trim());
      if (list.length || (payload.text && String(payload.text).trim())) {
        haptic('success');
        toast('Sent to your devices');
      }
    });
  };
  if (Array.isArray(window.__spAndroidShareQueue)) {
    for (const p of window.__spAndroidShareQueue.splice(0)) window.__spReceiveAndroidShare(p);
  }
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    // hooks for the automated tests (only on a developer's own machine)
    window.__test_setRemind = (t) => { const n = openNoteItem(); if (n) setReminder([n], t); };
    window.__test_pdf = () => { const n = openNoteItem(); if (n) saveNotesPdf([n]); };
    window.__test_store = store;
  }
}

function readParams() {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { join: h.get('join') || q.get('join'), s: q.get('s'), shared: q.has('shared'), removed: q.has('removed'), note: q.get('note') };
}

function cleanUrl() {
  if (location.search || location.hash) history.replaceState(null, '', '/');
}

function updateManifest() {
  // lets iOS home-screen installs open already connected and matches current dark theme and paper texture
  let t = 'system';
  let bg = '';
  try {
    t = localStorage.getItem('sp-theme') || 'system';
  } catch {}
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  void bg;
  el.manifestLink.href = '/app.webmanifest?s=' + encodeURIComponent(linkCode()) + '&t=' + (dark ? 'dark' : 'light');
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
  for (const b of $$('[data-tab]')) if (b.tagName === 'BUTTON') b.addEventListener('click', () => { if (ui.tab !== b.dataset.tab) haptic('tick'); setTab(b.dataset.tab); });

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
  el.btnOpenTrash.addEventListener('click', async () => { await el.dlgSettings.close(); openTrash(); });
  el.trashList.addEventListener('click', onTrashClick);
  el.btnEmptyTrash.addEventListener('click', emptyTrash);
  el.historyList.addEventListener('click', (e) => { const b = e.target.closest('[data-hid]'); if (b) showVersion(b.dataset.hid); });
  el.btnRestoreVersion.addEventListener('click', restoreVersion);
  el.btnNotif.addEventListener('click', toggleNotif);
  el.settingsDevices.addEventListener('click', (e) => {
    if (e.target.closest('[data-mkmain]')) return makeMain();
    if (e.target.closest('[data-unmain]')) return unMain();
    if (e.target.closest('[data-remove-all]')) {
      const all = sync.devices.filter((d) => d.id !== me() && !d.main);
      return removeDevice(all.map((d) => d.id), `${all.length} devices`);
    }
    const b = e.target.closest('[data-remove]');
    if (b) removeDevice(b.dataset.remove, b.dataset.name);
  });
  el.btnSettingsConnect.addEventListener('click', async () => { await el.dlgSettings.close(); openConnect(); });

  // text zoom (note editor)
  el.btnZoomIn.addEventListener('click', () => (canvasOpen() ? ui.canvas.zoomStep(1) : stepZoom(1)));
  el.btnZoomOut.addEventListener('click', () => (canvasOpen() ? ui.canvas.zoomStep(-1) : stepZoom(-1)));
  el.btnZoomReset.addEventListener('click', () => { if (canvasOpen()) { ui.canvas.zoomStep(0); return; } const was = currentZoom; currentZoom = 1; saveZoomPref(1); applyZoom(); if (Math.abs((was || 1) - 1) > 0.01) toast('Zoom reset to 100%', { duration: 1200 }); });
  $('.zoom').addEventListener('mousedown', (e) => e.preventDefault());
  setupEditorZoomGestures();

  // PIN lock
  el.keypad.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { haptic('tick'); pinKey(b.dataset.k); } });
  el.lockNext.addEventListener('click', pinNext);
  el.btnPinSet.addEventListener('click', async () => { await el.dlgSettings.close(); showLock('new'); });
  el.btnPinChange.addEventListener('click', async () => {
    await el.dlgSettings.close();
    if (await showLock('verify')) showLock('new');
  });
  el.btnPinRemove.addEventListener('click', async () => {
    await el.dlgSettings.close();
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
  if (el.btnAddFiles) el.btnAddFiles.addEventListener('click', () => { haptic('click'); el.fileInput.click(); });
  if (el.btnUpload) el.btnUpload.addEventListener('click', () => { haptic('click'); el.fileInput.click(); });
  el.fileInput.addEventListener('change', () => { sendFiles([...el.fileInput.files]); el.fileInput.value = ''; });
  el.noteFileInput.addEventListener('change', () => { attachToNote([...el.noteFileInput.files]); el.noteFileInput.value = ''; });

  // home screen: filters, folders, layout, selecting
  el.feedInner.addEventListener('click', onFeedClick);
  const navClick = async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { haptic('tick'); return setDropView(v.dataset.view); }
    const a = e.target.closest('[data-act="new-folder"]');
    if (a) { haptic('click'); const f = await createFolder(); if (f) setDropView('f:' + f.id); }
  };
  el.dropsSide.addEventListener('click', navClick);
  el.dropChips.addEventListener('click', navClick);
  el.typeChips.addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { haptic('tick'); setDropType(b.dataset.type); } });
  el.btnType.addEventListener('click', () => typeMenu(el.btnType));
  initMarquee();
  initEmptyUpload();
  el.viewToggle.addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (b) { haptic('tick'); setLayout(b.dataset.layout); } });
  el.btnSelect.addEventListener('click', () => { haptic('tick'); (ui.selecting ? exitSelect() : enterSelect()); });
  el.btnFolderMore.addEventListener('click', () => folderMenu(el.btnFolderMore));
  el.selectBar.addEventListener('click', onSelectBar);
  // drag drops onto a folder (desktop)
  el.feedInner.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('[data-id]');
    if (!row) return;
    const ids = ui.selecting && ui.selected.has(row.dataset.id) ? [...ui.selected] : [row.dataset.id];
    e.dataTransfer.setData('application/x-syncpad', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    ui.dragDrop = row.dataset.id;
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
  // right-click / two-finger tap on a touchpad → SyncPad's own menus (Shift + right-click = browser menu)
  addEventListener('pointerdown', (e) => { ui.lastPointer = e.pointerType; }, true);
  // phones: while the keyboard is up, hide the bottom tab bar so it doesn't sit on top of the keyboard
  const typing = (t) => t && (t.matches('input:not([type=checkbox]):not([type=radio]), textarea, select') || t.isContentEditable);
  document.addEventListener('focusin', (e) => { if (isTouch() && typing(e.target)) el.app.classList.add('kb'); });
  document.addEventListener('focusout', () => setTimeout(() => { if (!typing(document.activeElement)) el.app.classList.remove('kb'); }, 60));
  el.feedInner.addEventListener('contextmenu', onFeedContext);
  el.dropsSide.addEventListener('contextmenu', onSideContext);
  el.noteList.addEventListener('contextmenu', onNoteListContext);
  if (window.ResizeObserver) { let w = 0; new ResizeObserver(() => { const nw = el.noteList.offsetWidth; if (nw !== w) { w = nw; layoutNoteGrid(); } }).observe(el.noteList); }
  document.fonts?.ready.then(() => layoutNoteGrid());
  // pictures arriving later change a card's height: re-pack the grid
  el.noteList.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') { clearTimeout(ui.gridT); ui.gridT = setTimeout(layoutNoteGrid, 60); } }, true);
  el.feed.addEventListener('scroll', () => {
    ui.atBottom = el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < 60;
  }, { passive: true });

  // notes
  el.noteList.addEventListener('click', (e) => {
    const b = e.target.closest('.note-item');
    if (ui.swiped && Date.now() - ui.swiped < 400) return;
    if (ui.blockClick) { ui.blockClick = false; return; }
    if (clickBlocked()) return;
    if (!b) { if (ui.nselecting && !isTouch() && e.target === el.noteList) exitNoteSelect(); return; }
    const id = b.dataset.id;
    if (!isTouch() && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      if (!ui.nselecting) enterNoteSelect();
      if (e.shiftKey && ui.lastNotePicked) {
        const order = visibleNoteIds();
        const [x, y] = [order.indexOf(ui.lastNotePicked), order.indexOf(id)].sort((p, q) => p - q);
        if (x >= 0) { for (const k of order.slice(x, y + 1)) ui.nsel.add(k); renderNotesList(); return; }
      }
      toggleNoteSel(id);
      return;
    }
    if (ui.nselecting) { toggleNoteSel(id); return; }
    openNote(id);
  });
  el.btnNselect.addEventListener('click', () => { haptic('tick'); (ui.nselecting ? exitNoteSelect() : enterNoteSelect()); });
  el.nselBar.addEventListener('click', (e) => { const b = e.target.closest('[data-nsel]'); if (b) nselAction(b.dataset.nsel, b); });
  el.btnDsort.addEventListener('click', () => dropSortMenu(el.btnDsort));
  el.importInput.addEventListener('change', () => { const f = [...el.importInput.files]; el.importInput.value = ''; (async () => { for (const x of f) await importAsNote(x); })(); });
  el.btnRemind.addEventListener('click', () => { const n = openNoteItem(); if (n) remindMenu(el.btnRemind, [n]); });
  sync.addEventListener('remind', (e) => { for (const id of e.detail) { const n = store.items.get(id); if (n) showReminder(n); } });
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t === 'open' && m.url) { const id = new URL(m.url, location.origin).searchParams.get('note'); if (id && store.items.get(id)) whenUnlocked(() => openNote(id)); }
  });
  el.editorText.addEventListener('input', autoCapital);
  el.editorText.addEventListener('beforeinput', () => { if (ui.autoCap) undoAutoCapIfLink(); });
  el.editorText.addEventListener('input', (e) => { if (e.inputType === 'insertParagraph') autoCapitalPrevLine(); });
  el.tagChips.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    ui.tag = ui.tag === c.dataset.tag ? null : c.dataset.tag;
    renderNotesList();
    triggerAnim(el.noteList, 'view-swap', ['view-swap'], 160);
  });
  el.btnNewNote.addEventListener('click', () => { haptic('click'); newNote(); });
  el.btnNewMore.addEventListener('click', () => { haptic('tick'); newMenu(el.btnNewMore); });
  el.btnNewNote.addEventListener('contextmenu', (e) => { e.preventDefault(); newMenu(el.btnNewMore); });
  el.editorPane.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'new-note') newNote();
    if (a.dataset.act === 'conflict-keep') resolveConflict(true);
    if (a.dataset.act === 'conflict-drop') resolveConflict(false);
  });
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
  el.editorText.addEventListener('input', onEditorInput);
  el.editorText.addEventListener('input', (e) => {
    // a link typed in a note becomes a real link once you press space or Enter
    if (e.inputType === 'insertFromPaste') linkifyAfterPaste(); else if (e.inputType === 'insertParagraph' || (e.inputType === 'insertText' && /\s/.test(e.data || ''))) autoLink(e.inputType === 'insertParagraph');
  });
  el.editorText.addEventListener('paste', pasteIntoEditor);
  fingerSelect();
  // optional SyncPad keyboard (instead of the phone's) for notes and the write box
  ui.kb = createKeyboard({ isTarget: (t) => {
    if (!t || !t.closest || t.closest('.skb')) return false;
    if (ui.selMode && t.closest('#editor-text')) return false; // finger select: no keyboard at all
    return t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search|url|email|tel|)$/.test(t.getAttribute('type') || ''));
  } });
  ui.kb.setEnabled(isTouch() && lsGet('sp-kb', 'phone') === 'own');
  const kbSeg = $('#set-kb');
  const showKbOpt = () => { for (const b of $$('[data-kb-opt]', kbSeg)) b.setAttribute('aria-pressed', String(b.dataset.kbOpt === lsGet('sp-kb', 'phone'))); };
  showKbOpt();
  kbSeg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kb-opt]');
    if (!b) return;
    lsSet('sp-kb', b.dataset.kbOpt);
    showKbOpt();
    ui.kb.setEnabled(isTouch() && b.dataset.kbOpt === 'own');
    toast(b.dataset.kbOpt === 'own' ? 'SyncPad keyboard on — tap into a note to use it.' : "Back to the phone's keyboard.");
  });
  el.editorText.addEventListener('blur', () => saveNote.flush());
  el.editorText.addEventListener('keydown', onEditorKey);
  el.editorText.addEventListener('click', onEditorClick);
  ui.imgTools = new ImageTools({
    editor: el.editorText,
    onChange: onEditorInput,
    onView: (im) => { const it = store.items.get(im.dataset.file); if (it) openFile(it); },
    onMarkup: async (im) => {
      const r = await markupFile(im.dataset.file);
      if (!r || !im.isConnected) return;
      im.dataset.file = r.id;
      im.src = files.src(r.id);
      onEditorInput();
      ui.imgTools.select(im);
    },
    toast: (m) => toast(m)
  });
  el.btnToggleList.addEventListener('click', () => toggleNotesList());
  el.btnNotesView.addEventListener('click', () => notesViewMenu(el.btnNotesView));
  el.nfolderChips.addEventListener('click', onFolderChipClick);
  el.nfolderChips.addEventListener('contextmenu', onFolderChipContext);
  el.nfolderChips.addEventListener('dragover', (e) => { const c = e.target.closest('[data-nf]'); if (c && [...e.dataTransfer.types].includes('application/x-syncpad-note')) { e.preventDefault(); c.classList.add('drop-on'); } });
  el.nfolderChips.addEventListener('dragleave', (e) => { const c = e.target.closest('[data-nf]'); if (c) c.classList.remove('drop-on'); });
  el.nfolderChips.addEventListener('drop', (e) => {
    const c = e.target.closest('[data-nf]');
    const id = e.dataTransfer.getData('application/x-syncpad-note');
    if (!c || !id) return;
    e.preventDefault();
    e.stopPropagation();
    c.classList.remove('drop-on');
    if (c.dataset.nf === 'archive') { archiveNote(store.items.get(id), true); return; }
    moveNoteToFolder(store.items.get(id), c.dataset.nf === 'all' ? null : c.dataset.nf);
  });
  el.noteList.addEventListener('dragstart', (e) => {
    const b = e.target.closest('.note-item');
    if (!b) return;
    e.dataTransfer.setData('application/x-syncpad-note', b.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    ui.dragNote = b.dataset.id;
    el.app.classList.add('dragging-note');
  });
  el.noteList.addEventListener('dragend', () => el.app.classList.remove('dragging-note'));
  setupArranging();
  setupTabSwipe();
  fitToKeyboard();
  setupPasteChip();
  el.btnShowList.addEventListener('click', () => toggleNotesList(true));
  el.btnPresent.addEventListener('click', startPresent);
  applyNotesList();
  setupNoteListPinch();
  setupDropsPinch();
  applyDropSize();
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
  if (el.btnNoteUndo) {
    el.btnNoteUndo.addEventListener('mousedown', (e) => e.preventDefault());
    el.btnNoteUndo.addEventListener('click', () => doNoteUndo());
  }
  if (el.btnNoteRedo) {
    el.btnNoteRedo.addEventListener('mousedown', (e) => e.preventDefault());
    el.btnNoteRedo.addEventListener('click', () => doNoteRedo());
  }
  el.editorText.addEventListener('keyup', () => syncNoteUndoRedo());
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3 && openNoteItem() && !$('dialog[open]')) {
      e.preventDefault();
      closeEditor();
    }
  });
  el.fmtBar.addEventListener('click', (e) => {
    const c = e.target.closest('[data-clip]');
    if (c) { clipAction(c.dataset.clip); return; }
    const b = e.target.closest('[data-fmt]');
    if (b) format(b.dataset.fmt, b);
  });
  // the clipboard buttons must not take the selection or close the keyboard
  el.fmtBar.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-clip]')) e.preventDefault(); });

  // dialogs
  for (const d of $$('dialog')) setupAnimatedDialog(d);
  el.joinForm.addEventListener('submit', (e) => { e.preventDefault(); joinWithCode(); });
  setupPinLogin();
  el.btnBackup.addEventListener('click', makeBackup);
  setupListen();
  el.setWall.addEventListener('click', (e) => { const b = e.target.closest('[data-wall-opt]'); if (b) { haptic('tick'); setWall(b.dataset.wallOpt); } });
  setTimeout(backupReminder, 8000);
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
    haptic('tick');
    try { localStorage.setItem('sp-theme', b.dataset.themeOpt); } catch {}
    applyTheme();
    renderThemeSeg();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  if (el.setBgGrid) {
    el.setBgGrid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-bg]');
      if (!card) return;
      const bg = card.dataset.bg || 'none';
      try { localStorage.setItem('sp-bg', bg); } catch {}
      applyTheme();
      renderBgGrid();
    });
  }
  el.setAutodel.addEventListener('change', () => {
    const cur = store.items.get('settings');
    const item = cur || { id: 'settings', kind: 'settings', rev: 0, created: Date.now(), data: {} };
    item.data = { ...item.data, autodel: Number(el.setAutodel.value) };
    store.save(item).then(() => sync.schedule());
  });
  el.setSendAs.addEventListener('change', () => { lsSet('sp-send-as', el.setSendAs.value); renderComposerHint(); });
  renderComposerHint();
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
  ui.markupBtnHtml = el.viewerMarkup.innerHTML;
  el.viewerMarkup.addEventListener('click', async () => {
    const it = ui.viewing;
    if (!it) return;
    if (ui.epubOpen === it) {
      let blob = null;
      try { blob = await files.blobOf(it); } catch {}
      if (!blob) return;
      el.dlgViewer.close();
      importAsNote(new File([blob], it.data.name, { type: 'application/epub+zip' }));
      return;
    }
    if (canEditDoc(it)) openDocEdit(it);
    else if (canEditPdf(it)) (ui.docSource ? editDocument(it, { kind: 'html', html: ui.docSource }) : openPdfEdit(it));
    else openMarkup(it);
  });
  el.viewerTitle.title = 'Click to rename';
  el.viewerTitle.addEventListener('click', () => {
    if (ui.viewing) renameDrop(ui.viewing);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F2' && ui.tab === 'drops' && !e.target.closest('input, textarea, [contenteditable="true"]')) {
      if (ui.selected && ui.selected.size === 1) {
        const id = [...ui.selected][0];
        const it = store.items.get(id);
        if (it) { e.preventDefault(); renameDrop(it); }
      }
    }
  });
  el.dlgViewer.addEventListener('close', () => {
    if (ui.zoom) { ui.zoom.destroy(); ui.zoom = null; }
    if (ui.epubOpen) {
      ui.epubOpen = null;
      for (const u of ui.epubUrls || []) URL.revokeObjectURL(u);
      ui.epubUrls = null;
      el.viewerMarkup.innerHTML = ui.markupBtnHtml;
    }
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
    setAnimatedVisible(el.dropOverlay, true, 140);
  });
  addEventListener('dragover', (e) => {
    const k = dragKind(e);
    if (!k) return;
    if (k === 'text' && e.target.closest && e.target.closest('textarea, input, [contenteditable="true"]')) { setAnimatedVisible(el.dropOverlay, false, 120); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setAnimatedVisible(el.dropOverlay, true, 140);
    const fd = e.target.closest && e.target.closest('[data-folder-drop]');
    const fdName = fd && store.items.get(fd.dataset.folderDrop) && store.items.get(fd.dataset.folderDrop).data.name;
    el.dropOverlayTitle.textContent = overNoteEditor(e.target) ? 'Drop to attach to this note'
      : fdName ? `Drop into “${fdName}”`
      : currentFolder() && ui.tab === 'drops' ? `Drop into “${viewTitle()}”` : 'Drop to send to all your devices';
  });
  addEventListener('dragleave', (e) => {
    if (!dragKind(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0 || !e.relatedTarget) setAnimatedVisible(el.dropOverlay, false, 120);
  });
  addEventListener('drop', (e) => {
    const k = dragKind(e);
    depth = 0;
    setAnimatedVisible(el.dropOverlay, false, 120);
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
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'v') ui.rawPasteUntil = Date.now() + 1500;
    if (el.lock.hidden && !e.isComposing && ((mod && !e.altKey && !e.shiftKey) || (e.altKey && !mod && !e.shiftKey)) && (e.key.toLowerCase() === 'n' || e.code === 'KeyN')) {
      e.preventDefault();
      e.stopPropagation();
      if (!el.menu.hidden) closeMenu();
      if (ui.presenting) stopPresent();
      if (el.app.classList.contains('searching')) el.app.classList.remove('searching');
      $$('dialog[open]').forEach((d) => { try { d.close(); } catch {} });
      newNote();
    }
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
    const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
    if ((e.altKey && (e.key === 'ArrowLeft' || e.key === 'Left') && !isMac) || (isMac && e.metaKey && e.key === '[')) {
      if (openNoteItem() && !$('dialog[open]')) {
        e.preventDefault();
        closeEditor();
        return;
      }
    }
    if (ui.presenting && e.key === 'Escape') { e.preventDefault(); stopPresent(); return; }
    if (mod && e.key === '\\' && ui.tab === 'notes') { e.preventDefault(); toggleNotesList(); return; }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      el.app.classList.add('searching');
      el.search.focus();
      el.search.select();
    } else if (e.key === 'Escape' && !el.menu.hidden) {
      closeMenu();
    } else if (e.key === 'Escape' && ui.nselecting && ui.tab === 'notes' && !$('dialog[open]')) {
      exitNoteSelect();
    } else if (ui.tab === 'notes' && mod && e.key.toLowerCase() === 'a' && !$('dialog[open]') && !(e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]'))) {
      e.preventDefault();
      if (!ui.nselecting) enterNoteSelect();
      ui.nsel = new Set(visibleNoteIds());
      renderNotesList();
    } else if (e.key === 'Escape' && ui.selecting && !$('dialog[open]')) {
      exitSelect();
    } else if (ui.tab === 'drops' && !$('dialog[open]') && !(e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]'))) {
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(new Set(visibleDrops().map((i) => i.id))); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.selecting && ui.selected.size) { e.preventDefault(); selAction('trash'); }
      else if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); el.fileInput.click(); }
    }
  });

  // history: Android back closes sheets / the editor instead of leaving the app
  addEventListener('popstate', () => {
    if (ui.skipPop > 0) {
      ui.skipPop--;
      if (ui.skipPop === 0 && ui.skipPopWaiters) for (const fn of ui.skipPopWaiters.splice(0)) fn();
      return;
    }
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
  addEventListener('online', () => { renderStatus(); retryFileThumbs(); });
  // a join link opened while SyncPad is already open in this tab
  addEventListener('hashchange', () => {
    const k = parseLink(readParams().join);
    cleanUrl();
    if (k && k.space !== store.get('space')) whenUnlocked(() => offerJoin(k));
  });
  addEventListener('offline', renderStatus);
  addEventListener('resize', debounce(() => {
    if (!isMobileLayout()) {
      el.app.classList.remove('editing', 'editor-leaving');
      if (ui.editorLeaveT) { clearTimeout(ui.editorLeaveT); ui.editorLeaveT = 0; renderEditor(true); }
    }
  }, 150));
  setInterval(() => { if (document.visibilityState === 'visible') renderDrops(); }, 60000);
}

/* ═════════════════════════ layers (dialogs, editor) + motion ═════════════════════════ */

const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

function triggerAnim(node, cls, clearClasses = [cls], ms = 180) {
  if (!node || reducedMotion()) return;
  clearTimeout(node._animT);
  node.classList.remove(...clearClasses);
  void node.offsetWidth;
  node.classList.add(cls);
  node._animT = setTimeout(() => { node.classList.remove(cls); node._animT = 0; }, ms);
}

function setAnimatedVisible(node, show, ms = 125) {
  if (!node) return;
  clearTimeout(node._hideT);
  node._hideT = 0;
  if (show) {
    const wasHidden = node.hidden || node.classList.contains('is-leaving');
    node.classList.remove('is-leaving');
    node.hidden = false;
    if (wasHidden && !reducedMotion()) {
      clearTimeout(node._enterT);
      node.classList.add('is-entering');
      node._enterT = setTimeout(() => node.classList.remove('is-entering'), ms + 40);
    }
    return;
  }
  if (node.hidden || node.classList.contains('is-leaving')) return;
  if (reducedMotion()) { node.hidden = true; return; }
  clearTimeout(node._enterT);
  node.classList.remove('is-entering');
  node.classList.add('is-leaving');
  node._hideT = setTimeout(() => {
    node.classList.remove('is-leaving');
    node.hidden = true;
    node._hideT = 0;
  }, ms);
}

const layers = [];
function pushLayer(layer, replace = false) {
  layers.push(layer);
  if (replace) history.replaceState({ layer: layers.length }, '');
  else history.pushState({ layer: layers.length }, '');
}
function closeLayer(key, skipBack = false) {
  const i = layers.findIndex((l) => l.key === key);
  if (i === -1) return;
  layers.splice(i, 1);
  if (!ui.fromPop && !skipBack && history.state && typeof history.state.layer === 'number') {
    ui.skipPop = (ui.skipPop || 0) + 1;
    history.back();
  }
}

function waitSkipPop() {
  if (!ui.skipPop) return Promise.resolve();
  return new Promise((r) => {
    const done = () => { clearTimeout(t); r(); };
    const t = setTimeout(done, 60);
    (ui.skipPopWaiters ||= []).push(done);
  });
}

function setupAnimatedDialog(d) {
  const rawClose = d.close.bind(d);
  d._rawClose = rawClose;
  d._finishClose = () => {
    clearTimeout(d._closeT);
    d._closeT = 0;
    d.classList.remove('closing');
    if (d.open) rawClose();
  };
  d.close = () => closeDialog(d);
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) d.close();
    else if (e.target === d && d.classList.contains('sheet')) d.close(); // backdrop
  });
  d.addEventListener('cancel', (e) => {
    if (reducedMotion()) return;
    if (d._cancelGuard && !d._cancelGuard()) { e.preventDefault(); return; }
    e.preventDefault();
    closeDialog(d);
  });
  d.addEventListener('close', () => {
    clearTimeout(d._closeT);
    d._closeT = 0;
    d.classList.remove('closing');
    closeLayer(d, !!d._reopening);
    if (d._closeWaiters) {
      const ws = d._closeWaiters.splice(0);
      if (ws.length) waitSkipPop().then(() => { for (const w of ws) w(); });
    }
  });
}

function closeDialog(d, immediate = false) {
  if (!d) return Promise.resolve();
  if (!d.open) {
    d.classList.remove('closing');
    clearTimeout(d._closeT);
    d._closeT = 0;
    return Promise.resolve();
  }
  if (immediate || reducedMotion() || !d._rawClose) {
    if (d._finishClose) d._finishClose();
    else d.close();
    return Promise.resolve();
  }
  if (d.classList.contains('closing')) {
    return new Promise((r) => (d._closeWaiters ||= []).push(r));
  }
  d.classList.add('closing');
  for (const m of $$('video, audio', d)) try { m.pause(); } catch {}
  return new Promise((resolve) => {
    (d._closeWaiters ||= []).push(resolve);
    d._closeT = setTimeout(() => { if (d._finishClose) d._finishClose(); }, 135);
  });
}

function openDialog(d) {
  let replace = false;
  if (d.classList.contains('closing') && d._finishClose) {
    replace = layers.some((l) => l.key === d);
    d._reopening = true;
    try { d._finishClose(); } finally { d._reopening = false; }
  }
  if (d.open) return;
  d.showModal();
  pushLayer({ key: d, close: () => d.close() }, replace);
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
    else if (ui.noteId && ids.some((id) => { const it = store.items.get(id); return it && it.kind === 'part' && it.data.of === ui.noteId; })) {
      const n = openNoteItem();
      if (n && partsReady(n) && !ui.dirty) renderEditor(true);
    }
  } else {
    for (const id of ids) ui.known.add(id);
  }
  const kinds = ids.map((id) => store.items.get(id));
  const drops = kinds.some((it) => !it || isDrop(it) || it.kind === 'folder');
  const notes = kinds.some((it) => !it || it.kind === 'note');
  scheduleRender(drops, notes);
  if (notes) { clearTimeout(ui.remindSchedT); ui.remindSchedT = setTimeout(scheduleLocalReminders, 300); }
  if (kinds.some((it) => it && it.kind === 'file')) { clearTimeout(ui.indexT); ui.indexT = setTimeout(indexBacklog, 4000); }
}

function setTab(tab, { animate = true, dir } = {}) {
  const prev = ui.tab;
  ui.tab = tab;
  el.app.dataset.tab = tab;
  renderTabs();
  if (tab === 'drops') {
    clearUnseen();
    ui.stickBottom = true;
    renderDrops();
  } else {
    renderNotesList(); // the list (or grid) first; a note opens only when you pick one
  }
  renderNoteSelectBar();
  if (animate && prev && prev !== tab) {
    const goRight = dir ? dir < 0 : tab === 'notes';
    const v = tab === 'notes' ? el.viewNotes : el.viewDrops;
    triggerAnim(v, goRight ? 'view-enter-right' : 'view-enter-left', ['view-enter-right', 'view-enter-left', 'swipe-from-right', 'swipe-from-left'], 200);
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
  el.statusChip.setAttribute('aria-label', text);
  el.statusChip.title = state === 'offline' ? `${text}. Everything is saved on this device and will sync when you are back online.` : `${text} · Devices & sync`;
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
const dropOrder = () => lsGet('sp-dsort', 'new');
const posOf = (i) => (Number.isFinite(i.data.pos) ? i.data.pos : i.created);
function dropItems() {
  const custom = dropOrder() === 'custom';
  return store.list().filter((i) => isDrop(i) && !i.data.trashed).sort(custom ? (a, b) => posOf(b) - posOf(a) : (a, b) => b.created - a.created);
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
  const ts = terms(ui.query);
  if (ts.length) {
    // search looks everywhere, folders included, and inside documents (PDF, Word, ePUB…)
    return all.filter((i) => ofType(i) && dropMatches(i, ts));
  }
  return all.filter((i) => inLocation(i) && ofType(i));
}
function dropFields(i) {
  const l = i.data.link || {};
  const f = folderOf(i);
  return [i.data.text, i.data.name, l.title, l.site, l.desc || l.description, f && f.data.name, i.kind === 'file' ? extOf(i.data.name) : ''];
}
function dropMatches(i, ts) {
  if (matches(ts, ...dropFields(i))) return true;
  return i.kind === 'file' && i.data.ft > 0 && matches(ts, docText(i.id));
}
/** the searchable text of a document (stored in pieces next to the file) */
function docText(id) {
  const ps = [];
  for (let k = 0; k < 200; k++) { const p = store.items.get(`${id.slice(0, 50)}_t${k}`); if (!p) break; ps.push(p.data.text || ''); }
  return ps.join('');
}
function viewTitle() {
  if (ui.query) return 'Search results';
  const f = currentFolder();
  return f ? store.items.get(f).data.name || 'Folder' : 'Home';
}
function setDropView(loc) {
  const changed = ui.dloc !== loc;
  ui.dloc = loc;
  try { localStorage.setItem('sp-dloc', loc); } catch {}
  exitSelect();
  el.feed.scrollTop = 0;
  renderDrops();
  if (changed) {
    triggerAnim(el.feedInner, 'view-swap', ['view-swap'], 160);
    triggerAnim(el.dhTitle, 'is-swapping', ['is-swapping'], 150);
  }
}
function setDropType(type) {
  const changed = ui.dtype !== type;
  ui.dtype = type;
  try { localStorage.setItem('sp-dtype', type); } catch {}
  exitSelect();
  renderDrops();
  if (changed) triggerAnim(el.feedInner, 'view-swap', ['view-swap'], 160);
}
function setLayout(l) {
  const changed = ui.layout !== l;
  ui.layout = l;
  try { localStorage.setItem('sp-layout', l); } catch {}
  cards.clear();
  renderDrops();
  if (changed) triggerAnim(el.feedInner, 'view-swap', ['view-swap'], 160);
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
  el.composerInput.placeholder = sendAs() === 'note' ? 'Write a note…'
    : currentFolder() ? `Send to “${viewTitle()}” — type, paste or drop…` : 'Type, paste or drop anything…';
}

function typeMenu(anchor) {
  openMenu(anchor, TYPES.map(([t, l]) => ({ icon: { all: 'drops', media: 'image', files: 'file', links: 'link', text: 'note', pinned: 'pin' }[t], label: (ui.dtype === t ? '✓ ' : '') + l, run: () => setDropType(t) })));
}

/* ───────── Universal file preview thumbnails ───────── */

const fileThumbQueue = new Set();
const fileThumbTried = new Set();
let fileThumbWorking = false;

function needsBlobForThumb(type, name, size) {
  const k = fileKind(type, name);
  const e = extOf(name);
  if (['image', 'video', 'pdf', 'doc', 'sheet', 'slides', 'code', 'audio'].includes(k)) return true;
  if (k === 'archive') return /^(zip|jar|apk|ipa|cbz|xpi|tar)$/.test(e);
  if (/^(ttf|otf|woff2?)$/.test(e)) return true;
  return (size || 0) <= 5 * 1024 * 1024;
}

function queueFileThumb(it) {
  if (!it || it.kind !== 'file' || it.data.thumb || it.data.trashed) return;
  if (fileThumbTried.has(it.id) || fileThumbQueue.has(it.id)) return;
  fileThumbQueue.add(it.id);
  pumpFileThumbs();
}

function retryFileThumbs() {
  if (!fileThumbTried.size) return;
  fileThumbTried.clear();
  if (ui.mode === 'drops') renderDrops();
  indexBacklog();
}

async function pumpFileThumbs() {
  if (fileThumbWorking || !fileThumbQueue.size) return;
  fileThumbWorking = true;
  try {
    const id = fileThumbQueue.values().next().value;
    fileThumbQueue.delete(id);
    fileThumbTried.add(id);
    const it = store.items.get(id);
    if (!it || it.data.thumb || it.data.trashed) return;

    const had = files.mem.has(id);
    let blob = files.mem.get(id) || (await files.cachedBlob(id).catch(() => null));
    const needBlob = needsBlobForThumb(it.data.type, it.data.name, it.data.size);

    if (!blob && needBlob) {
      if (it.data.size <= 35 * 1024 * 1024 && !(navigator.connection && navigator.connection.saveData) && navigator.onLine) {
        try {
          blob = await files.blobOf(it);
        } catch {
          blob = null;
        }
      }
      if (!blob) return;
    }

    let res = null;
    try {
      res = await makeFileThumb(blob, it.data).catch((e) => {
        console.warn('file thumb error', it.data.name, e);
        return null;
      });
    } finally {
      if (!had) files.mem.delete(id);
    }

    if (res && res.thumb) {
      const cur = store.items.get(id);
      if (cur && !cur.data.thumb) {
        cur.data = { ...cur.data, thumb: res.thumb, w: res.w, h: res.h };
        cur.updated = Date.now();
        await store.save(cur);
        sync.schedule();
        const card = cards.get(id);
        if (card && card.node) {
          const btn = card.node.querySelector('.ri-thumb, .tile-media');
          if (btn) btn.innerHTML = thumbHTML(cur);
        }
        cards.delete(id);
      }
    }
  } catch (err) {
    console.warn('pumpFileThumbs error', err);
  } finally {
    fileThumbWorking = false;
    if (fileThumbQueue.size) {
      setTimeout(pumpFileThumbs, 80);
    }
  }
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
      : 'Nothing here yet.'}</p>${!ui.query && ui.dtype === 'all' ? `<p class="row" style="margin-top:12px;justify-content:center;"><button class="btn btn-sm btn-primary" data-act="pick"><svg class="ic"><use href="#i-clip"/></svg><span>Add files</span></button></p>` : ''}</div>`;
    return;
  }
  const nodes = [];
  const seen = new Set();
  let day = '';
  let group = null;
  const custom = dropOrder() === 'custom' && !ui.query;
  for (const it of list) {
    if (it.kind === 'file' && !it.data.thumb) {
      queueFileThumb(it);
    }
    const d = custom ? 'My order' : dayLabel(it.created);
    if (d !== day) {
      day = d;
      const h = document.createElement('div');
      h.className = 'day' + (custom ? ' day-custom' : '');
      h.textContent = custom ? '' : d;
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
      <button class="btn btn-primary" data-act="pick"><svg class="ic"><use href="#i-clip"/></svg><span>Add files</span></button>
      ${alone ? `<button class="btn btn-soft" data-act="connect"><svg class="ic"><use href="#i-qr"/></svg><span>Connect a device</span></button>` : ''}
    </div>
    ${alone ? `<button class="btn btn-ghost signin-link" data-act="signin"><svg class="ic"><use href="#i-lock"/></svg><span>Already use SyncPad? Sign in with your password</span></button>` : ''}
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
    it.kind === 'file' && files.isOffline(it.id) ? 'off' : '', it.data.thumb ? it.data.thumb.length : 0, it.rev, it.updated, it.data.keep ? 1 : 0,
    prog ? prog.state + (prog.err || '') : '', ui.expanded.has(it.id) ? 1 : 0, ui.query].join('|');
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
    if (url && it.data.link && it.data.link.thumb) {
      const isFav = it.data.link.isFavicon || it.data.link.thumb.includes('s2/favicons') || it.data.link.thumb.includes('/favicon.ico');
      if (isFav) return `<span class="ti ti-link-fav"><img src="${esc(it.data.link.thumb)}" alt="" class="fav-icon" draggable="false"></span>`;
      return `<img src="${esc(it.data.link.thumb)}" alt="" draggable="false" decoding="async" class="link-media-thumb">`;
    }
    return `<span class="ti" data-k="${url ? 'link' : 'text'}"><svg class="ic"><use href="#i-${url ? 'link' : 'note'}"/></svg></span>`;
  }
  const d = it.data;
  const kind = fileKind(d.type, d.name);
  if (d.thumb) {
    const ext = extOf(d.name);
    const badge = kind === 'pdf' ? 'PDF' : ext ? ext.slice(0, 6).toUpperCase() : 'FILE';
    const overlay = kind === 'video'
      ? '<span class="mini-play"><svg class="ic" viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg></span>'
      : kind === 'image'
        ? ''
        : `<span class="mini-badge kind-${kind}${kind === 'pdf' ? ' pdf-badge' : ''}">${esc(badge)}</span>`;
    return `<img src="${esc(d.thumb)}" alt="" draggable="false" decoding="async" class="${kind !== 'image' && kind !== 'video' ? 'doc-thumb' : ''}">${overlay}`;
  }
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
    if (url) {
      const ytBtns = ytInfo(url)
        ? `<button class="yt-dl-btn" data-act="yt-mp3" aria-label="Download MP3" title="Download MP3"><svg class="ic"><use href="#i-download"/></svg><span>MP3</span></button>` +
          `<button class="yt-dl-btn" data-act="yt-m4a" aria-label="Download M4A Audio" title="Download M4A Audio"><svg class="ic"><use href="#i-download"/></svg><span>M4A</span></button>` +
          `<button class="yt-dl-btn" data-act="yt-mp4" aria-label="Download Video" title="Download Video (MP4)"><svg class="ic"><use href="#i-download"/></svg><span>Video</span></button>`
        : '';
      return `${ytBtns}<a class="icon-btn act" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open link" title="Open link"><svg class="ic"><use href="#i-link"/></svg></a>`;
    }
    return `<button class="icon-btn act" data-act="copy" aria-label="Copy text" title="Copy"><svg class="ic"><use href="#i-copy"/></svg></button>`;
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
      ${hitHTML(it)}
      ${prog && prog.state !== 'err' ? `<div class="progress"><span style="width:${pct(prog)}%"></span></div>` : ''}
    </div>
    <div class="ri-actions">${primaryAction(it, prog)}<button class="icon-btn" data-act="menu" aria-label="More actions"><svg class="ic"><use href="#i-more"/></svg></button></div>
  </article>`;
}

function tileHTML(it, prog) {
  const sel = ui.selected.has(it.id);
  const url = it.kind === 'clip' ? singleUrl(it.data.text || '') : '';
  const isText = it.kind === 'clip' && !url;
  const ytActs = url && ytInfo(url)
    ? `<div class="tile-yt-acts"><button class="yt-dl-btn" data-act="yt-mp3" title="Download MP3"><svg class="ic"><use href="#i-download"/></svg><span>MP3</span></button><button class="yt-dl-btn" data-act="yt-m4a" title="Download M4A Audio"><svg class="ic"><use href="#i-download"/></svg><span>M4A</span></button><button class="yt-dl-btn" data-act="yt-mp4" title="Download Video (MP4)"><svg class="ic"><use href="#i-download"/></svg><span>Video</span></button></div>`
    : '';
  return `<article class="tile${sel ? ' selected' : ''}${ui.selecting ? ' selecting' : ''}" data-id="${it.id}">
    <button class="tile-media" data-act="${isText ? 'expand-tile' : 'open'}" aria-label="Open" draggable="${!isTouch()}">
      ${isText ? `<span class="tile-text">${esc((it.data.text || '').slice(0, 220))}</span>` : thumbHTML(it)}
    </button>
    ${ui.selecting ? `<span class="ri-check" aria-hidden="true"><svg class="ic"><use href="#i-check"/></svg></span>` : ''}
    <button class="tile-more icon-btn sm" data-act="menu" aria-label="More actions"><svg class="ic"><use href="#i-more"/></svg></button>
    <div class="tile-name" title="${esc(dropTitle(it).slice(0, 300))}">${esc(dropTitle(it).slice(0, 120))}</div>
    <div class="tile-meta">${it.kind === 'file' && !prog ? esc(fmtBytes(it.data.size)) + ' · ' : ''}${clock(it.created)}</div>
    ${ytActs}
    ${hitHTML(it)}
    ${prog && prog.state !== 'err' ? `<div class="progress"><span style="width:${pct(prog)}%"></span></div>` : ''}
  </article>`;
}

const pct = (p) => (p.total ? Math.min(100, Math.floor((p.sent / p.total) * 100)) : 0);

/** search: why this drop matched — a highlighted line from inside the document, with its page */
function hitHTML(it) {
  const ts = terms(ui.query);
  if (!ts.length || it.kind !== 'file' || !(it.data.ft > 0) || matches(ts, ...dropFields(it))) return '';
  const t = docText(it.id);
  const sn = snippet(t, ts, 150);
  if (!sn) return '';
  const pg = pageOf(t, ts);
  return `<div class="hit" data-act="open-hit" data-page="${pg}">${pg ? `<b>p. ${pg}</b> ` : ''}${sn}</div>`;
}

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
  if (act === 'signin') { openConnect(); setTimeout(() => { const i = $('#pin-login'); i.scrollIntoView({ block: 'center' }); i.focus(); }, 120); return; }
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
    else if (singleUrl(it.data.text || '')) openUrl(singleUrl(it.data.text));
    else openTextViewer(it);
  } else if (act === 'open-hit') {
    ui.openPage = Number(a.dataset.page) || 0;
    openFile(it);
  } else if (act === 'download') {
    files.download(it);
  } else if (act === 'yt-mp3' || act === 'yt-m4a' || act === 'yt-mp4') {
    const u = singleUrl(it.data.text || '');
    if (u) downloadYoutube(u, act.slice(3), dropTitle(it));
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
    if (De.isAiText(it.data.text || '') || De.looksMarkdown(it.data.text || '') || De.plainText(it.data.text || '', declutterOpts() || {}) !== (it.data.text || '').trim()) {
    m.push({ icon: 'sparkle', label: 'Copy clean text', run: async () => { await copyText(De.plainText(it.data.text, declutterOpts() || {})); toast('Clean text copied'); } });
  }
    m.push({ icon: 'pen', label: url ? 'Rename link…' : 'Edit message…', run: () => renameDrop(it) });
    if (url) m.push({ icon: 'link', label: ytInfo(url) ? 'Play privately' : 'Open link', run: () => openUrl(url) });
    if (url && ytInfo(url)) {
      m.push({ icon: 'download', label: 'Download MP3', run: () => downloadYoutube(url, 'mp3', dropTitle(it)) });
      m.push({ icon: 'download', label: 'Download M4A Audio', run: () => downloadYoutube(url, 'm4a', dropTitle(it)) });
      m.push({ icon: 'download', label: 'Download Video (MP4)', run: () => downloadYoutube(url, 'mp4', dropTitle(it)) });
    }
    if (navigator.share && isTouch()) m.push({ icon: 'share', label: 'Share…', run: () => navigator.share(url ? { url } : { text: it.data.text }).catch(() => {}) });
    m.push({ icon: 'note', label: 'Save as note', run: () => saveClipAsNote(it) });
  } else {
    const p = files.progress.get(it.id);
    const kind = fileKind(it.data.type, it.data.name);
    if (p && p.state === 'err') m.push({ icon: 'upload', label: 'Try again', run: () => files.requeue(it.id) });
    m.push({ icon: 'eye', label: 'Open', run: () => openFile(it) });
    if (canMarkup(it)) m.push({ icon: 'crop', label: 'Edit (crop / hide details)', run: () => openMarkup(it) });
    if (canEditPdf(it)) m.push({ icon: 'pen', label: 'Edit text', run: () => openPdfEdit(it) });
    if (canEditDoc(it)) m.push({ icon: 'pen', label: 'Edit document', run: () => openDocEdit(it) });
    m.push({ icon: 'pen', label: 'Rename…', run: () => renameDrop(it) });
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

/* ───────── double-tap or hold empty space in Drops to upload files ───────── */

function initEmptyUpload() {
  const feed = el.feed;
  if (!feed) return;
  let tap = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let lastOpen = 0;

  const isEmptySpace = (t) => {
    if (!t || ui.tab !== 'drops' || ui.selecting || (lk && lk.mode)) return false;
    if (t.closest('article[data-id], button, a, input, textarea, select, [role="button"], .tile-more, .ri-more, .marquee')) return false;
    return feed.contains(t);
  };

  const spawnTapRing = (x, y) => {
    if (reducedMotion() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const ring = document.createElement('span');
    ring.className = 'feed-tap-ring';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 380);
  };

  const triggerUpload = (x, y) => {
    const now = Date.now();
    if (now - lastOpen < 450) return;
    lastOpen = now;
    haptic('heavy');
    spawnTapRing(x, y);
    el.fileInput.click();
  };

  const cancelHold = () => {
    if (!tap) return;
    clearTimeout(tap.timer);
  };

  feed.addEventListener('pointerdown', (e) => {
    if (e.isPrimary === false) { cancelHold(); tap = null; return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!isEmptySpace(e.target)) { tap = null; return; }
    const fr = feed.getBoundingClientRect();
    if (e.clientX > fr.right - 14) { tap = null; return; }
    cancelHold();
    const cur = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      pointerType: e.pointerType,
      target: e.target,
      moved: false,
      fired: false,
      timer: 0
    };
    cur.timer = setTimeout(() => {
      if (tap !== cur || cur.moved || !isEmptySpace(cur.target)) return;
      cur.fired = true;
      ui.suppressClick = true;
      setTimeout(() => { ui.suppressClick = false; }, 250);
      triggerUpload(cur.x, cur.y);
    }, 460);
    tap = cur;
  });

  feed.addEventListener('pointermove', (e) => {
    if (!tap || e.pointerId !== tap.id || tap.moved) return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) {
      tap.moved = true;
      clearTimeout(tap.timer);
    }
  }, { passive: true });

  const endTap = (e, cancelled) => {
    if (!tap || e.pointerId !== tap.id) return;
    const cur = tap;
    clearTimeout(cur.timer);
    tap = null;
    if (cancelled || cur.fired || cur.moved) return;
    if (e.pointerType !== 'mouse' && isEmptySpace(e.target)) {
      const now = Date.now();
      if (now - lastTap.t <= 340 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= 36) {
        lastTap.t = 0;
        e.preventDefault();
        triggerUpload(e.clientX, e.clientY);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  };
  feed.addEventListener('pointerup', (e) => endTap(e, false));
  feed.addEventListener('pointercancel', (e) => endTap(e, true));
  feed.addEventListener('scroll', () => {
    if (tap) { tap.moved = true; clearTimeout(tap.timer); }
  }, { passive: true });

  feed.addEventListener('dblclick', (e) => {
    if (!isEmptySpace(e.target)) return;
    const fr = feed.getBoundingClientRect();
    if (e.clientX > fr.right - 14) return;
    e.preventDefault();
    triggerUpload(e.clientX, e.clientY);
  });

  feed.addEventListener('contextmenu', (e) => {
    if ((Date.now() - lastOpen < 450 || ui.lastPointer === 'touch') && isEmptySpace(e.target)) {
      e.preventDefault();
    }
  });
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
    const ctl = await viewDocument(host, blob, { kind: dk, page: ui.openPage || 0, key: it.id, onLabel: (t) => { pct.textContent = t; } });
    ui.openPage = 0;
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
      { icon: 'clip', label: 'Add files…', run: () => el.fileInput.click() },
      { icon: 'doc', label: 'New document…', run: newDocument },
      { icon: 'folder', label: 'New folder…', run: async () => { const f = await createFolder(); if (f) setDropView('f:' + f.id); } },
      { icon: 'refresh', label: 'Sync now', run: () => { haptic('click'); refreshNow(); } },
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
  noteItemMenu(b, n, { x: e.clientX, y: e.clientY });
}
function noteItemMenu(b, n, at) {
  b.classList.add('ctx');
  ui.ctxNode = b;
  openMenu(null, [
    { icon: 'note', label: 'Open', run: () => openNote(n.id) },
    { icon: 'pin', label: n.data.pinned ? 'Unpin' : 'Pin to top', run: () => setNoteData(n, { pinned: !n.data.pinned || null }) },
    { icon: 'copy', label: 'Copy text', run: async () => { await copyText(noteText(n)); toast('Copied'); } },
    { icon: 'folder', label: 'Move to folder…', run: () => folderPick(n, null, at) },
    { icon: 'marker', label: 'Colour…', run: () => colorPick(n, null, at) },
    { icon: 'bell', label: n.data.remind ? `Reminder: ${remindLabel(n)}…` : 'Remind me…', run: () => remindMenu(null, [n]) },
    { icon: 'download', label: 'Save as PDF', run: () => saveNotesPdf([n]) },
    { icon: 'select', label: 'Select', run: () => enterNoteSelect(n.id) },
    { icon: 'archive', label: n.data.archived ? 'Unarchive' : 'Archive', run: () => archiveNote(n, !n.data.archived) },
    { icon: 'trash', label: 'Move to Trash', danger: true, run: () => deleteWithUndo(n, 'Note') }
  ], { at });
}
function archiveNote(n, on) {
  if (!n) return;
  if (on && ui.noteId === n.id) closeEditor();
  setNoteData(n, { archived: on || null });
  toast(on ? 'Note archived' : 'Note back in your notes', { action: 'Undo', onAction: () => setNoteData(n, { archived: on ? null : true }) });
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

async function renameDrop(it) {
  if (!it) return;
  if (it.kind === 'file') {
    const cur = it.data.name || '';
    const lastDot = cur.lastIndexOf('.');
    const ext = lastDot > 0 ? cur.slice(lastDot) : '';
    const res = await promptDialog('Rename file', 'File name', cur, { selectBase: true });
    if (!res) return;
    let next = res.trim();
    if (!next || next === cur) return;
    if (ext && !next.includes('.')) next += ext;
    next = next.slice(0, 255);
    it.data = { ...it.data, name: next };
    it.updated = Date.now();
    cards.delete(it.id);
    await store.save(it);
    sync.schedule();
    renderDrops();
    if (ui.viewing && ui.viewing.id === it.id) {
      el.viewerTitle.textContent = next;
    }
    toast('File renamed');
  } else if (it.kind === 'clip') {
    const url = singleUrl(it.data.text || '');
    if (url) {
      const curTitle = (it.data.link && it.data.link.title) || '';
      const res = await promptDialog('Rename link', 'Link title', curTitle || url);
      if (!res) return;
      const next = res.trim().slice(0, 200);
      if (!next || next === curTitle) return;
      it.data = { ...it.data, link: { ...(it.data.link || {}), title: next } };
      it.updated = Date.now();
      cards.delete(it.id);
      await store.save(it);
      sync.schedule();
      renderDrops();
      toast('Link renamed');
    } else {
      const cur = it.data.text || '';
      const res = await promptDialog('Edit message', 'Message text', cur);
      if (!res) return;
      const next = res.trim();
      if (!next || next === cur) return;
      it.data = { ...it.data, text: next };
      it.updated = Date.now();
      cards.delete(it.id);
      await store.save(it);
      sync.schedule();
      renderDrops();
      toast('Message updated');
    }
  }
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
  haptic('heavy');
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
  haptic('tick');
  ui.selected.has(id) ? ui.selected.delete(id) : ui.selected.add(id);
  renderSelectBar();
  renderDrops();
}
function renderSelectBar() {
  clearTimeout(ui.compRevealT);
  ui.compRevealT = 0;
  const wasSel = !el.selectBar.hidden && !el.selectBar.classList.contains('is-leaving');
  if (ui.selecting) {
    el.composer.classList.remove('is-entering');
    el.composer.hidden = true;
    setAnimatedVisible(el.selectBar, true, 130);
  } else if (wasSel && !reducedMotion()) {
    setAnimatedVisible(el.selectBar, false, 115);
    ui.compRevealT = setTimeout(() => {
      ui.compRevealT = 0;
      if (ui.selecting) return;
      el.composer.hidden = false;
      triggerAnim(el.composer, 'is-entering', ['is-entering'], 150);
    }, 115);
  } else {
    setAnimatedVisible(el.selectBar, false, 0);
    el.composer.hidden = false;
  }
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
  else if (act === 'pin') {
    const items = ids.map((id) => store.items.get(id)).filter(Boolean);
    const on = !items.every((x) => x.data.keep);
    for (const it of items) { it.data = { ...it.data, keep: on }; await store.save(it); }
    sync.schedule();
    exitSelect();
    toast(on ? `${items.length} pinned — they stay when old drops are cleaned up` : `${items.length} unpinned`);
  }
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

function promptDialog(title, placeholder, value, opts = {}) {
  return new Promise((resolve) => {
    el.promptInput.type = opts.secret ? 'password' : 'text';
    const pi = el.promptInput, ownKb = pi.getAttribute('inputmode') === 'none' && pi.dataset.skbIm !== undefined;
    const imWas = ownKb ? pi.dataset.skbIm : pi.getAttribute('inputmode');
    if (opts.secret) { if (ownKb) pi.dataset.skbIm = 'numeric'; else pi.setAttribute('inputmode', 'numeric'); }
    el.promptTitle.textContent = title;
    el.promptInput.placeholder = placeholder;
    el.promptInput.value = value || '';
    let result = null;
    el.promptForm.onsubmit = (e) => { e.preventDefault(); result = el.promptInput.value.trim() || null; el.dlgPrompt.close(); };
    el.dlgPrompt.addEventListener('close', () => {
      pi.type = 'text';
      if (opts.secret) { if (ownKb) pi.dataset.skbIm = imWas || ''; else if (imWas) pi.setAttribute('inputmode', imWas); else pi.removeAttribute('inputmode'); }
      resolve(result);
    }, { once: true });
    openDialog(el.dlgPrompt);
    setTimeout(() => {
      el.promptInput.focus();
      if (opts.selectBase && value && value.lastIndexOf('.') > 0) {
        el.promptInput.setSelectionRange(0, value.lastIndexOf('.'));
      } else {
        el.promptInput.select();
      }
    }, 30);
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
  haptic('click');
  el.composerInput.value = '';
  autosize();
  updateSend();
  if (sendAs() === 'note' || text.length > 50000) {
    const n = await createNote(text);
    if (ui.nfolder && ui.nfolder !== 'archive') setNoteData(n, { nf: ui.nfolder });
    renderNotesList();
    toast('Saved as a note', { action: 'Open', onAction: () => { setTab('notes'); openNote(n.id); } });
    return;
  }
  sendClip(text);
}
/** what typed text in the Drops box becomes on this device: 'note' (default) or 'drop' */
function sendAs() { return lsGet('sp-send-as', 'note') === 'drop' ? 'drop' : 'note'; }
function renderComposerHint() {
  el.composerInput.placeholder = sendAs() === 'note' ? 'Write a note…' : 'Type, paste or drop anything…';
  el.btnSend.title = sendAs() === 'note' ? 'Save as a note' : 'Send to your devices';
  el.btnSend.setAttribute('aria-label', el.btnSend.title);
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
    const j = await linkPreviewData(url);
    const cur = store.items.get(id);
    if (!cur || !j || !(j.title || j.desc || j.thumb)) return;
    cur.data = { ...cur.data, link: { title: j.title, site: j.site, desc: j.desc, isFavicon: !!j.isFavicon, ...(j.thumb ? { thumb: j.thumb } : {}) } };
    await store.save(cur);
    sync.schedule();
  } catch {}
}
/** title, site and a small picture for a web link (picture shrunk on this device to ~8 KB) */
const previewCache = new Map();
function linkPreviewData(url) {
  if (!previewCache.has(url)) {
    previewCache.set(url, (async () => {
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
      try {
        const r = await fetch(`/api/link?s=${store.get('space')}&img=1&url=${encodeURIComponent(url)}`);
        const j = await r.json();
        if (j && !j.error) {
          let isFavicon = !!j.isFavicon;
          let thumb = '';
          const rawImg = j.image || j.imageUrl || '';
          if (rawImg) thumb = await shrinkImage(rawImg, 240);
          if (!thumb && j.imageUrl && j.imageUrl !== rawImg) {
            thumb = await shrinkImage(j.imageUrl, 240);
          }
          if (!thumb && host) {
            thumb = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
            isFavicon = true;
          }
          return { title: j.title || host, site: j.site || host, desc: j.desc || '', thumb, isFavicon };
        }
      } catch {}
      if (host) {
        return {
          title: host,
          site: host,
          desc: '',
          thumb: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`,
          isFavicon: true
        };
      }
      return null;
    })().catch(() => { previewCache.delete(url); return null; }));
  }
  return previewCache.get(url);
}

function shrinkImage(src, max) {
  const isRemote = /^https?:\/\//i.test(src);
  const attempt = (withCors) => new Promise((resolve) => {
    const im = new Image();
    if (withCors && isRemote) im.crossOrigin = 'anonymous';
    im.onload = () => {
      if (isRemote && !withCors) { resolve(src); return; }
      try {
        const k = Math.min(1, max / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.naturalWidth * k));
        c.height = Math.max(1, Math.round(im.naturalHeight * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        let d = c.toDataURL('image/webp', 0.72);
        if (!d.startsWith('data:image/webp')) d = c.toDataURL('image/jpeg', 0.72);
        if (d.length >= 60000) d = c.toDataURL('image/jpeg', 0.5);
        resolve(d.length < 60000 ? d : (isRemote ? src : ''));
      } catch {
        resolve(isRemote ? src : '');
      }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
  return attempt(isRemote).then((res) => {
    if (res !== null) return res;
    if (isRemote) return attempt(false).then((r2) => r2 || '');
    return '';
  });
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  if (img.classList.contains('link-media-thumb') && !img.dataset.fbTried) {
    img.dataset.fbTried = '1';
    try {
      const u = new URL(img.src);
      if (/^https?:$/.test(u.protocol)) {
        img.classList.remove('link-media-thumb');
        img.classList.add('fav-icon');
        img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=128`;
        return;
      }
    } catch {}
  }
  if (img.classList.contains('link-media-thumb') || img.classList.contains('fav-icon') || img.closest('.link-card')) {
    img.style.display = 'none';
  }
}, true);

/* ───── links in notes: typed or pasted links become real links, with a small preview card ───── */
const URL_RE = /(^|[\s(\[{"'])((?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}])/gi;
function linkifyIn(root) {
  const made = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && n.parentElement.closest('a, code, pre, .link-card') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const tn of nodes) {
    const t = tn.nodeValue;
    URL_RE.lastIndex = 0;
    let m;
    let last = 0;
    const frag = document.createDocumentFragment();
    while ((m = URL_RE.exec(t))) {
      const start = m.index + m[1].length;
      frag.append(t.slice(last, start));
      const a = document.createElement('a');
      a.href = /^www\./i.test(m[2]) ? 'https://' + m[2] : m[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[2];
      frag.append(a);
      made.push(a);
      last = start + m[2].length;
    }
    if (!last) continue;
    frag.append(t.slice(last));
    tn.replaceWith(frag);
  }
  return made;
}
function topBlock(n) {
  while (n && n.parentNode && n.parentNode !== el.editorText) n = n.parentNode;
  return n && n.parentNode === el.editorText ? n : null;
}
function autoLink(prevToo) {
  const s = getSelection();
  if (!s.rangeCount) return;
  const blk = topBlock(s.anchorNode);
  const blocks = [];
  if (blk && blk.nodeType === 1) blocks.push(blk); else if (blk) blocks.push(el.editorText);
  if (prevToo && blk && blk.previousElementSibling) blocks.push(blk.previousElementSibling);
  const off = caretOffset();
  let made = [];
  for (const b of blocks) made = made.concat(linkifyIn(b));
  if (!made.length) return;
  if (off != null) setCaretOffset(off);
  onEditorInput();
  for (const a of made.slice(0, 3)) addLinkCard(a);
}
function linkifyAfterPaste() {
  const off = caretOffset();
  const made = linkifyIn(el.editorText);
  if (!made.length) return;
  if (off != null) setCaretOffset(off);
  onEditorInput();
  if (made.length <= 3) for (const a of made) addLinkCard(a);
}
function applyLinkTitleToNote(title, url) {
  if (!title || !ui.noteId) return;
  const n = openNoteItem();
  if (!n) return;
  const curTitle = noteTitle(noteText(n));
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const isUntitled = !curTitle ||
    curTitle === 'Untitled' ||
    curTitle === url ||
    curTitle === host ||
    curTitle.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') === url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') ||
    /^https?:\/\//i.test(curTitle) ||
    /^www\./i.test(curTitle);

  if (!isUntitled) return;

  const existingH = el.editorText.querySelector('h1, h2');
  if (existingH && (!existingH.textContent.trim() || existingH.textContent.trim() === 'Untitled' || /^https?:\/\//i.test(existingH.textContent.trim()))) {
    existingH.textContent = title;
  } else if (!existingH) {
    const h = document.createElement('h1');
    h.textContent = title;
    const firstChild = el.editorText.firstElementChild;
    if (firstChild) el.editorText.insertBefore(h, firstChild);
    else el.editorText.appendChild(h);
  }
  onEditorInput();
  saveNote.flush();
  renderNotesList();
}

async function addLinkCard(a) {
  if (!navigator.onLine || !a.isConnected) return;
  const url = a.href;
  if ([...el.editorText.querySelectorAll('a.link-card')].some((c) => c.href === url)) return;
  const noteId = ui.noteId;
  const p = await linkPreviewData(url);
  if (!p || !(p.title || p.thumb) || ui.noteId !== noteId || !a.isConnected) return;
  if ([...el.editorText.querySelectorAll('a.link-card')].some((c) => c.href === url)) return;

  // Apply title of YouTube video / X / Instagram / Facebook / any link to note
  if (p && p.title) {
    applyLinkTitleToNote(p.title, url);
  }

  const blk = topBlock(a) || a;
  if (!blk) return;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const card = document.createElement('a');
  card.className = `link-card${p.isFavicon ? ' has-fav' : ''}`;
  card.href = url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.contentEditable = 'false';
  let thumbHtml = '';
  if (p.thumb) {
    if (p.isFavicon) {
      thumbHtml = `<span class="lc-fav-wrap"><img class="lc-fav" src="${esc(p.thumb)}" alt="" loading="lazy"></span>`;
    } else {
      thumbHtml = `<img class="lc-img" src="${esc(p.thumb)}" alt="" loading="lazy">`;
    }
  }
  card.innerHTML = `${thumbHtml}<span class="lc-t">${esc(p.title || host)}</span><span class="lc-d">${esc(p.site || host)}</span>${ytInfo(url) ? ytCardActsHTML() : ''}`;
  blk.after(card);
  if (!card.nextSibling) { const q = document.createElement('p'); q.innerHTML = '<br>'; card.after(q); }
  onEditorInput();
}

function showLinkBubble(a) {
  let b = ui.linkBubble;
  if (!b) {
    b = document.createElement('div');
    b.className = 'link-bubble';
    b.innerHTML = '<a class="lb-open" target="_blank" rel="noopener noreferrer"><svg class="ic"><use href="#i-link"/></svg><span class="lb-url"></span></a>' +
      '<button class="yt-dl-btn" data-yt-dl="mp3" title="Download MP3" hidden>MP3</button>' +
      '<button class="yt-dl-btn" data-yt-dl="m4a" title="Download M4A Audio" hidden>M4A</button>' +
      '<button class="yt-dl-btn" data-yt-dl="mp4" title="Download Video (MP4)" hidden>Video</button>' +
      '<button class="icon-btn sm" data-lb="copy" title="Copy link" aria-label="Copy link"><svg class="ic"><use href="#i-copy"/></svg></button>' +
      '<button class="icon-btn sm" data-lb="unlink" title="Remove link" aria-label="Remove link"><svg class="ic"><use href="#i-x"/></svg></button>';
    document.body.appendChild(b);
    b.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    b.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-lb]');
      const link = ui.linkFor;
      if (e.target.closest('.lb-open')) { setTimeout(hideLinkBubble, 50); return; }
      if (!btn || !link) return;
      if (btn.dataset.lb === 'copy') { await copyText(link.href); toast('Link copied'); }
      else if (link.isConnected) { link.replaceWith(...link.childNodes); onEditorInput(); }
      hideLinkBubble();
    });
    document.addEventListener('pointerdown', (e) => { if (ui.linkBubble && !ui.linkBubble.hidden && !ui.linkBubble.contains(e.target) && !(e.target.closest && e.target.closest('#editor-text a[href]'))) hideLinkBubble(); }, true);
    el.editorText.addEventListener('scroll', hideLinkBubble, { passive: true });
    el.editorText.addEventListener('keydown', hideLinkBubble);
    ui.linkBubble = b;
  }
  ui.linkFor = a;
  const open = b.querySelector('.lb-open');
  open.href = a.href;
  const isYt = !!ytInfo(a.href);
  for (const dl of $$('[data-yt-dl]', b)) {
    dl.hidden = !isYt;
    if (isYt) dl.dataset.ytUrl = a.href;
  }
  b.querySelector('.lb-url').textContent = a.href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 48) + ' ↗';
  setAnimatedVisible(b, true, 125);
  const r = a.getBoundingClientRect();
  const bw = b.offsetWidth;
  b.style.left = Math.max(8, Math.min(innerWidth - bw - 8, r.left)) + 'px';
  b.style.top = (r.bottom + 6 + b.offsetHeight > innerHeight ? r.top - b.offsetHeight - 6 : r.bottom + 6) + 'px';
}
function hideLinkBubble() { setAnimatedVisible(ui.linkBubble, false, 105); }

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
  if (n.data.parts) return sanitizeNote(joinParts(n));
  return n.data.html != null ? sanitizeNote(n.data.html) : markdownToHtml(n.data.body || '');
}

const NOTE_COLORS = [['red', '#e03131', 'Red'], ['orange', '#f08c00', 'Orange'], ['yellow', '#f5b700', 'Yellow'], ['green', '#2f9e44', 'Green'], ['blue', '#1c7ed6', 'Blue'], ['purple', '#7048e8', 'Purple'], ['pink', '#d6336c', 'Pink']];
const NOTE_FONTS = [['', 'Outfit — modern (default)'], ['lora', 'Lora — elegant serif'], ['caveat', 'Caveat — handwriting'], ['system', 'System font']];
const NOTE_PAPERS = [['', 'White, textured', '#ffffff'], ['smooth', 'Plain (smooth)', 'transparent'], ['sepia', 'Cream', '#f3ead6'], ['sepia-lined', 'Cream, lined', '#efe3c6'], ['lined', 'Notebook, lined', '#f4f6fb'],
  ['grid', 'Squared (graph paper)', '#eef2f8'], ['dots', 'Dotted', '#f3f2ee'], ['recycled', 'Recycled', '#e8e2d5'], ['kraft', 'Kraft brown', '#d8c29d'],
  ['linen', 'Linen', '#f1ece3'], ['mint', 'Mint', '#e2f2e9'], ['night', 'Night (dark)', '#1b1e25']];
const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
function noteFolders() { const st = store.items.get('settings'); return (st && st.data.noteFolders) || []; }
async function saveNoteFolders(list) {
  const cur = store.items.get('settings');
  const item = cur || { id: 'settings', kind: 'settings', rev: 0, created: Date.now(), data: {} };
  item.data = { ...item.data, noteFolders: list };
  await store.save(item);
  sync.schedule();
}
function notesSorted(archived = ui.nfolder === 'archive') {
  const sort = lsGet('sp-nsort', 'edited');
  const ci = (n) => { const i = NOTE_COLORS.findIndex((c) => c[0] === n.data.color); return i < 0 ? 99 : i; };
  const by = {
    edited: (a, b) => b.updated - a.updated,
    created: (a, b) => b.created - a.created,
    title: (a, b) => noteTitle(noteText(a)).localeCompare(noteTitle(noteText(b)), undefined, { sensitivity: 'base', numeric: true }),
    color: (a, b) => ci(a) - ci(b) || b.updated - a.updated,
    custom: (a, b) => posOf(b) - posOf(a)
  }[sort] || ((a, b) => b.updated - a.updated);
  return store
    .list('note')
    .filter((n) => !n.data.trashed && !!n.data.archived === archived)
    .sort((a, b) => (b.data.pinned ? 1 : 0) - (a.data.pinned ? 1 : 0) || by(a, b));
}
function setNoteData(n, patch) {
  if (!n) return;
  n.data = { ...n.data, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] == null) delete n.data[k];
  if (ui.noteId === n.id) renderEditor(false);
  if (!store.items.has(n.id)) return;
  store.save(n).then(() => { sync.schedule(); renderNotesList(); });
}
function pickMenu(anchor, title, list, cur, apply, at) {
  openMenu(anchor, list.map(([v, label, color]) => ({
    html: `${color ? `<span class="menu-swatch" style="--c:${color}"></span>` : `<svg class="ic"><use href="#i-${v === cur ? 'check' : 'box'}"/></svg>`}<span>${esc(label)}${v === cur && color ? ' ✓' : ''}</span>`,
    run: () => apply(v)
  })), at ? { at } : {});
}
function colorPick(n, anchor, at) { pickMenu(anchor, 'Colour', [['', 'No colour', 'transparent'], ...NOTE_COLORS.map(([v, c, l]) => [v, l, c])], n.data.color || '', (v) => setNoteData(n, { color: v || null }), at); }
function fontPick(n, anchor, at) { pickMenu(anchor, 'Font', NOTE_FONTS, n.data.font === 'outfit' ? '' : n.data.font || '', (v) => setNoteData(n, { font: v || null }), at); }
function paperPick(n, anchor, at) { pickMenu(anchor, 'Paper', NOTE_PAPERS, n.data.paper || '', (v) => setNoteData(n, { paper: v || null }), at); }
function folderPick(n, anchor, at) {
  const fs = noteFolders();
  pickMenu(anchor, 'Folder', [['', 'No folder'], ...fs.map((f) => [f.id, f.name]), ['+new', '＋ New folder…']], n.data.nf || '', async (v) => {
    if (v === '+new') { const f = await newNoteFolder(); if (f) moveNoteToFolder(n, f.id); return; }
    moveNoteToFolder(n, v || null);
  }, at);
}
function moveNoteToFolder(n, id) {
  if (!n) return;
  setNoteData(n, { nf: id || null });
  const f = noteFolders().find((x) => x.id === id);
  toast(f ? `Moved to “${f.name}”` : 'Removed from its folder');
}
async function newNoteFolder() {
  const name = await promptDialog('New notes folder', 'e.g. Class 9B, Lessons, Private', '');
  if (!name || !name.trim()) return null;
  const f = { id: rid(10), name: name.trim().slice(0, 40) };
  await saveNoteFolders([...noteFolders(), f]);
  renderNotesList();
  return f;
}
function onFolderChipClick(e) {
  const c = e.target.closest('[data-nf]');
  if (!c) return;
  if (c.dataset.nf === '+new') { newNoteFolder(); return; }
  const next = c.dataset.nf === 'all' ? null : c.dataset.nf;
  const changed = ui.nfolder !== next;
  ui.nfolder = next;
  renderNotesList();
  if (changed) triggerAnim(el.noteList, 'view-swap', ['view-swap'], 160);
}
function onFolderChipContext(e) {
  const c = e.target.closest('[data-nf]');
  if (!c || c.dataset.nf === 'all' || c.dataset.nf === '+new' || c.dataset.nf === 'archive') return;
  e.preventDefault();
  const f = noteFolders().find((x) => x.id === c.dataset.nf);
  if (!f) return;
  openMenu(null, [
    { icon: 'pen', label: 'Rename', run: async () => { const name = await promptDialog('Rename folder', '', f.name); if (name && name.trim()) { await saveNoteFolders(noteFolders().map((x) => (x.id === f.id ? { ...x, name: name.trim().slice(0, 40) } : x))); renderNotesList(); } } },
    { icon: 'trash', label: 'Delete folder (keeps the notes)', danger: true, run: async () => { await saveNoteFolders(noteFolders().filter((x) => x.id !== f.id)); if (ui.nfolder === f.id) ui.nfolder = null; renderNotesList(); } }
  ], { at: { x: e.clientX, y: e.clientY } });
}
function notesViewMenu(anchor) {
  const view = lsGet('sp-nview', 'list');
  const size = lsGet('sp-nsize', 'm');
  const sort = lsGet('sp-nsort', 'edited');
  const it = (on, label, run) => ({ html: `<svg class="ic"><use href="#i-${on ? 'check' : 'box'}"/></svg><span>${label}</span>`, run });
  const set = (k, v) => () => { lsSet(k, v); renderNotesList(); triggerAnim(el.noteList, 'view-swap', ['view-swap'], 160); };
  openMenu(anchor, [
    it(view === 'list', 'List', set('sp-nview', 'list')),
    it(view === 'grid', 'Grid', set('sp-nview', 'grid')),
    it(size === 's', 'Size: small', set('sp-nsize', 's')),
    it(size === 'm', 'Size: medium', set('sp-nsize', 'm')),
    it(size === 'l', 'Size: large', set('sp-nsize', 'l')),
    it(sort === 'edited', 'Sort: last edited', set('sp-nsort', 'edited')),
    it(sort === 'created', 'Sort: date created', set('sp-nsort', 'created')),
    it(sort === 'title', 'Sort: title A–Z', set('sp-nsort', 'title')),
    it(sort === 'color', 'Sort: colour', set('sp-nsort', 'color')),
    it(sort === 'custom', 'Sort: my order (hold & drag a note)', set('sp-nsort', 'custom'))
  ]);
}

/* long-press a note on mobile: opens its menu */
function setupNoteLongPress() {
  let s = null;
  el.noteList.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const b = e.target.closest('.note-item');
    ui.blockClick = false;
    if (!b) return;
    s = { b, x: e.clientX, y: e.clientY };
    const held = s;
    s.hold = setTimeout(() => {
      if (s !== held) return;
      s = null;
      ui.blockClick = true; // the finger lifting must not open the note
      haptic('heavy');
      const n = store.items.get(b.dataset.id);
      if (n) noteItemMenu(b, n, { x: held.x, y: held.y });
    }, 500);
  });
  const cancel = () => { if (s) { clearTimeout(s.hold); s = null; } };
  el.noteList.addEventListener('pointermove', (e) => {
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancel();
  });
  el.noteList.addEventListener('pointerup', cancel);
  el.noteList.addEventListener('pointercancel', cancel);
}

/* swipe between Drops and Notes: finger on phones, two-finger trackpad swipe on computers */
function tabSwipeBlocked(target, dir) {
  if (ui.presenting || ui.selecting || ui.nselecting || document.documentElement.classList.contains('rd-dragging') || $('dialog[open]') || !el.menu.hidden) return true;
  if (el.lock && !el.lock.hidden) return true;
  if (isMobileLayout() && el.app.classList.contains('editing')) return true;
  if (!target || !target.closest) return true;
  if (target.closest('.cv-scroll, .menu, .toasts, .img-bar')) return true;
  // let anything that scrolls sideways (chip rows, wide tables, code blocks…) keep its own swipe
  for (let n = target; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 8) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        if (dir == null) return true;
        if (dir > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return true;
      }
    }
  }
  return false;
}
function swipeToTab(next, dir) {
  if (next === ui.tab) return;
  haptic('tick');
  setTab(next, { dir });
}
function setupTabSwipe() {
  const views = $('.views');
  let t = null;
  views.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || tabSwipeBlocked(e.target)) { t = null; return; }
    const p = e.touches[0];
    t = { x: p.clientX, y: p.clientY, t0: Date.now(), on: false, view: ui.tab === 'notes' ? el.viewNotes : el.viewDrops };
  }, { passive: true });
  views.addEventListener('touchmove', (e) => {
    if (!t) return;
    const p = e.touches[0];
    const dx = p.clientX - t.x;
    const dy = p.clientY - t.y;
    if (!t.on) {
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { t = null; return; }
      if (Math.abs(dx) < 16) return;
      const next = dx < 0 ? 'notes' : 'drops';
      if (next === ui.tab) { t = null; return; }
      t.on = true;
    }
    t.dx = dx;
    t.view.style.transform = `translateX(${dx * 0.35}px)`;
    t.view.style.opacity = String(Math.max(0.55, 1 - Math.abs(dx) / 900));
  }, { passive: true });
  const end = () => {
    if (!t) return;
    const { on, dx = 0, t0, view } = t;
    t = null;
    if (!on) return;
    view.style.transition = 'transform .16s ease, opacity .16s ease';
    view.style.transform = '';
    view.style.opacity = '';
    setTimeout(() => { view.style.transition = ''; }, 170);
    const fast = Math.abs(dx) > 40 && Date.now() - t0 < 250;
    if (Math.abs(dx) > Math.min(110, innerWidth * 0.22) || fast) swipeToTab(dx < 0 ? 'notes' : 'drops', dx);
  };
  views.addEventListener('touchend', end, { passive: true });
  views.addEventListener('touchcancel', end, { passive: true });

  // trackpad / desktop swipe: instant tab switch on horizontal flick/gesture
  let lastTabSwitch = 0;
  let g = null;
  const settle = () => { g = null; };
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const now = performance.now();
    // Ignore residual inertial momentum from the swipe that just triggered a switch
    if (now - lastTabSwitch < 350) return;
    if (g && now - g.last > 200) settle();
    if (!g) {
      if (!dx || Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.1) return;
      if (tabSwipeBlocked(e.target, dx > 0 ? 1 : -1)) return;
      g = { x: 0, y: 0, last: now, done: false };
    }
    g.x += dx;
    g.y += dy;
    g.last = now;
    if (Math.abs(g.y) > Math.abs(g.x) * 1.3 && Math.abs(g.y) > 25) { settle(); return; }
    if (g.done) return;
    const next = g.x > 0 ? 'notes' : 'drops';
    if (next !== ui.tab && Math.abs(g.x) >= 20) {
      g.done = true;
      lastTabSwitch = now;
      e.preventDefault();
      // If an input/editor had focus, blur it smoothly so keyboard focus moves with tab
      if (document.activeElement && (document.activeElement === el.editorText || document.activeElement === el.composerInput)) {
        try { document.activeElement.blur(); } catch {}
      }
      setTab(next);
      clearTimeout(g.timer);
      g.timer = setTimeout(settle, 300);
      return;
    }
  }, { passive: false });
}

/* phones: keep the editor and its bars above the keyboard */
function fitToKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const fit = () => {
    ui.vvMax = Math.max(ui.vvMax || 0, vv.height);
    const open = vv.height < ui.vvMax - 150;
    const overlay = window.innerHeight - vv.height - vv.offsetTop > 90; // keyboard drawn over the page instead of resizing it
    el.app.classList.toggle('kb-open', open);
    el.app.classList.toggle('kb-overlay', overlay);
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    if (overlay && window.scrollY) window.scrollTo(0, 0);
    if (document.activeElement === el.editorText) {
      const sel = getSelection();
      const r = sel.rangeCount && sel.getRangeAt(0).getBoundingClientRect();
      const box = el.editorText.getBoundingClientRect();
      if (r && r.height) {
        const bottom = Math.min(box.bottom, vv.offsetTop + vv.height) - 24;
        if (r.bottom > bottom) el.editorText.scrollTop += r.bottom - bottom;
      }
    }
    positionPasteChip();
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  addEventListener('orientationchange', () => { ui.vvMax = 0; setTimeout(fit, 400); });
  fit();
}

/* "Paste" chip above the keyboard (also pastes photos) */
function setupPasteChip() {
  const chip = document.createElement('button');
  chip.className = 'paste-chip';
  chip.hidden = true;
  chip.innerHTML = '<svg class="ic"><use href="#i-paste"/></svg><span>Paste</span>';
  document.body.appendChild(chip);
  ui.pasteChip = chip;
  chip.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard open
  chip.addEventListener('click', pasteFromClipboard);
  const update = () => setTimeout(positionPasteChip, 30);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
}
function pasteTarget() {
  const a = document.activeElement;
  if (!a || !isTouch()) return null;
  if (a === el.composerInput || a === el.editorText) return a;
  return null;
}
function positionPasteChip() {
  const chip = ui.pasteChip;
  if (!chip) return;
  const t = pasteTarget();
  const vv = window.visualViewport;
  const show = !!t && el.app.classList.contains('kb-open') && !!(navigator.clipboard && navigator.clipboard.read) && !ui.presenting;
  chip.hidden = !show;
  if (!show) return;
  if (t === el.composerInput) {
    // sit just above the message box, never on top of its buttons
    const r = el.composer.getBoundingClientRect();
    chip.style.left = r.left + 6 + 'px';
    chip.style.right = 'auto';
    chip.style.top = r.top - chip.offsetHeight - 8 + 'px';
  } else {
    chip.style.left = 'auto';
    chip.style.right = '12px';
    chip.style.top = (vv ? vv.offsetTop + vv.height : innerHeight) - chip.offsetHeight - 10 + 'px';
  }
}
async function pasteFromClipboard() {
  const t = pasteTarget();
  if (!t) return;
  let items;
  try { items = await navigator.clipboard.read(); } catch { toast('Allow SyncPad to see what you copied, then try again.'); return; }
  const fl = [];
  let text = '';
  let html = '';
  for (const it of items) {
    const img = it.types.find((ty) => ty.startsWith('image/'));
    if (img) { const b = await it.getType(img); fl.push(new File([b], `Pasted ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.${img.split('/')[1] || 'png'}`, { type: img })); continue; }
    if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
    if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
  }
  if (!fl.length && !text && !html) { toast('Nothing copied yet'); return; }
  if (t === el.composerInput) {
    if (fl.length) { sendFiles(fl); return; }
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    if (html) dt.setData('text/html', html);
    const ev = { clipboardData: dt, preventDefault() {} };
    if (!cleanComposerPaste(ev)) { el.composerInput.focus(); document.execCommand('insertText', false, text); autosize(); updateSend(); }
    return;
  }
  if (fl.length) { attachToNote(fl); return; }
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  if (html) dt.setData('text/html', html);
  pasteIntoEditor({ clipboardData: dt, preventDefault() {} });
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
  const fs = noteFolders();
  const nArch = store.list('note').filter((n) => n.data.archived && !n.data.trashed).length;
  if (ui.nfolder === 'archive' && !nArch) ui.nfolder = null;
  if (ui.nfolder && ui.nfolder !== 'archive' && !fs.some((f) => f.id === ui.nfolder)) ui.nfolder = null;
  el.nfolderChips.innerHTML = `<button class="chip" data-nf="all" aria-pressed="${!ui.nfolder}">All</button>` +
    fs.map((f) => `<button class="chip" data-nf="${f.id}" aria-pressed="${ui.nfolder === f.id}"><svg class="ic"><use href="#i-folder"/></svg>${esc(f.name)} <b>${all.filter((n) => n.data.nf === f.id).length}</b></button>`).join('') +
    '<button class="chip chip-add" data-nf="+new" title="New folder"><svg class="ic"><use href="#i-plus"/></svg><span>Folder</span></button>' +
    (nArch ? `<button class="chip" data-nf="archive" aria-pressed="${ui.nfolder === 'archive'}"><svg class="ic"><use href="#i-archive"/></svg>Archive <b>${nArch}</b></button>` : '');
  const view = lsGet('sp-nview', 'list');
  el.noteList.className = `note-list view-${view} size-${lsGet('sp-nsize', 'm')}${ui.nfolder === 'archive' ? ' in-archive' : ''}`;
  const ts = terms(ui.query);
  const q = ts.length;
  const list = all.filter((n) => (!ui.nfolder || ui.nfolder === 'archive' || n.data.nf === ui.nfolder) && (!ui.tag || noteTags(noteText(n)).includes(ui.tag)) && (!q || noteMatches(n, ts)));
  el.noteList.classList.toggle('selecting', ui.nselecting);
  renderNoteSelectBar();
  if (!list.length) {
    el.noteList.innerHTML = `<div class="list-empty">${q || ui.tag ? 'No notes match.' : ui.nfolder ? 'No notes in this folder yet.<br>Drag notes onto the folder, or use ⋯ → Move to folder.' : 'No notes yet.<br>Notes sync to all your devices as you type.'}</div>`;
    return;
  }
  el.noteList.innerHTML = list
    .map((n) => { const m = noteMedia(n); const sel = ui.nselecting && ui.nsel.has(n.id); return `<button class="note-item${m.thumb ? ' has-thumb' : ''}${n.data.paper ? '' : ' tex'}${sel ? ' selected' : ''}" role="listitem" data-id="${n.id}" aria-current="${n.id === ui.noteId}"${n.data.color ? ` data-color="${esc(n.data.color)}"` : ''}${isTouch() ? '' : ' draggable="true"'}>
      ${ui.nselecting ? '<span class="ri-check ni-check" aria-hidden="true"><svg class="ic"><use href="#i-check"/></svg></span>' : ''}
      ${m.thumb ? `<img class="ni-thumb" src="${esc(m.thumb)}" alt="" loading="lazy" draggable="false">` : ''}
      <div class="t">${n.data.pinned ? '<svg class="ic"><use href="#i-pin"/></svg>' : ''}${n.data.canvas ? '<svg class="ic"><use href="#i-canvas"/></svg>' : ''}<span>${esc(noteTitle(noteText(n)))}</span></div>
      ${(() => { const hs = q ? noteHit(n, ts) : ''; if (hs) return `<div class="s hit">${hs}</div>`; const sn = noteSnippet(noteText(n), 600, '\n'); return sn ? `<div class="s">${esc(sn)}</div>` : ''; })()}
      <div class="d">${esc(shortDate(n.updated))}${n.data.remind ? `<span class="ni-badge ni-remind${remindNext(n) ? '' : ' past'}" title="Reminder"><svg class="ic"><use href="#i-bell"/></svg>${esc(remindLabel(n))}</span>` : ''}${n.data.parts ? `<span class="ni-badge" title="Long note"><svg class="ic"><use href="#i-book"/></svg>${Math.max(1, Math.round((n.data.chars || 0) / 1800))} p.</span>` : ''}${m.imgs ? `<span class="ni-badge" title="${m.imgs} picture${m.imgs > 1 ? 's' : ''}"><svg class="ic"><use href="#i-image"/></svg>${m.imgs > 1 ? m.imgs : ''}</span>` : ''}${m.files ? `<span class="ni-badge" title="${m.files} file${m.files > 1 ? 's' : ''}"><svg class="ic"><use href="#i-clip"/></svg>${m.files > 1 ? m.files : ''}</span>` : ''}${n.data.conflictOf ? ' · <span class="warn">Conflict copy</span>' : ''}</div>
    </button>`; })
    .join('');
  layoutNoteGrid();
}

/** grid view: each card takes only the height it needs, cards pack like a masonry wall */
function layoutNoteGrid() {
  const L = el.noteList;
  if (!L.classList.contains('view-grid')) { L.classList.remove('masonry'); return; }
  if (!L.offsetWidth) return;
  L.classList.add('masonry');
  const items = [...L.querySelectorAll(':scope > .note-item')];
  for (const b of items) b.style.gridRowEnd = '';
  const gap = parseFloat(getComputedStyle(L).columnGap) || 8;
  const hs = items.map((b) => b.offsetHeight); // layout height: a pinch's scale never skews it
  items.forEach((b, i) => { b.style.gridRowEnd = `span ${Math.max(1, Math.ceil((hs[i] + gap) / 2))}`; });
}

/** pictures and files inside a note (normal or canvas), for the list */
function noteMedia(n) {
  const html = n.data.html || '';
  const imgs = [...html.matchAll(/<img\b[^>]*data-file="([^"]+)"/g)].map((x) => x[1]);
  const files = (html.match(/<a\b[^>]*data-file="/g) || []).length;
  let thumb = null;
  for (const id of imgs) {
    const it = store.items.get(id);
    if (it && it.data.trashed) continue;
    thumb = (it && it.data.thumb) || files_src(id);
    if (thumb) break;
  }
  if (!thumb) {
    const linkImg = html.match(/<img\b[^>]*class=["'][^"']*lc-img[^"']*["'][^>]*src=["']([^"']+)["']/i) ||
                    html.match(/<img\b[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*lc-img[^"']*["']/i);
    // Don't treat tiny favicons as large note banner thumbnails
    if (linkImg && linkImg[1] && !linkImg[1].includes('s2/favicons') && !linkImg[1].includes('/favicon.ico')) thumb = linkImg[1];
  }
  return { imgs: imgs.length, files, thumb };
}
const files_src = (id) => { try { return files.src(id); } catch { return null; } };

/* remember where each note was scrolled to (per device) */
const NOTE_POS = 'sp-note-pos';
function notePosMap() { try { return JSON.parse(localStorage.getItem(NOTE_POS) || '{}'); } catch { return {}; } }
function saveNotePos() {
  const id = ui.noteId, ed = el.editorText;
  if (!id || !ed || ui.restoringPos) return;
  const m = notePosMap(), max = ed.scrollHeight - ed.clientHeight;
  if (ed.scrollTop < 20 || max <= 0) delete m[id]; else m[id] = [Math.round(ed.scrollTop), ed.scrollTop / max, Date.now()];
  const keys = Object.keys(m);
  if (keys.length > 300) keys.sort((a, b) => m[a][2] - m[b][2]).slice(0, keys.length - 300).forEach((k) => delete m[k]);
  try { localStorage.setItem(NOTE_POS, JSON.stringify(m)); } catch {}
}
function restoreNotePos(id) {
  const p = notePosMap()[id];
  if (!p) return;
  const ed = el.editorText;
  ui.restoringPos = true;
  const go = () => { if (ui.noteId !== id) return; const max = ed.scrollHeight - ed.clientHeight; ed.scrollTop = Math.min(max, Math.max(0, Math.round(p[1] * max))); };
  requestAnimationFrame(go);
  setTimeout(go, 120);
  setTimeout(() => { go(); ui.restoringPos = false; }, 400);
}
let notePosT = 0;
let editBtnT = 0;
/* phones: while only reading a note, swipe right to go back to the notes list */
(() => {
  let sx = 0, sy = 0, st = 0, ok = false;
  document.addEventListener('touchstart', (e) => {
    ok = e.touches.length === 1 && ui.readMode && isMobileLayout() && el.editor.contains(e.target) && !e.target.closest('.fmt-bar, .tts-bar, .edit-toggle, img, table, pre, .zoom-stage');
    if (!ok) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, { passive: true, capture: true });
  document.addEventListener('touchend', (e) => {
    if (!ok || e.touches.length) return;
    ok = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    const sel = getSelection();
    if (dx > 90 && Math.abs(dy) < dx * 0.5 && Date.now() - st < 800 && (!sel || sel.isCollapsed) && ui.readMode) el.btnEditorBack.click();
  }, { passive: true, capture: true });
})();
document.addEventListener('scroll', (e) => {
  if (e.target !== el.editorText) return;
  clearTimeout(notePosT); notePosT = setTimeout(saveNotePos, 250);
}, true);

function openNote(id, { focus = true } = {}) {
  clearTimeout(ui.editorLeaveT);
  ui.editorLeaveT = 0;
  clearTimeout(ui.sideLeaveT);
  ui.sideLeaveT = 0;
  el.app.classList.remove('editor-leaving', 'sidebar-leaving');
  if (ui.selMode && ui.noteId !== id) setSelectMode(false);
  if (ui.tab !== 'notes') setTab('notes');
  if (ui.noteId && ui.noteId !== id) saveNote.flush();
  const prevId = ui.noteId;
  const wasOpen = !!prevId;
  if (ui.noteId !== id) { currentZoom = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], zoomForNote(id))); applyZoomStyles(); }
  ui.noteId = id;
  ui.noteEdits = 0;
  ui.noteRedos = 0;
  ui.savedRange = null;
  el.app.classList.remove('show-sidebar');
  if (isMobileLayout()) {
    if (!el.app.classList.contains('editing')) {
      el.app.classList.add('editing');
      pushLayer({ key: 'editor', close: () => closeEditor(true) });
    }
  } else if (!layers.some((l) => l.key === 'editor')) {
    pushLayer({ key: 'editor', close: () => closeEditor(true) });
  }
  // on phones a note opens for reading: taps don't pop the keyboard until you press Edit
  const nn = store.items.get(id);
  ui.readMode = isTouch() && !!(nn && (nn.data.text || nn.data.html)) && !(nn.data.canvas);
  applyNotesList();
  renderEditor(true);
  renderNotesList();
  if (!isMobileLayout()) {
    if (!wasOpen) triggerAnim(el.editorPane, 'pane-in', ['pane-in'], 190);
    else if (prevId !== id) triggerAnim(el.editor, 'note-swap', ['note-swap'], 160);
  }
  if (focus && !isTouch()) focusEditorEnd();
}

function renderEditToggle() {
  let b = document.getElementById('edit-toggle');
  if (!isTouch()) { if (b) b.hidden = true; return; }
  if (!b) {
    b = document.createElement('button');
    b.id = 'edit-toggle';
    b.className = 'edit-toggle';
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => setReadMode(!ui.readMode));
    el.editor.append(b);
  }
  const n = ui.noteId && (store.items.get(ui.noteId) || (ui.newNote && ui.newNote.id === ui.noteId ? ui.newNote : null));
  b.hidden = !n || !!(n.data && n.data.canvas) || el.editor.classList.contains('parts-waiting');
  b.innerHTML = ui.readMode
    ? '<svg class="ic"><use href="#i-pen"/></svg><span>Edit</span>'
    : '<svg class="ic" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Done</span>';
  b.classList.toggle('done', !ui.readMode);
}
function setReadMode(on) {
  ui.readMode = on;
  const ed = el.editorText;
  ed.contentEditable = on ? 'false' : 'true';
  el.editor.classList.toggle('reading', on);
  if (on) { saveNote.flush && saveNote.flush(); ed.blur(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
  else {
    const sel = getSelection();
    ed.focus({ preventScroll: true });
    if (!sel.rangeCount || !ed.contains(sel.anchorNode)) {
      // put the cursor at the first line you can see
      const r = ed.getBoundingClientRect();
      const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(r.left + 30, r.top + 40) : null;
      if (pos && ed.contains(pos.startContainer)) { sel.removeAllRanges(); sel.addRange(pos); }
    }
  }
  renderEditToggle();
}

function newNote(opts) {
  const canvas = !!(opts && opts.canvas);
  if (ui.tab !== 'notes') setTab('notes');
  const now = Date.now();
  ui.newNote = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { html: '', text: '', pinned: false, ...(ui.nfolder ? { nf: ui.nfolder } : {}), ...(canvas ? { canvas: { v: 1, items: [] } } : {}) } };
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
  let text = it.data.text || '';
  if (it.data.link && it.data.link.title) {
    text = `# ${it.data.link.title}\n\n${text}`;
  }
  const n = await createNote(text);
  setTab('notes');
  openNote(n.id);
  toast('Saved as a note');
}

function openNoteItem() {
  return store.items.get(ui.noteId) || (ui.newNote && ui.newNote.id === ui.noteId ? ui.newNote : null);
}

function closeEditor(fromLayer = false) {
  try { const sel = getSelection(); if (sel && el.editorText.contains(sel.anchorNode)) sel.removeAllRanges(); } catch {}
  if (ui.hideListen) ui.hideListen();
  saveNote.flush();
  const n = openNoteItem();
  if (n && store.items.has(n.id) && !noteText(n).trim() && !/data-file/.test(n.data.html || '') && !(n.data.canvas && n.data.canvas.items.length)) {
    store.remove(n).then(() => sync.schedule()); // leaving an empty note removes it
  }
  const wasOpen = !!ui.noteId;
  const mobileClosing = isMobileLayout() && el.app.classList.contains('editing');
  clearTimeout(ui.sideLeaveT);
  ui.sideLeaveT = 0;
  clearTimeout(ui.editorLeaveT);
  ui.editorLeaveT = 0;
  el.app.classList.remove('show-sidebar', 'sidebar-leaving');
  if (!fromLayer) closeLayer('editor');
  ui.noteId = null;
  ui.newNote = null;
  renderNotesList();
  applyNotesList();
  if (mobileClosing && !reducedMotion()) {
    el.app.classList.remove('editing');
    el.app.classList.add('editor-leaving');
    ui.editorLeaveT = setTimeout(() => {
      ui.editorLeaveT = 0;
      el.app.classList.remove('editor-leaving');
      renderEditor(true);
      requestAnimationFrame(syncThemeColor);
    }, 145);
    return;
  }
  el.app.classList.remove('editing', 'editor-leaving');
  renderEditor(true);
  if (wasOpen && !isMobileLayout()) triggerAnim(el.notesPane, 'pane-in', ['pane-in'], 180);
  requestAnimationFrame(syncThemeColor);
}

function renderEditor(force) {
  let n = openNoteItem();
  if (n && n.data.trashed) {
    if (isMobileLayout() && el.app.classList.contains('editing')) closeEditor();
    ui.noteId = null;
    n = null;
  }
  el.app.classList.toggle('note-open', !!n);
  if (!n) {
    ui.wasEditorId = null;
    ui.wasEditorCanvas = null;
    el.editor.hidden = true;
    el.editorEmpty.hidden = false;
    if (ui.canvas) ui.canvas.layout();
    return;
  }
  const prevId = ui.wasEditorId;
  const prevCanvas = ui.wasEditorCanvas;
  const isCanvas = !!n.data.canvas;
  ui.wasEditorId = n.id;
  ui.wasEditorCanvas = isCanvas;
  el.editor.hidden = false;
  el.editorEmpty.hidden = true;
  const ed = el.editorText;
  el.editor.classList.toggle('is-canvas', isCanvas);
  if (prevId === n.id && prevCanvas != null && prevCanvas !== isCanvas) {
    triggerAnim(el.editor, 'note-swap', ['note-swap'], 160);
  }
  el.editor.dataset.font = n.data.font || '';
  if (n.data.paper && n.data.paper !== 'smooth') el.editor.dataset.paper = n.data.paper;
  else delete el.editor.dataset.paper;
  el.editor.classList.toggle('smooth', n.data.paper === 'smooth');
  el.editor.dataset.color = n.data.color || '';
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
    restoreNotePos(n.id);
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
  // a long note whose pieces haven't all arrived yet is read-only until they have
  const waiting = !isCanvas && !partsReady(n);
  el.editorText.contentEditable = waiting || ui.readMode ? 'false' : 'true';
  el.editor.classList.toggle('reading', !!ui.readMode);
  renderEditToggle();
  el.editor.classList.toggle('parts-waiting', waiting);
  renderRemindButton();
  requestAnimationFrame(syncThemeColor);
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
function ytCardActsHTML() {
  return '<span class="lc-acts"><span class="lc-act" data-yt-dl="mp3" role="button" tabindex="0" title="Download MP3">MP3</span><span class="lc-act" data-yt-dl="m4a" role="button" tabindex="0" title="Download M4A Audio">M4A</span><span class="lc-act" data-yt-dl="mp4" role="button" tabindex="0" title="Download Video (MP4)">Video</span></span>';
}
function hydrateFiles(root) {
  for (const img of $$('img[data-file]', root)) if (!img.getAttribute('src')) img.src = files.src(img.dataset.file);
  for (const a of $$('a[data-file]', root)) { a.setAttribute('contenteditable', 'false'); a.removeAttribute('href'); }
  for (const a of $$('a.link-card', root)) {
    a.setAttribute('contenteditable', 'false');
    if (ytInfo(a.href)) {
      const acts = a.querySelector('.lc-acts');
      if (!acts) a.insertAdjacentHTML('beforeend', ytCardActsHTML());
      else if (!acts.querySelector('[data-yt-dl="m4a"]')) acts.outerHTML = ytCardActsHTML();
    }
  }
}
function updateEmpty() {
  const ed = el.editorText;
  ed.classList.toggle('is-empty', !ed.textContent.trim() && !ed.querySelector('img, li, hr, [data-file]'));
}

function renderFoot() {
  const cn = openNoteItem();
  if (cn && cn.data.parts && !cn.data.canvas) {
    clearTimeout(ui.footT);
    ui.footT = setTimeout(() => { const w = Math.round((el.editorText.textContent || '').length / 6); el.editorFoot.textContent = `≈ ${w.toLocaleString()} words · ≈ ${Math.max(1, Math.round(w / 300))} pages`; }, 900);
    return;
  }
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
  if (n.data.parts && !partsReady(n)) { renderSaveState(); return; } // never save half of a long note
  if (exists && html === (n.data.parts ? ui.loadedHtml : n.data.html)) { renderSaveState(); return; }
  if (!exists && !text && !/data-file/.test(html)) { renderSaveState(); return; }
  ui.loadedHtml = html.length > BIG ? html : sanitizeNote(html);
  await writeNoteContent(n, html, text);
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

/* ───── pinch the notes list or the drops list: the items grow and shrink smoothly under your fingers,
        and when you let go the list settles on the nearest size (the item you were touching stays put) ───── */
function smoothListPinch({ area, content, scroller, modes, getIndex, apply, itemSel }) {
  let g = null;
  let wheelT = 0;
  const STEP = 1.28; // how far to pinch for one size step
  const begin = (x, y) => {
    const el = content();
    if (!el || !el.offsetParent) return null;
    const r = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transformOrigin = `${x - r.left}px ${y - r.top}px`;
    el.style.willChange = 'transform';
    area.classList.add('list-pinching');
    const hit = document.elementsFromPoint(x, y).find((n) => n.matches && n.matches(itemSel));
    return { el, k: 1, idx: getIndex(), x, y, id: hit ? hit.dataset.id : '', top: hit ? hit.getBoundingClientRect().top : 0 };
  };
  const show = (k) => {
    g.k = Math.max(0.4, Math.min(2.6, k));
    const last = modes.length - 1;
    let kk = g.k;
    // at the smallest / biggest size it only gives a little, like a rubber band
    if (g.idx >= last && kk > 1) kk = 1 + Math.min(0.08, (kk - 1) * 0.25);
    if (g.idx <= 0 && kk < 1) kk = 1 - Math.min(0.08, (1 - kk) * 0.25);
    g.el.style.transform = `scale(${kk})`;
  };
  const finish = () => {
    const st = g;
    g = null;
    if (!st) return;
    const d = Math.round(Math.log(st.k) / Math.log(STEP));
    const next = Math.max(0, Math.min(modes.length - 1, st.idx + d));
    const done = (el) => setTimeout(() => { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; el.style.willChange = ''; el.style.transformOrigin = ''; area.classList.remove('list-pinching'); }, 240);
    if (next === st.idx) {
      st.el.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      st.el.style.transform = '';
      done(st.el);
      return;
    }
    st.el.style.transform = ''; // measure the new layout at its real size
    apply(next);
    const el = content();
    // the new size starts close to where the fingers left it and settles in
    el.style.transition = 'none';
    el.style.transformOrigin = st.el.style.transformOrigin;
    el.style.transform = `scale(${next > st.idx ? 0.94 : 1.06})`;
    el.style.opacity = '.55';
    if (st.id) {
      const it = el.querySelector(`[data-id="${CSS.escape(st.id)}"]`);
      const sc = scroller();
      if (it && sc) sc.scrollTop += it.getBoundingClientRect().top - st.top;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease';
      el.style.transform = '';
      el.style.opacity = '';
    }));
    done(el);
    toast(modes[next], { duration: 1100 });
  };
  // fingers (phones / tablets)
  let d0 = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
  area.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    if (g) finish();
    const [a, b] = e.touches;
    g = begin((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    d0 = dist(e.touches);
  }, { passive: true });
  area.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    show(dist(e.touches) / d0);
  }, { passive: false });
  const up = (e) => { if (g && e.touches.length < 2 && !g.wheel) finish(); };
  area.addEventListener('touchend', up, { passive: true });
  area.addEventListener('touchcancel', up, { passive: true });
  // trackpad pinch / Ctrl+wheel (computers): same live preview, settles 180 ms after the fingers stop
  area.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (!g) { g = begin(e.clientX, e.clientY); if (!g) return; g.wheel = true; }
    show(g.k * Math.exp(Math.max(-0.2, Math.min(0.2, -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)))));
    clearTimeout(wheelT);
    wheelT = setTimeout(finish, 180);
  }, { passive: false });
}

function setupNoteListPinch() {
  const L = el.noteList;
  if (!L) return;
  const MODES = [
    { view: 'list', size: 's', label: 'List · Small' },
    { view: 'list', size: 'm', label: 'List · Medium' },
    { view: 'list', size: 'l', label: 'List · Large' },
    { view: 'grid', size: 's', label: 'Grid · Small' },
    { view: 'grid', size: 'm', label: 'Grid · Medium' },
    { view: 'grid', size: 'l', label: 'Grid · Large' }
  ];
  smoothListPinch({
    area: el.notesPane || L.closest('.notes-pane') || L,
    content: () => L,
    scroller: () => L,
    itemSel: '.note-item',
    modes: MODES.map((m) => m.label),
    getIndex: () => {
      const v = lsGet('sp-nview', 'list');
      const z = lsGet('sp-nsize', 'm');
      const i = MODES.findIndex((m) => m.view === v && m.size === z);
      return i >= 0 ? i : (v === 'grid' ? 4 : 1);
    },
    apply: (i) => { lsSet('sp-nview', MODES[i].view); lsSet('sp-nsize', MODES[i].size); renderNotesList(); }
  });
}

function setupDropsPinch() {
  const MODES = [
    { layout: 'list', size: 'm', label: 'List' },
    { layout: 'grid', size: 's', label: 'Grid · Small' },
    { layout: 'grid', size: 'm', label: 'Grid · Medium' },
    { layout: 'grid', size: 'l', label: 'Grid · Large' }
  ];
  const feed = $('#feed');
  if (!feed) return;
  smoothListPinch({
    area: feed,
    content: () => el.feedInner || $('#feed-inner'),
    scroller: () => feed,
    itemSel: 'article[data-id]',
    modes: MODES.map((m) => m.label),
    getIndex: () => {
      if (ui.layout !== 'grid') return 0;
      const z = lsGet('sp-dsize', 'm');
      return z === 's' ? 1 : z === 'l' ? 3 : 2;
    },
    apply: (i) => { lsSet('sp-dsize', MODES[i].size); applyDropSize(); if (ui.layout !== MODES[i].layout) setLayout(MODES[i].layout); else renderDrops(); }
  });
}
function applyDropSize() {
  const feed = $('#feed');
  if (feed) feed.dataset.dsize = lsGet('sp-dsize', 'm');
}

/* ───── privacy: hide the notes list, present one note full screen ───── */
function applyNotesList() {
  const show = el.app.classList.contains('show-sidebar');
  el.btnToggleList.setAttribute('aria-pressed', String(show));
  el.btnToggleList.title = show ? 'Hide the notes list (Ctrl+\\)' : 'Show the notes list (Ctrl+\\)';
  el.btnToggleList.setAttribute('aria-label', show ? 'Hide the notes list' : 'Show the notes list');
  if (ui.canvas) ui.canvas.layout();
}
function toggleNotesList(show) {
  const now = el.app.classList.contains('show-sidebar');
  const next = show == null ? !now : show;
  clearTimeout(ui.sideLeaveT);
  ui.sideLeaveT = 0;
  if (next) {
    el.app.classList.remove('sidebar-leaving');
    el.app.classList.add('show-sidebar');
    applyNotesList();
    return;
  }
  el.app.classList.remove('show-sidebar');
  applyNotesList();
  if (now && el.app.classList.contains('note-open') && !isMobileLayout() && !reducedMotion()) {
    el.app.classList.add('sidebar-leaving');
    ui.sideLeaveT = setTimeout(() => {
      ui.sideLeaveT = 0;
      el.app.classList.remove('sidebar-leaving');
      if (ui.canvas) ui.canvas.layout();
    }, 130);
  }
}
function startPresent() {
  const n = openNoteItem();
  if (!n || ui.presenting) return;
  closeMenu();
  saveNote.flush();
  clearTimeout(ui.presentLeaveT);
  ui.presentLeaveT = 0;
  el.app.classList.remove('present-leaving');
  ui.presenting = true;
  if (ui.imgTools) ui.imgTools.select(null);
  for (const t of $$('.toast', el.toasts)) t.remove();
  el.app.classList.add('presenting');
  requestAnimationFrame(syncThemeColor);
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
  clearTimeout(ui.presentLeaveT);
  el.app.classList.remove('presenting', 'idle');
  if (!reducedMotion()) {
    el.app.classList.add('present-leaving');
    ui.presentLeaveT = setTimeout(() => {
      ui.presentLeaveT = 0;
      el.app.classList.remove('present-leaving');
      if (ui.canvas) requestAnimationFrame(() => ui.canvas.layout());
    }, 135);
  }
  requestAnimationFrame(syncThemeColor);
  const bar = $('.present-bar');
  if (bar) { bar.classList.remove('show'); bar.hidden = true; }
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
      return Promise.all(items.map(async (it) => (fileKind(it.data.type, it.data.name) === 'image'
        ? { id: it.id, image: true, ...(await imageSize(it.id)) }
        : { id: it.id, name: it.data.name })));
    },
    onOpen: (id) => { const it = store.items.get(id); if (it) openFile(it); else toast('This file is still on its way'); },
    onExport: () => exportCanvas(),
    onMarkup: (id) => markupFile(id),
    toast: (m) => toast(m, { duration: 1500 }),
    onChange: () => { ui.dirty = true; renderSaveState(); saveNote(); syncNoteUndoRedo(); }
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
  const html = sanitizeNote(el.editorText.innerHTML);
  const fresh = await canvasFromHtml(html, { imageSize });
  const prev = n.data.lastCanvas;
  let canvas = fresh;
  let restack = true;
  if (prev && prev.items && prev.items.length) {
    // bring back the layout made earlier; text edited meanwhile keeps the old boxes' places and styles
    if (sanitizeNote(canvasFallback(prev, sanitizeNote).html).replace(/\s+/g, '') === html.replace(/\s+/g, '')) { canvas = prev; restack = false; }
    else {
      const used = new Set([...html.matchAll(/data-file="([^"]+)"/g)].map((m) => m[1]));
      const keep = prev.items.filter((o) => o.t !== 'text' && (!o.file || used.has(o.file)));
      const had = new Set(keep.filter((o) => o.file).map((o) => o.file));
      const oldText = prev.items.filter((o) => o.t === 'text');
      const texts = fresh.items.filter((o) => o.t === 'text').map((o, i) => {
        const p = oldText[i];
        return p ? { ...o, x: p.x, y: p.y, w: p.w, r: p.r, fs: p.fs, color: p.color, align: p.align, bold: p.bold, italic: p.italic, bg: p.bg, placed: true } : o;
      });
      const extra = fresh.items.filter((o) => o.t !== 'text' && !had.has(o.file));
      canvas = { v: 1, items: [...keep, ...texts, ...extra] };
    }
  }
  const cv = getCanvas();
  const { lastCanvas, ...restData } = n.data;
  n.data = { ...restData, canvas };
  renderEditor(true);
  if (restack) {
    // place new blocks from top to bottom (below what is already placed) now that their heights are known
    const placed = cv.items.filter((o) => o.placed || (prev && prev.items.some((q) => q.id === o.id)));
    let y = 70;
    for (const o of placed) { const b = o.t === 'line' ? { y: Math.max(o.y1, o.y2), h: 0 } : o; y = Math.max(y, b.y + (b.h || 40) + 24); }
    for (const o of cv.items) { if (placed.includes(o)) { delete o.placed; continue; } o.y = y; y += (o.h || 40) + 24; }
    cv.renderAll();
  }
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
function exportCanvas() {
  const n = openNoteItem();
  if (!n || !n.data.canvas || !ui.canvas) return;
  saveNote.flush();
  openExport({
    data: ui.canvas.data(),
    title: noteTitle(n.data.text || '') || 'Canvas',
    paper: n.data.paper || '',
    font: n.data.font || '',
    sanitize: sanitizeNote,
    loadImage: async (id) => {
      const it = store.items.get(id);
      const b = it ? await files.blobOf(it).catch(() => null) : null;
      return b ? createImageBitmap(b).catch(() => null) : null;
    },
    save: async (blob, name, drops) => {
      downloadText(blob, name, blob.type);
      if (drops) await sendFiles([new File([blob], name, { type: blob.type })]);
      toast(drops ? `Saved ${name} and added it to Drops` : `Saved ${name}`);
    }
  });
}
async function turnIntoPage() {
  const n = openNoteItem();
  if (!n || !n.data.canvas) return;
  const lose = n.data.canvas.items.some((o) => o.t === 'shape' || o.t === 'line' || o.t === 'pen');
  if (lose && !(await confirmDialog('Turn into a normal note?', 'Text, pictures and emojis are kept in order from top to bottom. Shapes, arrows and drawings are removed (Version history keeps this canvas).', 'Turn into note'))) return;
  saveNote.flush();
  const { html, text } = canvasFallback(n.data.canvas, sanitizeNote);
  const { canvas, ...rest } = n.data;
  n.data = { ...rest, html, text, lastCanvas: canvas };
  await store.save(n, { snap: true });
  sync.schedule();
  renderEditor(true);
  renderNotesList();
}

function onEditorInput(markEdit = true) {
  if (markEdit) ui.noteEdits = (ui.noteEdits || 0) + 1;
  normalizeEditor();
  updateEmpty();
  ui.dirty = true;
  renderSaveState();
  saveNote();
  renderFoot();
  syncNoteUndoRedo();
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
    { icon: 'download', label: 'Save as PDF (keeps the layout)', run: () => saveNotesPdf([n]) },
    { icon: 'bell', label: n.data.remind ? `Reminder: ${remindLabel(n)}…` : 'Remind me…', run: () => remindMenu(anchor, [n]) },
    { icon: 'copy', label: 'Copy text', run: async () => { await copyText(text()); toast('Copied'); } },
    { icon: 'drops', label: 'Send as a drop', run: () => { sendClip(text()); toast('Sent to Drops'); } },
    { icon: 'present', label: 'Present (full screen)', run: startPresent },
    { icon: 'folder', label: 'Move to folder…', run: () => folderPick(n, anchor) },
    ...(store.items.has(n.id) ? [{ icon: 'archive', label: n.data.archived ? 'Unarchive' : 'Archive', run: () => archiveNote(n, !n.data.archived) }] : []),
    { icon: 'marker', label: 'Colour…', run: () => colorPick(n, anchor) },
    { icon: 'text', label: 'Font…', run: () => fontPick(n, anchor) },
    { icon: 'file', label: 'Paper…', run: () => paperPick(n, anchor) },
    ...(n.data.canvas ? [{ icon: 'download', label: 'Save as PNG or PDF…', run: exportCanvas }] : []),
    { icon: 'pen', label: 'New note', run: () => newNote() },
    n.data.canvas
      ? { icon: 'note', label: 'Turn into normal note', run: turnIntoPage }
      : { icon: 'canvas', label: 'Turn into canvas', run: turnIntoCanvas },
    ...(n.data.canvas ? [] : [{ icon: 'sparkle', label: 'De-clutter text', run: declutterNote }]),
    ...(!n.data.canvas && Math.abs((currentZoom || 1) - 1) > 0.01 ? [{ icon: 'fit', label: `Reset zoom to 100% (now ${Math.round(currentZoom * 100)}%)`, run: () => el.btnZoomReset.click() }] : []),
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

function syncNoteUndoRedo() {
  const isCv = canvasOpen();
  let canUndo = false;
  let canRedo = false;
  if (isCv && ui.canvas) {
    canUndo = ui.canvas.undoStack.length > 0 || !!ui.canvas.editing;
    canRedo = ui.canvas.redoStack.length > 0;
  } else {
    try {
      canUndo = document.queryCommandEnabled('undo');
      canRedo = document.queryCommandEnabled('redo');
    } catch {}
    if (!canUndo && (ui.noteEdits || 0) > 0) canUndo = true;
    if (!canRedo && (ui.noteRedos || 0) > 0) canRedo = true;
  }
  if (el.btnNoteUndo) el.btnNoteUndo.disabled = !canUndo;
  if (el.btnNoteRedo) el.btnNoteRedo.disabled = !canRedo;
  const u = el.fmtBar && el.fmtBar.querySelector('[data-fmt="undo"]');
  const r = el.fmtBar && el.fmtBar.querySelector('[data-fmt="redo"]');
  if (u) u.disabled = !canUndo;
  if (r) r.disabled = !canRedo;
}

function doNoteUndo() {
  if (canvasOpen() && ui.canvas) {
    ui.canvas.undo();
  } else {
    el.editorText.focus();
    restoreSel();
    try { document.execCommand('undo'); } catch {}
    if ((ui.noteEdits || 0) > 0) { ui.noteEdits--; ui.noteRedos = (ui.noteRedos || 0) + 1; }
    saveSel();
    onEditorInput(false);
  }
  syncNoteUndoRedo();
}

function doNoteRedo() {
  if (canvasOpen() && ui.canvas) {
    ui.canvas.redo();
  } else {
    el.editorText.focus();
    restoreSel();
    try { document.execCommand('redo'); } catch {}
    if ((ui.noteRedos || 0) > 0) { ui.noteRedos--; ui.noteEdits = (ui.noteEdits || 0) + 1; }
    saveSel();
    onEditorInput(false);
  }
  syncNoteUndoRedo();
}

function updateToolbar() {
  if (el.editor.hidden) return;
  syncNoteUndoRedo();
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
  if (kind === 'undo') return doNoteUndo();
  if (kind === 'redo') return doNoteRedo();
  if (kind === 'size') return sizeMenu(btn);
  if (kind === 'color') return colorMenu(btn);
  if (kind === 'insertUnorderedList') return bulletList();
  if (kind === 'checklist') return makeChecklist();
  if (kind === 'heading') return toggleHeading();
  if (kind === 'link') return addLink();
  if (kind === 'attach') { saveSel(); return el.noteFileInput.click(); }
  if (kind === 'case') {
    el.editorText.focus();
    const mode = cycleCase(el.editorText);
    if (mode) { onEditorInput(); toast(CASE_LABEL[mode], { duration: 1500 }); }
    return;
  }
  if (kind === 'clear') return clearFormat();
  exec(kind);
}

function onEditorKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNote.flush(); return; }
  const isMac = /Macintosh|Mac OS X/i.test(navigator.userAgent);
  if ((e.altKey && (e.key === 'ArrowLeft' || e.key === 'Left') && !isMac) || (isMac && e.metaKey && e.key === '[')) {
    e.preventDefault();
    closeEditor();
    return;
  }
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

/** done items sink to the bottom of their checklist (undone ones rise back), with a short slide */
function sortChecklist(ul) {
  if (!ul || !ul.isConnected || !ul.matches('ul[data-checklist]')) return;
  const items = [...ul.children].filter((c) => c.tagName === 'LI');
  const sorted = [...items.filter((li) => li.getAttribute('data-checked') !== 'true'), ...items.filter((li) => li.getAttribute('data-checked') === 'true')];
  if (sorted.every((li, i) => li === items[i])) return;
  const before = new Map(items.map((li) => [li, li.getBoundingClientRect().top]));
  for (const li of sorted) ul.append(li);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const li of sorted) {
      const dy = before.get(li) - li.getBoundingClientRect().top;
      if (!dy) continue;
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  onEditorInput();
}

function onEditorClick(e) {
  const li = e.target.closest('ul[data-checklist] > li');
  if (li && e.target === li && e.clientX - li.getBoundingClientRect().left < 30 * getZoom()) {
    e.preventDefault();
    li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
    onEditorInput();
    clearTimeout(ui.sortTaskT);
    ui.sortTaskT = setTimeout(() => sortChecklist(li.parentElement), 380);
    return;
  }
  const f = e.target.closest('[data-file]');
  if (f && f.tagName !== 'IMG') {
    const it = store.items.get(f.dataset.file);
    if (it) { e.preventDefault(); openFile(it); }
    return;
  }
  const a = e.target.closest('a[href]');
  if (a) {
    e.preventDefault();
    openUrl(a.href);
    return;
  }
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
  if (e._spHandled) return;
  e._spHandled = true;
  const cd = e.clipboardData;
  if (!cd) return;
  const html = cd.getData('text/html');
  const text = cd.getData('text/plain');
  e.preventDefault();

  const trimmed = (text || '').trim();
  const isUrl = /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : (/^www\.[a-z0-9\-]+(\.[a-z0-9\-]+)+[^\s]*$/i.test(trimmed) ? 'https://' + trimmed : null);
  if (isUrl) {
    const linkHtml = `<a href="${esc(isUrl)}" target="_blank" rel="noopener noreferrer">${esc(trimmed)}</a>&nbsp;`;
    let ok = false;
    try {
      ok = document.execCommand('insertHTML', false, linkHtml);
    } catch {}
    if (!ok) {
      const sel = getSelection();
      if (sel && sel.rangeCount && el.editorText.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const a = document.createElement('a');
        a.href = isUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = trimmed;
        r.insertNode(a);
        const sp = document.createTextNode('\u00A0');
        a.after(sp);
        r.setStartAfter(sp);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        const p = document.createElement('p');
        const a = document.createElement('a');
        a.href = isUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = trimmed;
        p.appendChild(a);
        p.appendChild(document.createTextNode('\u00A0'));
        el.editorText.appendChild(p);
      }
    }
    onEditorInput();
    const links = [...el.editorText.querySelectorAll(`a[href="${CSS.escape ? CSS.escape(isUrl) : isUrl}"]`)].filter((x) => !x.classList.contains('link-card'));
    const newlyAdded = links[links.length - 1];
    if (newlyAdded) addLinkCard(newlyAdded);
    return;
  }
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
  linkifyAfterPaste();
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
  const hasRichEmbeds = !!el.editorText.querySelector('[data-file], img, table, pre');
  const md = De.looksMarkdown(text) && !hasRichEmbeds;
  // 1. clean AI-chat leftovers & convert any markdown  2. make long, flat text easy to read (key points, headings, short paragraphs, lists)
  const cleaned = md ? markdownToHtml(De.markdown(text, o)) : De.tidyHtml(before, o);
  const out = sanitizeNote(De.readable(sanitizeNote(cleaned)));
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

/* swipe (or arrows / ← →) between the photos of the same folder or note */
function photoSiblings(it) {
  const isImg = (f) => f.kind === 'file' && !f.data.trashed && !f.data.fx && fileKind(f.data.type, f.data.name) === 'image';
  if (it.data.parent) return store.list('file').filter((f) => isImg(f) && f.data.parent === it.data.parent).sort((a, b) => a.created - b.created);
  return dropItems().filter((f) => isImg(f) && (f.data.folder || '') === (it.data.folder || ''));
}
function stepPhoto(dir) {
  const it = ui.viewing;
  if (!it || !el.dlgViewer.open) return false;
  const list = photoSiblings(it);
  const i = list.findIndex((f) => f.id === it.id);
  const next = list[i + dir];
  if (i < 0 || !next) return false;
  openFile(next);
  return true;
}
function setupPhotoSwipe(it) {
  const list = photoSiblings(it);
  const i = list.findIndex((f) => f.id === it.id);
  if (list.length < 2 || i < 0) return;
  const nav = document.createElement('div');
  nav.className = 'photo-nav';
  nav.innerHTML = `<button class="pn-prev" aria-label="Previous photo" ${i ? '' : 'disabled'}>‹</button><span class="pn-count">${i + 1} / ${list.length}</span><button class="pn-next" aria-label="Next photo" ${i < list.length - 1 ? '' : 'disabled'}>›</button>`;
  el.viewerBody.append(nav);
  nav.querySelector('.pn-prev').onclick = () => stepPhoto(-1);
  nav.querySelector('.pn-next').onclick = () => stepPhoto(1);
  const stage = el.viewerBody.querySelector('.zoom-stage');
  let sx = 0, sy = 0, st = 0, n = 0;
  stage.addEventListener('touchstart', (e) => { n = e.touches.length; if (n === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); } }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (n !== 1 || e.touches.length || !ui.zoom || !ui.zoom.atFit()) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - st < 700) stepPhoto(dx < 0 ? 1 : -1);
  }, { passive: true });
}
addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && el.dlgViewer && el.dlgViewer.open && !e.target.closest('input, textarea, [contenteditable="true"]')) {
    if (stepPhoto(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
  }
});

async function openFile(it) {
  const d = it.data;
  const kind = fileKind(d.type, d.name);
  const src = files.src(it.id);
  const textual = (kind === 'doc' || kind === 'code') && d.size <= 1024 * 1024 &&
    (/^text\/|json|xml|javascript/.test(d.type || '') || /^(txt|md|csv|tsv|json|js|mjs|ts|css|html?|py|xml|ya?ml|sh|log|ini|sql|dart|kt|java|c|cpp|h|go|rs|php|rb)$/.test(extOf(d.name)));
  if (extOf(d.name) === 'epub' || /epub/.test(d.type || '')) { openEpubViewer(it); return; }
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
  if (!el.dlgViewer.open) openDialog(el.dlgViewer);
  if (kind === 'image') {
    const pct = el.viewerBody.querySelector('.zoom-pct');
    ui.zoom = new ZoomView(el.viewerBody.querySelector('.zoom-stage'), el.viewerBody.querySelector('img'), (label) => { pct.textContent = label; });
    setupPhotoSwipe(it);
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
  ui.pinRefresh && ui.pinRefresh();
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
  renderWallSeg();
  renderBgGrid();
  const st = store.items.get('settings');
  el.setAutodel.value = String((st && st.data.autodel) || 0);
  el.setDeclutter.value = (st && st.data.declutter) || 'on';
  el.setSendAs.value = sendAs();
  el.installField.hidden = !ui.installPrompt || isStandalone();
  renderOpenWith();
  el.versionText.textContent = `SyncPad ${VERSION} · ${store.get('deviceName')}`;
  renderPinSettings();
  renderBackup();
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
  devices.sort((a, b) => (b.id === mine) - (a.id === mine) || (b.main ? 1 : 0) - (a.main ? 1 : 0) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.seen - a.seen);
  const anyMain = devices.some((d) => d.main);
  const meMain = !!(devices.find((d) => d.id === mine) || {}).main;
  const canManage = !anyMain || meMain;
  el.devCount.textContent = devices.length > 1 ? String(devices.length) : '';
  const others = devices.filter((d) => d.id !== mine && !d.main);
  const head = anyMain
    ? (meMain
      ? '<div class="dev-note">This is a <b>main device</b>: only main devices can remove devices or change the number password.</div>'
      : '<div class="dev-note">Only your <b>main devices</b> can remove devices or change the number password.</div>')
    : '<div class="dev-note">Tip: make your phone and laptop <b>main devices</b>, so a computer you forget to sign out of (like at an internet café) can never remove them, and you can remove it from your phone.</div>';
  el.settingsDevices.innerHTML = head + devices
    .map((d) => {
      const isMe = d.id === mine;
      const on = d.online || (isMe && sync.wsOpen);
      const name = (isMe ? store.get('deviceName') : d.name) || 'Device';
      const tags = (isMe ? '<span class="me">This device</span>' : '') + (d.main ? '<span class="me main">Main</span>' : '');
      const act = isMe
        ? (d.main ? '<button class="dev-remove soft" data-unmain="1">Not main</button>' : '<button class="dev-remove soft" data-mkmain="1">Make main</button>')
        : (canManage ? `<button class="dev-remove" data-remove="${esc(d.id)}" data-name="${esc(name)}">Remove</button>` : '');
      return `<div class="dev-row${on ? ' on' : ''}">
        <span class="dev-ic"><svg class="ic"><use href="#i-${devIcon(name)}"/></svg><span class="dot"></span></span>
        <div class="dev-main"><div class="dev-name">${esc(name)}${tags}</div>
        <div class="dev-when">${on ? 'Online now' : `Last seen ${esc(ago(d.seen))}`}</div></div>
        ${act}
      </div>`;
    })
    .join('') +
    (canManage && others.length > 1 ? `<button class="btn btn-soft btn-sm dev-all danger-text" data-remove-all="1">Remove all ${anyMain ? 'devices except main ones' : 'other devices'} (${others.length})</button>` : '') +
    (devices.length <= 1 ? '<div class="dev-empty">No other devices yet. Tap “Add a device” to connect your phone or computer.</div>' : '');
}
async function makeMain() {
  const pin = await promptDialog('Make this a main device', 'Type your number password', '', { secret: true });
  if (!pin) return;
  if (!navigator.onLine) { toast('Go online first.'); return; }
  const r = await fetch(`/api/s/${store.get('space')}/main`, { method: 'POST', headers: sync.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ pin: pin.replace(/\s/g, '') }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (r && r.status === 429) { toast(`Too many wrong tries. Wait ${Math.max(1, Math.ceil((j.retry || 900000) / 60000))} minutes.`); return; }
  if (!r || !r.ok) { toast(r && r.status === 401 ? 'That password is not right. (Set one first under Add a device.)' : 'Could not do that. Try again.'); return; }
  toast('This is now a main device.');
  loadDevices();
}
async function unMain() {
  const ok = await confirmDialog('Stop being a main device?', 'If no main devices are left, any signed-in device can remove the others again.', 'Stop');
  if (!ok) return;
  await fetch(`/api/s/${store.get('space')}/main`, { method: 'DELETE', headers: sync.headers() }).catch(() => null);
  loadDevices();
}
function renderWallSeg() {
  const w = lsGet('sp-wall', 'aurora');
  for (const b of $$('[data-wall-opt]', el.setWall)) b.setAttribute('aria-checked', String(b.dataset.wallOpt === w));
}
function setWall(w) {
  try { localStorage.setItem('sp-wall', w); } catch {}
  if (w === 'none') delete document.documentElement.dataset.wall; else document.documentElement.dataset.wall = w;
  renderWallSeg();
}
function renderThemeSeg() {
  let t = 'system';
  try { t = localStorage.getItem('sp-theme') || 'system'; } catch {}
  for (const b of $$('[data-theme-opt]', el.setTheme)) b.setAttribute('aria-pressed', String(b.dataset.themeOpt === t));
}
function renderBgGrid() {
  let bg = 'none';
  try { bg = localStorage.getItem('sp-bg') || 'none'; } catch {}
  if (!el.setBgGrid) return;
  for (const card of $$('[data-bg]', el.setBgGrid)) {
    const active = card.dataset.bg === bg;
    card.setAttribute('aria-checked', String(active));
    card.classList.toggle('active', active);
  }
}
function applyTheme() {
  let t = 'system';
  let bg = '';
  try {
    t = localStorage.getItem('sp-theme') || 'system';
    localStorage.removeItem('sp-bg'); // paper textures are gone: the app background is always plain
  } catch {}
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  if (bg && bg !== 'none') document.documentElement.dataset.bg = bg;
  else delete document.documentElement.dataset.bg;
  const bgColors = {
    light: { classic: '#f2e8d0', smooth: '#f7f4f0', cotton: '#f3efe6', recycled: '#e6dfd0', lined: '#f6f7f9', linen: '#ece6da', washi: '#f5f1e8', vintage: '#e5d7b8', none: '#ffffff' },
    dark: { classic: '#262119', smooth: '#181b22', cotton: '#1e2028', recycled: '#2a261f', lined: '#181b22', linen: '#21252d', washi: '#1c2028', vintage: '#2a2015', none: '#16181e' }
  };
  const scheme = dark ? 'dark' : 'light';
  const col = (bg && bgColors[scheme][bg]) || bgColors[scheme].none;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    m.removeAttribute('media');
    m.content = col;
  }
  const csMeta = document.querySelector('meta[name="color-scheme"]');
  if (csMeta) csMeta.content = scheme;
  const sbMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (sbMeta) sbMeta.content = dark ? 'black-translucent' : 'default';
  if (window.SyncPadAndroid?.setTheme) {
    window.SyncPadAndroid.setTheme(dark, col, dark ? '#0e1014' : '#fcfcfd');
  }
  updateManifest();
  requestAnimationFrame(syncThemeColor);
}
/* ---------- read aloud: selected text (or the whole note) ---------- */
function setupListen() {
  const pill = document.createElement('button');
  pill.className = 'listen-pill';
  pill.hidden = true;
  pill.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg><span>Listen</span>';
  document.body.append(pill);
  let selText = '';
  const place = () => {
    const sel = getSelection();
    const t = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    const node = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    const ok = t.length > 1 && host && !host.closest('input, textarea, .tts-bar, .listen-pill, dialog:not(.dv)');
    const r = ok ? sel.getRangeAt(0).getBoundingClientRect() : null;
    // hide if the selected text is no longer on screen (note closed, list changed, scrolled away)
    if (!ok || !host.isConnected || !host.getClientRects().length || !r || (!r.width && !r.height) || r.bottom < 0 || r.top > innerHeight) { pill.hidden = true; return; }
    selText = t;
    const touch = matchMedia('(pointer: coarse)').matches;
    let top = touch ? r.bottom + 14 : r.top - 46;
    if (top < 8) top = r.bottom + 14;
    if (top > innerHeight - 60) top = Math.max(8, r.top - 50);
    pill.style.top = `${Math.round(top)}px`;
    pill.style.left = `${Math.round(Math.min(innerWidth - 120, Math.max(8, r.left + r.width / 2 - 52)))}px`;
    if (pill.hidden) { pill.hidden = false; warmVoice(); }
  };
  let raf = 0;
  document.addEventListener('selectionchange', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); });
  addEventListener('scroll', () => { if (!pill.hidden) place(); }, true);
  pill.addEventListener('pointerdown', (e) => e.preventDefault());
  // tapping anywhere else, or leaving the note, drops the button
  document.addEventListener('pointerdown', (e) => { if (!pill.hidden && !pill.contains(e.target)) setTimeout(place, 60); }, true);
  ui.hideListen = () => { pill.hidden = true; };
  pill.addEventListener('click', () => { if (selText) speak(selText); pill.hidden = true; });
  const tb = document.querySelector('[data-clip="paste"]');
  if (tb) {
    const b = document.createElement('button');
    b.className = 'clip-btn';
    b.title = 'Listen: reads the selected text aloud, or the whole note';
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg><span>Listen</span>';
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const sel = getSelection();
      const t = sel && !sel.isCollapsed && el.editorText.contains(sel.anchorNode) ? sel.toString() : el.editorText.innerText;
      if (!speak(t)) toast('Nothing to read here yet.');
    });
    tb.after(b);
  }
}

/* ---------- backup: download everything as one .zip ---------- */
const BACKUP_KEY = 'sp-backup-at';
const BACKUP_EVERY = 30 * 864e5;
function lastBackup() { return Number(lsGet(BACKUP_KEY, 0)) || 0; }
function renderBackup() {
  const t = lastBackup();
  el.backupText.textContent = t ? `Last backup on this device: ${new Date(t).toLocaleDateString()} (${ago(t)}).` : 'No backup made on this device yet.';
  el.backupText.classList.toggle('warn', !t || Date.now() - t > BACKUP_EVERY);
}
function plainNote(n) {
  if (n.data.text != null) return String(n.data.text);
  const d = document.createElement('div');
  d.innerHTML = noteHtml(n);
  d.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  d.querySelectorAll('p,div,li,h1,h2,h3,h4,blockquote,pre,tr').forEach((b) => b.append('\n'));
  return d.textContent.replace(/\n{3,}/g, '\n\n').trim();
}
async function makeBackup() {
  if (ui.backingUp) return;
  if (!navigator.onLine) { toast('Go online first, so every file can be included.'); return; }
  ui.backingUp = true;
  const btn = el.btnBackup, label = btn.querySelector('span');
  const say = (t) => { label.textContent = t; };
  btn.disabled = true;
  try {
    const zip = new ZipWriter(), nm = namer(), missing = [];
    const live = (i) => i && !i.data.trashed;
    const notes = store.list('note').filter(live).sort((a, b) => b.updated - a.updated || b.created - a.created);
    const attach = store.list('file').filter((f) => live(f) && f.data.parent && !f.data.fx);
    const drops = store.list().filter((i) => isDrop(i) && live(i) && !i.data.fx).sort((a, b) => a.created - b.created);
    const total = notes.length + attach.length + drops.filter((d) => d.kind === 'file').length;
    let done = 0;
    const tick = () => say(`Preparing… ${Math.min(total, ++done)} of ${total}`);
    const stamp = (ts) => new Date(ts).toLocaleString();
    const fileInto = async (dir, f) => {
      let blob = null;
      try { blob = await files.blobOf(f); } catch {}
      const name = String(f.data.name || 'file');
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      if (!blob) { missing.push(dir + name); return; }
      await zip.add(nm(dir, base, ext, 'file'), blob, f.created);
    };
    // notes
    for (const n of notes) {
      const body = plainNote(n);
      const title = noteTitle(noteText(n)) || 'Untitled note';
      const dir = n.data.archived ? 'Notes/Archive/' : 'Notes/';
      const path = nm(dir, title, '.txt', 'Untitled note');
      await zip.add(path, `${body}\n\n---\nCreated: ${stamp(n.created)}\nLast changed: ${stamp(n.updated || n.created)}\n`, n.updated || n.created);
      for (const f of attach.filter((a) => a.data.parent === n.id)) { await fileInto(path.replace(/\.txt$/, '') + ' - files/', f); tick(); }
      tick();
    }
    // drops, grouped by folder
    const byDir = new Map();
    for (const d of drops) {
      const f = folderOf(d);
      const dir = f ? `Drops/${nm('', f.data.name || 'Folder', '', 'Folder').replace(/ \(\d+\)$/, '')}/` : 'Drops/';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(d);
    }
    for (const [dir, list] of byDir) {
      const texts = list.filter((d) => d.kind === 'clip').map((d) => `${stamp(d.created)}\n${d.data.text || ''}`);
      if (texts.length) await zip.add(nm(dir, 'Texts and links', '.txt'), texts.join('\n\n----------\n\n') + '\n', Date.now());
      for (const f of list.filter((d) => d.kind === 'file')) { await fileInto(dir, f); tick(); }
    }
    if (missing.length) await zip.add('NOT INCLUDED.txt', `These could not be downloaded right now (try the backup again later):\n\n${missing.join('\n')}\n`);
    await zip.add('README.txt', `SyncPad backup — ${stamp(Date.now())}\n\nNotes/  every note as a text file (archived notes in Notes/Archive)\nDrops/  your drops; files sit in their folders, texts and links are in "Texts and links.txt"\n\nKeep this file somewhere safe, like Google Drive or a USB stick.\n`);
    const blob = zip.finish();
    const d = new Date();
    const fname = `SyncPad backup ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    try { localStorage.setItem(BACKUP_KEY, String(Date.now())); } catch {}
    toast(missing.length ? `Backup saved, but ${missing.length} file${missing.length > 1 ? 's' : ''} could not be added (see “NOT INCLUDED.txt”).` : `Backup saved: ${fname}. Put it in Google Drive or on a USB stick.`, { duration: 7000 });
  } catch (e) {
    toast('Could not make the backup. Try again.');
  } finally {
    ui.backingUp = false; btn.disabled = false; say('Download everything');
    if (el.dlgSettings.open) renderBackup();
  }
}
function backupReminder() {
  const hasStuff = store.list('note').some((n) => !n.data.trashed) || store.list().some((i) => isDrop(i) && !i.data.trashed);
  if (!hasStuff) return;
  let first = Number(lsGet('sp-backup-first', 0));
  if (!first) { try { localStorage.setItem('sp-backup-first', String(Date.now())); } catch {} return; }
  const since = Math.max(lastBackup(), first);
  if (Date.now() - since < BACKUP_EVERY) return;
  if (Date.now() - Number(lsGet('sp-backup-nag', 0)) < 3 * 864e5) return;
  try { localStorage.setItem('sp-backup-nag', String(Date.now())); } catch {}
  const t = lastBackup();
  toast(t ? `Last backup was ${Math.floor((Date.now() - t) / 864e5)} days ago. Save a fresh copy?` : 'You have no backup yet. Save a copy of everything?', { action: 'Back up', onAction: makeBackup, duration: 12000 });
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
let currentZoom = null;
let zoomRaf = 0;
let zoomSaveTimer = null;

/* each note remembers its own zoom (the last 300 notes you zoomed); other notes use your usual zoom */
function noteZooms() { try { return JSON.parse(localStorage.getItem('sp-zoom-notes') || '{}') || {}; } catch { return {}; } }
function saveZoomPref(z) {
  const v = Math.round(z * 100) / 100;
  try {
    if (ui.noteId && !canvasOpen()) {
      const m = noteZooms();
      delete m[ui.noteId];
      m[ui.noteId] = v;
      const ks = Object.keys(m);
      if (ks.length > 300) for (const k of ks.slice(0, ks.length - 300)) delete m[k];
      localStorage.setItem('sp-zoom-notes', JSON.stringify(m));
    } else localStorage.setItem('sp-zoom', String(v)); // no note open: your usual zoom
  } catch {}
}
function zoomForNote(id) {
  const z = noteZooms()[id];
  if (z) return z;
  try { return Number(localStorage.getItem('sp-zoom')) || 1; } catch { return 1; }
}

function getZoom() {
  if (currentZoom != null) return currentZoom;
  let z = 1;
  try { z = Number(localStorage.getItem('sp-zoom')) || 1; } catch {}
  currentZoom = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
  return currentZoom;
}

function applyZoomStyles() {
  const z = currentZoom || getZoom();
  document.documentElement.style.setProperty('--note-zoom', String(z));
  if (canvasOpen()) return;
  const label = Math.round(z * 100) + '%';
  if (el.btnZoomReset) {
    if (el.btnZoomReset.textContent !== label) el.btnZoomReset.textContent = label;
    // not at 100%: the label shows a small reset mark, one tap brings it back
    const off = Math.abs(z - 1) > 0.01;
    el.btnZoomReset.classList.toggle('zoomed', off);
    el.btnZoomReset.title = off ? 'Reset to 100%' : 'Zoom';
    el.btnZoomReset.setAttribute('aria-label', off ? `Zoom ${label} — tap to reset to 100%` : 'Zoom 100%');
  }
  if (ui.presenting) {
    const pz = document.querySelector('.present-bar .zv');
    if (pz && pz.textContent !== label) pz.textContent = label;
  }
  if (el.btnZoomOut) el.btnZoomOut.disabled = z <= ZOOMS[0] + 0.01;
  if (el.btnZoomIn) el.btnZoomIn.disabled = z >= ZOOMS[ZOOMS.length - 1] - 0.01;
}

function setContinuousZoom(z, persist = true) {
  const clamped = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], z));
  currentZoom = clamped;

  if (persist) {
    clearTimeout(zoomSaveTimer);
    saveZoomPref(clamped);
  } else {
    clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(() => {
      saveZoomPref(currentZoom);
    }, 180);
  }

  // Batch DOM/CSS update via requestAnimationFrame for silky-smooth 60/120fps
  if (!zoomRaf) {
    zoomRaf = requestAnimationFrame(() => {
      zoomRaf = 0;
      applyZoomStyles();
    });
  }
}

function applyZoom() {
  if (canvasOpen()) {
    const cz = ui.canvas.zoom;
    el.btnZoomReset.textContent = Math.round(cz * 100) + '%';
    el.btnZoomOut.disabled = cz <= 0.5;
    el.btnZoomIn.disabled = cz >= 5;
    const pz = document.querySelector('.present-bar .zv');
    if (pz) pz.textContent = el.btnZoomReset.textContent;
    return;
  }
  setContinuousZoom(getZoom(), false);
  applyZoomStyles();
}

function stepZoom(dir) {
  const z = getZoom();
  let i;
  if (dir > 0) {
    i = ZOOMS.findIndex((v) => v > z + 0.01);
    if (i < 0) i = ZOOMS.length - 1;
  } else {
    i = ZOOMS.reduce((acc, v, idx) => (v < z - 0.01 ? idx : acc), 0);
  }
  setContinuousZoom(ZOOMS[i], true);
  applyZoomStyles();
}

function setupEditorZoomGestures() {
  const target = el.editorPane;
  if (!target) return;

  const isExcluded = (node) => {
    if (!node || !node.closest) return false;
    return !!node.closest('.editor-bar, .fmt-bar, .cv-bar, .editor-foot, dialog, .present-bar');
  };

  // 1. PC Touchpad pinch & Ctrl+Wheel (scales note content only, never toolbars)
  // Listening on window prevents edge-drift viewport zoom jumps while checking target container
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    if (canvasOpen() || (el.editor && el.editor.hidden)) return;
    if (isExcluded(e.target)) return;
    if (!target.contains(e.target) && !document.body.classList.contains('presenting')) return;
    e.preventDefault();

    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 100;

    dy = Math.max(-100, Math.min(100, dy));
    const factor = Math.exp(-dy * 0.003);
    const nextZoom = getZoom() * factor;
    setContinuousZoom(nextZoom, false);
  }, { passive: false });

  // 2. iOS Safari gesture events (gesturestart / gesturechange / gestureend)
  let gestureZoom = null;
  target.addEventListener('gesturestart', (e) => {
    if (canvasOpen() || (el.editor && el.editor.hidden) || isExcluded(e.target)) {
      gestureZoom = null;
      return;
    }
    e.preventDefault();
    gestureZoom = getZoom();
  }, { passive: false });

  target.addEventListener('gesturechange', (e) => {
    if (gestureZoom == null || canvasOpen() || (el.editor && el.editor.hidden)) return;
    e.preventDefault();
    setContinuousZoom(gestureZoom * e.scale, false);
  }, { passive: false });

  const finishGesture = () => {
    if (gestureZoom != null) {
      setContinuousZoom(getZoom(), true);
      gestureZoom = null;
    }
  };
  target.addEventListener('gestureend', finishGesture);
  target.addEventListener('gesturecancel', finishGesture);

  // 3. Mobile Touchscreen two-finger pinch (Android, touchscreen PCs, iOS fallback)
  let notePinch = null;
  target.addEventListener('touchstart', (e) => {
    if (canvasOpen() || (el.editor && el.editor.hidden) || isExcluded(e.target)) {
      notePinch = null;
      return;
    }
    if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      notePinch = {
        d: Math.max(d, 8),
        z: getZoom()
      };
    } else {
      notePinch = null;
    }
  }, { passive: true });

  target.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      if (canvasOpen() || (el.editor && el.editor.hidden) || isExcluded(e.target)) return;
      // Prevent mobile browser viewport from zooming the entire page/toolbar
      e.preventDefault();
      if (gestureZoom != null) return; // handled by gesturechange
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      if (!notePinch) {
        notePinch = { d: Math.max(d, 8), z: getZoom() };
        return;
      }
      const ratio = d / notePinch.d;
      setContinuousZoom(notePinch.z * ratio, false);
    } 
  }, { passive: false });

  const finishPinch = (e) => {
    if (notePinch) {
      if (e.touches && e.touches.length >= 2) return;
      setContinuousZoom(getZoom(), true);
      notePinch = null;
    }
  };
  target.addEventListener('touchend', finishPinch, { passive: true });
  target.addEventListener('touchcancel', finishPinch, { passive: true });
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
    for (const d of $$('dialog[open]')) closeDialog(d, true);
    closeMenu(true);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    lk.mode = mode;
    lk.digits = '';
    lk.done = resolve;
    setAnimatedVisible(el.lock, true, 150);
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
  haptic('error');
}
function endLock(ok) {
  const { done, mode } = lk;
  lk.mode = null;
  lk.done = null;
  lk.digits = '';
  lk.first = '';
  setAnimatedVisible(el.lock, false, 145);
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
  const ids = Array.isArray(id) ? id : [id];
  if (!ids.length) return;
  const ok = await confirmDialog(
    `Remove “${name}”?`,
    'It will be signed out of SyncPad, and its copy of your notes and files will be erased the next time it goes online. Your other devices switch to a new private link automatically — nothing to do on them.',
    'Remove device',
    true
  );
  if (!ok) return;
  if (!navigator.onLine) { toast('Go online to remove a device.'); return; }
  const token = rid(24);
  let r = await fetch(`/api/s/${store.get('space')}/rotate`, { method: 'POST', headers: sync.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ remove: ids, token }) }).catch(() => null);
  if (r && r.status === 409) {
    const j = await r.json().catch(() => ({}));
    if (j.token) await sync.setToken(j.token);
    r = await fetch(`/api/s/${store.get('space')}/rotate`, { method: 'POST', headers: sync.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ remove: ids, token }) }).catch(() => null);
  }
  if (r && r.status === 403) { toast('Only a main device can remove devices.'); loadDevices(); return; }
  if (!r || !r.ok) { toast('Could not remove the device. Try again in a moment.'); return; }
  await sync.setToken(token);
  sync.devices = sync.devices.filter((d) => !ids.includes(d.id));
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
  const wasOpen = !m.hidden;
  clearTimeout(ui.menuCloseT);
  ui.menuCloseT = 0;
  m.classList.remove('is-leaving');
  if (ui.menuOutside) { document.removeEventListener('pointerdown', ui.menuOutside, true); ui.menuOutside = null; }
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
      const flipX = left + mw > innerWidth - 8;
      const flipY = top + mh > innerHeight - 8;
      if (flipX) left = Math.max(8, at.x - mw - 2);
      if (flipY) top = Math.max(8, at.y - mh - 2);
      m.style.top = top + 'px';
      m.style.left = left + 'px';
      m.style.transformOrigin = `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`;
    } else {
      const r = anchor.getBoundingClientRect();
      let top = r.bottom + 6;
      const flipY = top + mh > innerHeight - 8;
      if (flipY) top = Math.max(8, r.top - mh - 6);
      m.style.top = top + 'px';
      m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
      m.style.transformOrigin = `${flipY ? 'bottom' : 'top'} right`;
    }
  } else {
    m.style.left = '';
    m.style.top = '';
    m.style.transformOrigin = 'bottom center';
  }
  if (wasOpen && !reducedMotion()) {
    m.style.animation = 'none';
    void m.offsetWidth;
    m.style.animation = '';
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
function closeMenu(immediate = false) {
  const m = el.menu;
  if (ui.ctxNode) { ui.ctxNode.classList.remove('ctx'); ui.ctxNode = null; }
  if (ui.menuOutside) { document.removeEventListener('pointerdown', ui.menuOutside, true); ui.menuOutside = null; }
  if (m.hidden) return;
  if (immediate || reducedMotion()) {
    clearTimeout(ui.menuCloseT);
    ui.menuCloseT = 0;
    m.classList.remove('is-leaving');
    m.hidden = true;
    return;
  }
  if (m.classList.contains('is-leaving')) return;
  m.classList.add('is-leaving');
  clearTimeout(ui.menuCloseT);
  ui.menuCloseT = setTimeout(() => {
    m.classList.remove('is-leaving');
    m.hidden = true;
    ui.menuCloseT = 0;
  }, 110);
}

function toast(msg, { action, onAction, duration = 3500 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  const remove = () => {
    clearTimeout(t._autoT);
    if (!t.isConnected || t.classList.contains('is-leaving')) return;
    if (reducedMotion()) { t.remove(); return; }
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), 140);
  };
  if (action) t.querySelector('button').onclick = () => { remove(); onAction && onAction(); };
  el.toasts.appendChild(t);
  while (el.toasts.children.length > 3) el.toasts.firstElementChild.remove();
  t._autoT = setTimeout(remove, duration);
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
    reg.update().catch(() => {});
    // the app now opens from the device, so look for a newer version whenever it comes back to the front
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (had && !reloaded && !ui.dirty && !files.queue.length) { reloaded = true; location.reload(); }
  });
}

/* ═════════════════════════ 3.0: one “New note” button, selecting & arranging, reminders, long notes ═════════════════════════ */

function newMenu(anchor) {
  openMenu(anchor, [
    { icon: 'pen', label: 'New note', run: () => newNote() },
    { icon: 'task', label: 'New checklist', run: () => { newNote(); setTimeout(() => { makeChecklist(); onEditorInput(); }, 40); } },
    { icon: 'canvas', label: 'New canvas — draw and place anything', run: () => newNote({ canvas: true }) },
    { icon: 'clip', label: 'Add files to all devices…', run: () => el.fileInput.click() },
    { icon: 'doc', label: 'New document (Word or PDF)', run: newDocument },
    { icon: 'book', label: 'Import e-book or document as a note…', run: () => el.importInput.click() }
  ]);
}

/* ───────── selecting several notes ───────── */

const selNotes = () => [...ui.nsel].map((id) => store.items.get(id)).filter((n) => n && n.kind === 'note');
function enterNoteSelect(id) {
  if (!ui.nselecting) { haptic('heavy'); ui.nselecting = true; ui.nsel = new Set(); el.app.classList.add('nselecting'); }
  if (id) ui.nsel.add(id);
  renderNotesList();
}
function exitNoteSelect() {
  if (!ui.nselecting) return;
  ui.nselecting = false;
  ui.nsel.clear();
  el.app.classList.remove('nselecting');
  renderNotesList();
}
function toggleNoteSel(id) {
  haptic('tick');
  if (ui.nsel.has(id)) ui.nsel.delete(id); else ui.nsel.add(id);
  ui.lastNotePicked = id;
  renderNotesList();
}
function renderNoteSelectBar() {
  const on = ui.nselecting && ui.tab === 'notes';
  setAnimatedVisible(el.nselBar, on, 120);
  el.app.classList.toggle('nsel-on', on);
  el.btnNselect.textContent = ui.nselecting ? 'Done' : 'Select';
  const n = ui.nsel.size;
  el.nselCount.textContent = n ? `${n} selected` : 'Tap notes to select';
  for (const b of $$('[data-nsel]', el.nselBar)) if (!['cancel', 'all'].includes(b.dataset.nsel)) b.disabled = !n;
  const ns = selNotes();
  $('[data-nsel="pin"] .sel-lbl', el.nselBar).textContent = ns.length && ns.every((x) => x.data.pinned) ? 'Unpin' : 'Pin';
}
/** change several notes at once (one save each, then one sync) */
async function patchNotes(list, fn) {
  for (const n of list) {
    const p = fn(n);
    n.data = { ...n.data, ...p };
    for (const k of Object.keys(p)) if (p[k] == null) delete n.data[k];
    if (store.items.has(n.id)) await store.save(n);
  }
  sync.schedule();
  renderNotesList();
  if (ui.noteId && list.some((n) => n.id === ui.noteId)) renderEditor(false);
}
function visibleNoteIds() { return $$('.note-item', el.noteList).map((b) => b.dataset.id); }
async function nselAction(act, b) {
  if (act === 'cancel') return exitNoteSelect();
  if (act === 'all') {
    const v = visibleNoteIds();
    ui.nsel = new Set(v.every((id) => ui.nsel.has(id)) ? [] : v);
    renderNotesList();
    return;
  }
  const ns = selNotes();
  if (!ns.length) return;
  const many = ns.length === 1 ? 'Note' : `${ns.length} notes`;
  if (act === 'pin') {
    const on = !ns.every((x) => x.data.pinned);
    await patchNotes(ns, () => ({ pinned: on || null }));
    toast(on ? `${many} pinned to the top` : `${many} unpinned`);
  } else if (act === 'move') {
    const fs = noteFolders();
    pickMenu(b, 'Folder', [['', 'No folder'], ...fs.map((f) => [f.id, f.name]), ['+new', '＋ New folder…']], '', async (v) => {
      if (v === '+new') { const f = await newNoteFolder(); if (!f) return; v = f.id; }
      await patchNotes(ns, () => ({ nf: v || null }));
      const f = noteFolders().find((x) => x.id === v);
      toast(f ? `${many} moved to “${f.name}”` : `${many} removed from folders`);
      exitNoteSelect();
    });
  } else if (act === 'more') {
    const arch = ns.every((x) => x.data.archived);
    openMenu(b, [
      { icon: 'marker', label: 'Colour…', run: () => pickMenu(b, 'Colour', [['', 'No colour', 'transparent'], ...NOTE_COLORS.map(([v, c, l]) => [v, l, c])], '', (v) => patchNotes(ns, () => ({ color: v || null }))) },
      { icon: 'file', label: 'Paper…', run: () => pickMenu(b, 'Paper', NOTE_PAPERS, '', (v) => patchNotes(ns, () => ({ paper: v || null }))) },
      { icon: 'bell', label: 'Remind me…', run: () => remindMenu(b, ns) },
      { icon: 'archive', label: arch ? 'Unarchive' : 'Archive', run: async () => { await patchNotes(ns, () => ({ archived: arch ? null : true })); toast(arch ? `${many} back in your notes` : `${many} archived`); exitNoteSelect(); } },
      ...(ns.length > 1 ? [{ icon: 'note', label: `Merge into one note`, run: () => mergeNotes(ns) }] : []),
      { icon: 'download', label: ns.length > 1 ? 'Save as one PDF' : 'Save as PDF', run: () => saveNotesPdf(ns) },
      { icon: 'copy', label: 'Copy text', run: async () => { await copyText(ns.map((n) => noteFullText(n)).join('\n\n———\n\n')); toast('Copied'); } },
      { icon: 'copy', label: 'Duplicate', run: () => duplicateNotes(ns) }
    ]);
  } else if (act === 'trash') {
    const ids = ns.map((n) => n.id);
    if (ui.noteId && ids.includes(ui.noteId)) closeEditor();
    await patchNotes(ns, () => ({ trashed: Date.now() }));
    exitNoteSelect();
    toast(`${many} moved to Trash`, { action: 'Undo', duration: 6000, onAction: async () => { for (const id of ids) await restoreItem(id); } });
  }
}
async function mergeNotes(ns) {
  const parts = ns.map((n) => (n.data.canvas ? sanitizeNote(n.data.html || '') : noteHtml(n)));
  const html = parts.join('<hr>');
  const now = Date.now();
  const n = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { html: '', text: '', pinned: false, ...(ns[0].data.nf ? { nf: ns[0].data.nf } : {}) } };
  await writeNoteContent(n, html, textOf(html));
  sync.schedule();
  exitNoteSelect();
  toast(`Merged ${ns.length} notes into a new note. The originals are unchanged.`, { action: 'Open', onAction: () => openNote(n.id) });
}
async function duplicateNotes(ns) {
  for (const src of ns) {
    const now = Date.now();
    const n = { id: rid(16), kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { ...JSON.parse(JSON.stringify(src.data)), pinned: false } };
    delete n.data.parts; delete n.data.conflictOf; delete n.data.remind; delete n.data.repeat; delete n.data.pos;
    if (src.data.parts) await writeNoteContent(n, joinParts(src), noteFullText(src)); else await store.save(n);
  }
  sync.schedule();
  exitNoteSelect();
  toast(ns.length === 1 ? 'Note duplicated' : `${ns.length} notes duplicated`);
}

/* ───────── arranging notes and drops by hand ───────── */

function blockClicks() { ui.blockClickUntil = Date.now() + 700; }
const clickBlocked = () => Date.now() < (ui.blockClickUntil || 0);

async function placeNote(id, prevId, nextId) {
  const n = store.items.get(id);
  if (!n) return;
  let a = prevId && store.items.get(prevId);
  let b = nextId && store.items.get(nextId);
  // pinned notes always stay on top: dropping among them pins it, below them unpins it
  const pa = a ? !!a.data.pinned : null;
  const pb = b ? !!b.data.pinned : null;
  let pinned = !!n.data.pinned;
  if (a && b && pa === pb) pinned = pa;
  else if (!a && b) pinned = pb;
  else if (a && !b) pinned = pa;
  if (a && !!a.data.pinned !== pinned) a = null;
  if (b && !!b.data.pinned !== pinned) b = null;
  if (a && b && Math.abs(posOf(a) - posOf(b)) < 1e-6) {
    await renumber(visibleNoteIds().filter((x) => x !== id).map((x) => store.items.get(x)).filter(Boolean));
  }
  await patchNotes([n], () => ({ pos: between(a ? posOf(a) : null, b ? posOf(b) : null), pinned: pinned || null }));
  if (ui.switchedSort) { ui.switchedSort = false; toast('Notes now stay in your own order. Change it with the view button → Sort.'); }
}
async function placeDrops(ids, prevId, nextId) {
  const a = prevId && store.items.get(prevId);
  const b = nextId && store.items.get(nextId);
  let hi = a ? posOf(a) : null;
  const lo = b ? posOf(b) : null;
  if (hi != null && lo != null && Math.abs(hi - lo) < 1e-6) {
    await renumber(visibleDrops().filter((x) => !ids.includes(x.id)));
    hi = posOf(a);
  }
  const top = hi == null ? (lo == null ? Date.now() : lo + 60_000 * (ids.length + 1)) : hi;
  const bottom = lo == null ? top - 60_000 * (ids.length + 1) : lo;
  for (let k = 0; k < ids.length; k++) {
    const it = store.items.get(ids[k]);
    if (!it) continue;
    it.data = { ...it.data, pos: top - ((top - bottom) * (k + 1)) / (ids.length + 1) };
    await store.save(it);
  }
  sync.schedule();
  renderDrops();
  if (ui.switchedSort) { ui.switchedSort = false; toast('Drops now stay in your own order. Change it with the sort button.'); }
}
/** give every item in a list its own position (only needed when two positions collide) */
async function renumber(list) {
  const top = Date.now();
  for (let k = 0; k < list.length; k++) { const it = list[k]; it.data = { ...it.data, pos: top - k * 60_000 }; await store.save(it); }
}
function dropSortMenu(anchor) {
  const cur = dropOrder();
  pickMenu(anchor, 'Sort', [['new', 'Newest first (by day)'], ['custom', 'My order — hold & drag to arrange']], cur, (v) => { lsSet('sp-dsort', v); cards.clear(); renderDrops(); });
}
function setupArranging() {
  // touch: hold a note → it's selected; keep holding and drag → it moves
  touchReorder(el.noteList, {
    item: '.note-item',
    scroller: el.noteList,
    onHold: (id) => { if (!ui.nselecting) enterNoteSelect(id); else if (!ui.nsel.has(id)) toggleNoteSel(id); },
    canDrag: () => !ui.query && !ui.tag,
    onStart: (id) => {
      ui.nselecting = false;
      ui.nsel.clear();
      el.app.classList.remove('nselecting');
      if (lsGet('sp-nsort', 'edited') !== 'custom') { lsSet('sp-nsort', 'custom'); ui.switchedSort = true; }
      renderNotesList();
      return el.noteList.querySelector(`.note-item[data-id="${CSS.escape(id)}"]`);
    },
    onDrop: (id, prev, next) => placeNote(id, prev, next),
    blockClick: blockClicks
  });
  touchReorder(el.feedInner, {
    item: 'article[data-id]',
    scroller: el.feed,
    onHold: (id) => { if (!ui.selecting) enterSelect(); if (!ui.selected.has(id)) toggleSelect(id); },
    canDrag: () => !ui.query,
    onStart: (id) => {
      ui.selecting = false;
      ui.selected.clear();
      el.app.classList.remove('selecting');
      renderSelectBar();
      if (dropOrder() !== 'custom') { lsSet('sp-dsort', 'custom'); ui.switchedSort = true; }
      cards.clear();
      renderDrops();
      return el.feedInner.querySelector(`article[data-id="${CSS.escape(id)}"]`);
    },
    onDrop: (id, prev, next) => placeDrops([id], prev, next),
    blockClick: () => { blockClicks(); ui.suppressClick = true; setTimeout(() => { ui.suppressClick = false; }, 700); }
  });
  // mouse: drag a note or drop within its list (a line shows where it lands)
  const marker = document.createElement('div');
  marker.className = 'rd-marker';
  marker.hidden = true;
  document.body.append(marker);
  const showMarker = (at) => {
    if (!at.ref) { marker.hidden = true; return; }
    const r = at.ref.getBoundingClientRect();
    const grid = at.ref.parentElement && getComputedStyle(at.ref.parentElement).display === 'grid' && at.ref.parentElement.offsetWidth > r.width * 1.5;
    marker.hidden = false;
    marker.classList.toggle('v', !!grid);
    if (grid) Object.assign(marker.style, { left: (at.side === 'before' ? r.left - 5 : r.right + 3) + 'px', top: r.top + 'px', width: '3px', height: r.height + 'px' });
    else Object.assign(marker.style, { left: r.left + 'px', top: (at.side === 'before' ? r.top - 5 : r.bottom + 2) + 'px', width: r.width + 'px', height: '3px' });
  };
  const hide = () => { marker.hidden = true; };
  el.noteList.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('application/x-syncpad-note') || ui.query) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showMarker(slot($$('.note-item', el.noteList), e.clientX, e.clientY, ui.dragNote && el.noteList.querySelector(`.note-item[data-id="${CSS.escape(ui.dragNote)}"]`)));
  });
  el.noteList.addEventListener('dragleave', (e) => { if (!el.noteList.contains(e.relatedTarget)) hide(); });
  el.noteList.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData('application/x-syncpad-note');
    hide();
    if (!id || ui.query) return;
    e.preventDefault();
    const self = el.noteList.querySelector(`.note-item[data-id="${CSS.escape(id)}"]`);
    const at = slot($$('.note-item', el.noteList), e.clientX, e.clientY, self);
    if (!at.ref) return;
    if (lsGet('sp-nsort', 'edited') !== 'custom') { lsSet('sp-nsort', 'custom'); ui.switchedSort = true; }
    placeNote(id, at.before && at.before.dataset.id, at.after && at.after.dataset.id);
  });
  el.feedInner.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('application/x-syncpad') || ui.query) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    showMarker(slot($$('article[data-id]', el.feedInner), e.clientX, e.clientY, ui.dragDrop && el.feedInner.querySelector(`article[data-id="${CSS.escape(ui.dragDrop)}"]`)));
  });
  el.feedInner.addEventListener('dragleave', (e) => { if (!el.feedInner.contains(e.relatedTarget)) hide(); });
  el.feedInner.addEventListener('drop', (e) => {
    const raw = e.dataTransfer.getData('application/x-syncpad');
    hide();
    if (!raw || ui.query) return;
    e.preventDefault();
    e.stopPropagation();
    let ids;
    try { ids = JSON.parse(raw); } catch { return; }
    const rows = $$('article[data-id]', el.feedInner).filter((r) => !ids.includes(r.dataset.id));
    const at = slot(rows, e.clientX, e.clientY);
    if (!at.ref) return;
    if (dropOrder() !== 'custom') { lsSet('sp-dsort', 'custom'); ui.switchedSort = true; }
    placeDrops(ids, at.before && at.before.dataset.id, at.after && at.after.dataset.id);
  });
  addEventListener('dragend', hide);
}

/* ───────── reminders ───────── */

const DAYMS = 86_400_000;
function remindNext(n, after = Date.now()) {
  const at = Number(n.data.remind);
  if (!at) return null;
  if (at > after) return at;
  const rep = n.data.repeat;
  if (rep === 'daily' || rep === 'weekly') { const step = (rep === 'daily' ? 1 : 7) * DAYMS; return at + Math.ceil((after - at + 1) / step) * step; }
  if (rep === 'monthly') { const d = new Date(at); for (let k = 1; k < 1200; k++) { const t = new Date(d); t.setMonth(d.getMonth() + k); if (t.getTime() > after) return t.getTime(); } }
  return null;
}
function fmtWhen(t) {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / DAYMS);
  if (diff === 0) return time;
  if (diff === 1) return 'Tomorrow ' + time;
  if (diff === -1) return 'Yesterday ' + time;
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
}
function remindLabel(n) {
  const t = remindNext(n) || Number(n.data.remind);
  return fmtWhen(t) + (n.data.repeat ? ' ↻' : '');
}
function remindMenu(anchor, notes) {
  const now = new Date();
  const at = (h, addDays = 0) => { const d = new Date(); d.setDate(d.getDate() + addDays); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const inHour = Math.ceil((Date.now() + 3_600_000) / 300_000) * 300_000;
  const monday = (() => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(8, 0, 0, 0); return d.getTime(); })();
  const presets = [['In 1 hour', inHour]];
  if (now.getHours() < 17) presets.push(['This evening', at(18)]);
  else if (now.getHours() < 20) presets.push(['Tonight', at(21)]);
  presets.push(['Tomorrow morning', at(8, 1)], ['Next Monday', monday]);
  const cur = notes.length === 1 && notes[0].data.remind ? notes[0] : null;
  const local = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };
  const html = `<div class="rm-head"><svg class="ic"><use href="#i-bell"/></svg><b>Remind me</b>${cur ? `<span class="muted">${esc(remindLabel(cur))}</span>` : ''}</div>` +
    presets.map(([l, t]) => `<button data-rm="${t}"><svg class="ic"><use href="#i-bell"/></svg><span>${esc(l)}</span><small>${esc(fmtWhen(t))}</small></button>`).join('') +
    `<div class="rm-pick"><input type="datetime-local" class="rm-when" value="${local(cur ? remindNext(cur) || cur.data.remind : at(9, 1))}" aria-label="Date and time">
      <select class="rm-rep" aria-label="Repeat">${[['', 'Once'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']].map(([v, l]) => `<option value="${v}"${cur && (cur.data.repeat || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn btn-primary btn-sm" data-rm="pick">Set</button></div>` +
    (notes.some((n) => n.data.remind) ? '<button data-rm="off" class="danger"><svg class="ic"><use href="#i-x"/></svg><span>Remove reminder</span></button>' : '');
  openMenu(anchor, null, {
    content: html,
    onClick: (b) => {
      const v = b.dataset.rm;
      if (!v) return;
      if (v === 'off') { setReminder(notes, null); return; }
      if (v === 'pick') {
        const t = new Date(el.menu.querySelector('.rm-when').value).getTime();
        if (!Number.isFinite(t)) { toast('Pick a date and time first.'); return; }
        setReminder(notes, t, el.menu.querySelector('.rm-rep').value);
        return;
      }
      setReminder(notes, Number(v), '');
    }
  });
  el.menu.classList.add('rm-menu');
  const clear = () => { el.menu.classList.remove('rm-menu'); };
  setTimeout(() => { const obs = new MutationObserver(() => { if (el.menu.hidden) { clear(); obs.disconnect(); } }); obs.observe(el.menu, { attributes: true, attributeFilter: ['hidden'] }); }, 0);
}
async function setReminder(notes, at, repeat = '') {
  if (ui.noteId && notes.some((n) => n.id === ui.noteId)) await saveNote.flush();
  const saved = notes.filter((n) => store.items.has(n.id));
  if (!saved.length) { toast('Write something in the note first.'); return; }
  if (at && at < Date.now() - 60_000 && !repeat) { toast('That time has already passed.'); return; }
  await patchNotes(saved, () => (at ? { remind: at, repeat: repeat || null } : { remind: null, repeat: null }));
  renderRemindButton();
  scheduleLocalReminders();
  if (!at) { toast('Reminder removed'); return; }
  toast(`I’ll remind you ${fmtWhen(remindNext(saved[0]) || at).replace(/^(\d)/, 'at $1')}${repeat ? ' (repeats)' : ''}`);
  // a reminder needs notifications on this device; ask once
  if (pushSupported() && !(store.get('push') && Notification.permission === 'granted') && Notification.permission !== 'denied') {
    try {
      if ((await Notification.requestPermission()) === 'granted') { await subscribePush(true); toast('Notifications are on — reminders reach this device even when SyncPad is closed.'); }
    } catch {}
  }
}
function renderRemindButton() {
  const n = openNoteItem();
  const on = !!(n && n.data.remind && remindNext(n));
  el.btnRemind.setAttribute('aria-pressed', String(on));
  el.btnRemind.title = on ? 'Reminder: ' + remindLabel(n) : 'Remind me about this note';
}
/** while SyncPad is open, reminders also fire here (the server sends them to closed devices) */
function scheduleLocalReminders() {
  clearTimeout(ui.remindTimer);
  const now = Date.now();
  if (!ui.remindFrom) {
    // catch up on reminders that came due while SyncPad was closed (up to a week back)
    let seen = 0;
    try { seen = Number(localStorage.getItem('sp-remind-seen')) || 0; } catch {}
    ui.remindFrom = seen ? Math.max(seen, now - 7 * 864e5) : now;
    if (!ui.remindSeenT) ui.remindSeenT = setInterval(() => { try { localStorage.setItem('sp-remind-seen', String(Date.now())); } catch {} }, 30_000);
    try { localStorage.setItem('sp-remind-seen', String(now)); } catch {}
  }
  let next = null;
  for (const n of store.list('note')) {
    if (n.data.trashed || !n.data.remind) continue;
    const t = remindNext(n, ui.remindFrom);
    if (t && (next === null || t < next)) next = t;
  }
  if (next !== null) ui.remindTimer = setTimeout(fireLocalReminders, Math.max(0, Math.min(next - now, 2 ** 31 - 1)));
}
function fireLocalReminders() {
  const now = Date.now();
  const from = ui.remindFrom || now;
  ui.remindFrom = now + 1;
  for (const n of store.list('note')) {
    if (n.data.trashed || !n.data.remind) continue;
    const t = remindNext(n, from - 1);
    if (t && t <= now + 500) showReminder(n, now - t > 2 * 60_000 ? t : 0);
  }
  try { localStorage.setItem('sp-remind-seen', String(now)); } catch {}
  scheduleLocalReminders();
}
function showReminder(n, missedAt = 0) {
  ui.shownReminders ||= new Map();
  const last = ui.shownReminders.get(n.id) || 0;
  if (Date.now() - last < 90_000) return;
  ui.shownReminders.set(n.id, Date.now());
  const title = noteTitle(noteText(n)) || 'Note';
  const missed = missedAt ? `Missed at ${new Date(missedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ` : '';
  if (document.visibilityState === 'visible') {
    haptic('success');
    toast(`🔔 ${missed}${title}`, { action: 'Open', onAction: () => openNote(n.id), duration: missed ? 30000 : 15000 });
  } else if ('Notification' in window && Notification.permission === 'granted') {
    // rings on this device by itself, even offline; the same tag means a server push for it replaces, not doubles, it
    navigator.serviceWorker.ready.then((reg) => reg.showNotification('🔔 ' + title, { body: missed + noteSnippet(noteText(n), 140), tag: 'remind-' + n.id, requireInteraction: true, icon: '/icons/icon-192.png', data: { url: '/?note=' + n.id } })).catch(() => {});
  }
}

/* ───────── long notes (stored in parts) ───────── */

function joinParts(n) { return (n.data.parts || []).map((id) => { const p = store.items.get(id); return p ? p.data.html || '' : ''; }).join(''); }
const partsReady = (n) => !n.data.parts || n.data.parts.every((id) => store.items.has(id));
function noteFullText(n) {
  if (!n.data.parts) return noteText(n);
  return n.data.parts.map((id) => { const p = store.items.get(id); return p ? p.data.text || '' : ''; }).join('\n');
}
function noteMatches(n, ts) {
  const f = noteFolders().find((x) => x.id === n.data.nf);
  return matches(ts, noteText(n), f && f.name) || (!!n.data.parts && matches(ts, noteFullText(n)));
}
function noteHit(n, ts) {
  const t = noteFullText(n);
  const body = t.slice(noteTitle(t).length);
  return snippet(body, ts, 170) || '';
}
/** Save a note's content; very long notes go into parts so each piece fits the sync limit */
async function writeNoteContent(n, html, text) {
  const old = n.data.parts || [];
  const { body, parts, chars, ...rest } = n.data;
  if (html.length <= BIG) {
    n.data = { ...rest, html, text };
    await store.save(n);
  } else {
    const segs = splitHtml(html);
    const used = new Set();
    const ids = [];
    for (let i = 0; i < segs.length; i++) {
      const id = partId(n.id, segs[i], used);
      ids.push(id);
      const ex = store.items.get(id);
      if (ex && ex.data.html === segs[i] && ex.data.of === n.id && ex.data.i === i) continue;
      const now = Date.now();
      const p = ex || { id, kind: 'part', rev: 0, created: now, updated: now, device: me(), data: {} };
      p.data = { of: n.id, i, html: segs[i], text: textOf(segs[i]) };
      await store.save(p);
    }
    n.data = { ...rest, html: '', text: text.slice(0, 8000), parts: ids, chars: text.length };
    await store.save(n);
  }
  const keep = new Set(n.data.parts || []);
  for (const id of old) if (!keep.has(id)) { const p = store.items.get(id); if (p) await store.remove(p); }
}

/* ───────── importing e-books and documents as notes ───────── */

async function importAsNote(file) {
  const name = file.name || 'Imported';
  const ext = (name.split('.').pop() || '').toLowerCase();
  toast(`Importing “${name}”…`, { duration: 8000 });
  const id = rid(16);
  let html = '';
  try {
    if (ext === 'epub' || /epub/.test(file.type)) {
      const { readEpub } = await import('./epub.js');
      const book = await readEpub(new Uint8Array(await file.arrayBuffer()));
      // pictures become files inside the note
      const map = new Map();
      for (const [path, blob] of book.images) {
        const f = new File([blob], path.split('/').pop() || 'picture.jpg', { type: blob.type });
        const [it] = await files.add([f], { parent: id });
        if (it) map.set(path, it.id);
      }
      const fix = (h) => h.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (m, src) => (map.has(src) ? `<img data-file="${map.get(src)}" alt="">` : ''));
      html = `<h1>${esc(book.title)}</h1>` + (book.author ? `<p><i>${esc(book.author)}</i></p>` : '') +
        (book.cover && map.has(book.cover) && !book.chapters.some((c) => c.html.includes(book.cover)) ? `<p><img data-file="${map.get(book.cover)}" alt="" data-align="center" style="width:45%"></p>` : '') +
        book.chapters.map((c) => {
          const h = fix(c.html);
          const hasTitle = c.title && /<h[1-3]\b/i.test(h.slice(0, 600));
          return (c.title && !hasTitle ? `<h2>${esc(c.title)}</h2>` : '') + h;
        }).join('<hr>');
    } else if (ext === 'docx') {
      const M = await import('./docmodel.js');
      html = M.modelToHtml(M.readDocx(new Uint8Array(await file.arrayBuffer())));
    } else if (ext === 'md' || ext === 'markdown') {
      html = markdownToHtml(await file.text());
    } else if (ext === 'html' || ext === 'htm') {
      const d = new DOMParser().parseFromString(await file.text(), 'text/html');
      html = d.body ? d.body.innerHTML : '';
    } else {
      html = textToHtml(await file.text());
    }
  } catch (err) {
    toast(`Could not import “${name}”: ${err.message || 'unknown format'}`, { duration: 7000 });
    return;
  }
  html = sanitizeNote(html);
  const text = textOf(html);
  if (!text.trim() && !/data-file/.test(html)) { toast('That file has no text to import.'); return; }
  const now = Date.now();
  const n = { id, kind: 'note', rev: 0, created: now, updated: now, device: me(), data: { html: '', text: '', pinned: false, ...(ui.nfolder && ui.nfolder !== 'archive' ? { nf: ui.nfolder } : {}) } };
  await writeNoteContent(n, html, text);
  sync.schedule();
  const pages = Math.max(1, Math.round(text.length / 1800));
  toast(`Imported “${name}” — about ${pages} page${pages === 1 ? '' : 's'}.`);
  openNote(n.id);
}

/* ───────── e-book viewer (Drops) ───────── */

async function openEpubViewer(it) {
  let blob;
  try { blob = await files.blobOf(it); } catch {}
  if (!blob) { toast('Could not load this e-book. Check your connection.'); return; }
  ui.viewing = it;
  el.viewerTitle.textContent = it.data.name;
  el.viewerShare.hidden = !navigator.share;
  el.viewerDownload.hidden = false;
  el.viewerMarkup.hidden = false;
  el.viewerMarkup.innerHTML = '<svg class="ic"><use href="#i-note"/></svg><span>Open as note</span>';
  el.viewerBody.classList.add('is-docv');
  el.viewerBody.innerHTML = '<div class="dv-loading">Opening…</div>';
  ui.epubOpen = it;
  openDialog(el.dlgViewer);
  try {
    const { readEpub } = await import('./epub.js');
    const book = await readEpub(new Uint8Array(await blob.arrayBuffer()));
    const urls = new Map([...book.images].map(([p, b]) => [p, URL.createObjectURL(b)]));
    ui.epubUrls = [...urls.values()];
    const clean = (h) => (window.DOMPurify ? DOMPurify.sanitize(h) : h).replace(/<img\b([^>]*)\bsrc="([^"]+)"/g, (m, pre, src) => (urls.has(src) ? `<img${pre}src="${urls.get(src)}"` : m));
    const wrap = document.createElement('div');
    wrap.className = 'dv-scroll epub-scroll';
    wrap.innerHTML = `<article class="epub-book doc-view"><header><h1>${esc(book.title)}</h1>${book.author ? `<p class="epub-by">${esc(book.author)}</p>` : ''}</header>` +
      book.chapters.map((c, i) => `<section class="epub-ch" data-i="${i}">${clean(c.html)}</section>`).join('') + '</article>';
    el.viewerBody.replaceChildren(wrap);
    let z = Number(lsGet('sp-epub-z', '1')) || 1;
    const apply = () => { wrap.style.setProperty('--ez', z); lsSet('sp-epub-z', String(z)); };
    apply();
    ui.zoom = { zoomBy: (f) => { z = Math.max(0.7, Math.min(2.4, z * (f > 1 ? 1.1 : 1 / 1.1))); apply(); }, fit: () => { z = 1; apply(); }, destroy: () => {} };
    if (ui.openPage > 1) { const s = wrap.querySelector(`.epub-ch[data-i="${ui.openPage - 1}"]`); if (s) s.scrollIntoView(); }
    ui.openPage = 0;
  } catch (err) {
    el.viewerBody.innerHTML = `<div class="dv-empty">Could not open this e-book (${esc(err.message || 'unknown format')}).</div>`;
  }
}

/* ───────── save notes as PDF (keeps the layout: fonts, colours, pictures, paper) ───────── */

async function saveNotesPdf(ns) {
  const list = ns.filter(Boolean);
  if (!list.length) return;
  if (list.length === 1 && list[0].data.canvas) { if (ui.noteId !== list[0].id) openNote(list[0].id); exportCanvas(); return; }
  toast(list.length > 1 ? `Making a PDF of ${list.length} notes…` : 'Making the PDF…', { duration: 6000 });
  try {
    const { notesPdf } = await import('./notepdf.js');
    const docs = list.map((n) => ({
      html: n.data.canvas ? sanitizeNote(n.data.html || '') : n.id === ui.noteId && !n.data.parts ? sanitizeNote(el.editorText.innerHTML) : noteHtml(n),
      font: n.data.font || '',
      paper: n.data.paper || '',
      color: n.data.color ? (NOTE_COLORS.find((c) => c[0] === n.data.color) || [])[1] : ''
    }));
    const blob = await notesPdf(docs, { fileUrl: (id) => files.src(id) || files.url(id) });
    const title = noteTitle(noteText(list[0])) || 'Note';
    const fname = (list.length > 1 ? `${title} + ${list.length - 1} more` : title).replace(/[\\/:*?"<>|]+/g, '').slice(0, 60) + '.pdf';
    const file = new File([blob], fname, { type: 'application/pdf' });
    if (isTouch() && navigator.canShare && navigator.canShare({ files: [file] })) {
      openMenu(null, [
        { icon: 'download', label: 'Download the PDF', run: () => downloadBlob(blob, fname) },
        { icon: 'share', label: 'Share the PDF…', run: () => navigator.share({ files: [file], title: fname }).catch(() => {}) },
        { icon: 'drops', label: 'Send to Drops (all devices)', run: () => { sendFiles([file]); toast('Sent to Drops'); } }
      ]);
    } else {
      downloadBlob(blob, fname);
      toast('PDF saved', { action: 'Send to Drops', onAction: () => sendFiles([file]) });
    }
  } catch (err) {
    console.error(err);
    toast('Could not make the PDF: ' + (err.message || 'unknown error'));
  }
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ───────── draw / write on a picture inside a note or a canvas ───────── */

async function markupFile(fileId) {
  const it = store.items.get(fileId);
  if (!it) { toast('This picture is still on its way.'); return null; }
  let blob = null;
  try { blob = await files.blobOf(it); } catch {}
  if (!blob) { toast('Could not load this picture. Check your connection.'); return null; }
  let res;
  try { res = await markup.open(blob, it.data.type || blob.type, openDialog); } catch { toast('This picture can’t be edited here.'); return null; }
  if (!res) return null;
  const n = openNoteItem();
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[res.blob.type] || 'png';
  const name = String(it.data.name || 'picture').replace(/\.[a-z0-9]{2,5}$/i, '') + '.' + ext;
  const [nu] = await files.add([new File([res.blob], name, { type: res.blob.type })], { parent: (n && n.id) || it.data.parent || null });
  if (!nu) return null;
  if (!res.keep) { it.data = { ...it.data, trashed: Date.now() }; await store.save(it); sync.schedule(); }
  let size = {};
  try { size = (await imageSize(nu.id)) || {}; } catch {}
  toast(res.keep ? 'Saved. The original picture is kept in the note’s files.' : 'Picture updated.');
  return { id: nu.id, ...size };
}

/* ───────── capital letter at the start of a note and of every new line ───────── */

const BLOCKS = 'p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th';
function lineStartBefore(node, offsetInNode) {
  // true when nothing but spaces precedes this point on its line
  if (node.nodeType === 3 && node.data.slice(0, offsetInNode).trim()) return false;
  let n = node;
  while (n && n !== el.editorText) {
    let p = n.previousSibling;
    while (p) {
      if (p.nodeName === 'BR') return true;
      if (p.nodeType === 1 && p.matches(BLOCKS)) return true;
      if (p.nodeType === 1 && (p.matches('img, a[data-file], .link-card') || (p.textContent || '').trim())) return false;
      if (p.nodeType === 3 && p.data.trim()) return false;
      p = p.previousSibling;
    }
    n = n.parentNode;
    if (n && n.nodeType === 1 && n.matches(BLOCKS)) return true;
  }
  return true;
}
function capitalizeAt(node, i) {
  const word = (/^\S*/.exec(node.data.slice(i)) || [''])[0];
  if (/[./@:\\_#0-9]/.test(word.replace(/[.,!?;:]+$/, ''))) return false; // links, e-mails, file names, #tags stay as typed
  const ch = node.data[i];
  const up = ch.toLocaleUpperCase();
  if (up === ch || up.length !== 1) return false;
  const s = getSelection();
  const keep = s.rangeCount && s.anchorNode === node ? s.anchorOffset : null;
  node.data = node.data.slice(0, i) + up + node.data.slice(i + 1);
  if (keep != null) { const r = document.createRange(); r.setStart(node, keep); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
  ui.autoCap = { node, i, up, orig: ch };
  return true;
}
/** the capital we just made turned out to start a link or an e-mail (www.…, name@…): put it back */
function undoAutoCapIfLink() {
  const ac = ui.autoCap;
  if (!ac || !ac.node.isConnected || ac.node.data[ac.i] !== ac.up) { ui.autoCap = null; return; }
  const w = (/^\S*/.exec(ac.node.data.slice(ac.i)) || [''])[0];
  if (!/[./@:\\_#0-9]/.test(w.replace(/[.,!?;:]+$/, ''))) return;
  const s = getSelection();
  const keep = s.rangeCount && s.anchorNode === ac.node ? s.anchorOffset : null;
  ac.node.data = ac.node.data.slice(0, ac.i) + ac.orig + ac.node.data.slice(ac.i + 1);
  if (keep != null) { const r = document.createRange(); r.setStart(ac.node, keep); r.collapse(true); s.removeAllRanges(); s.addRange(r); }
  ui.autoCap = null;
}
function autoCapital(e) {
  if (lsGet('sp-autocap', '1') !== '1' || e.isComposing) return;
  if (ui.autoCap) undoAutoCapIfLink();
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed || !el.editorText.contains(s.anchorNode)) return;
  const node = s.anchorNode;
  if (node.nodeType !== 3 || (node.parentElement && node.parentElement.closest('pre, code, a, .link-card'))) return;
  const before = node.data.slice(0, s.anchorOffset);
  const t = e.inputType;
  let changed = false;
  if (t === 'insertText' && e.data && e.data.length === 1 && /\p{Ll}/u.test(e.data)) {
    // typing on a keyboard: the first letter of a line
    const i = s.anchorOffset - 1;
    if (i >= 0 && !before.slice(0, i).trim() && lineStartBefore(node, i)) changed = capitalizeAt(node, i);
  } else if ((t === 'insertText' && e.data && /^[\s.,!?;:]$/.test(e.data)) || t === 'insertCompositionText' || t === 'insertReplacementText') {
    // phone keyboards: once the first word of a line is finished
    const m = /^(\s*)(\p{Ll})\S*[\s.,!?;:]?$/u.exec(before);
    if (m && lineStartBefore(node, m[1].length) && t !== 'insertCompositionText') changed = capitalizeAt(node, m[1].length);
  }
  if (changed) { ui.dirty = true; saveNote(); }
}
function autoCapitalPrevLine() {
  // Enter after a one-word line on a phone keyboard: capitalize that word
  if (lsGet('sp-autocap', '1') !== '1') return;
  const s = getSelection();
  if (!s.rangeCount) return;
  let b = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
  b = b && b.closest(BLOCKS);
  const prev = b && b.previousElementSibling;
  if (!prev || !el.editorText.contains(prev)) return;
  const w = document.createTreeWalker(prev, NodeFilter.SHOW_TEXT);
  const first = w.nextNode();
  if (!first) return;
  const m = /^(\s*)(\p{Ll})\S*\s*$/u.exec(first.data);
  if (m && !w.nextNode() && lineStartBefore(first, m[1].length)) capitalizeAt(first, m[1].length);
}

/* ───────── documents: search inside PDFs, Word, ePUB… (text is indexed once, on one device) ───────── */

async function indexDocText(it, blob) {
  const kind = indexable(it.data.type, it.data.name);
  if (!kind) return;
  const had = files.mem.has(it.id);
  if (!blob) {
    const local = had || (await files.cachedBlob(it.id).catch(() => null));
    if (!local && (it.data.size > 20 * 1024 * 1024 || (navigator.connection && navigator.connection.saveData) || !navigator.onLine)) return;
    try { blob = local || await files.blobOf(it); } catch { return; }
    if (!had) files.mem.delete(it.id);
  }
  if (!blob) return;
  let text = '';
  let pages = 0;
  try {
    const r = await extractText(blob, kind);
    if (typeof r === 'string') text = r; else { text = r.text || ''; pages = r.pages || 0; }
  } catch (err) { console.warn('index', it.data.name, err); return; }
  const cur = store.items.get(it.id);
  if (!cur || cur.data.trashed) return;
  const CH = 400_000;
  const n = Math.min(200, Math.ceil(text.length / CH));
  for (let k = 0; k < n; k++) {
    const id = `${it.id.slice(0, 50)}_t${k}`;
    const now = Date.now();
    const p = store.items.get(id) || { id, kind: 'part', rev: 0, created: now, updated: now, device: me(), data: {} };
    p.data = { of: it.id, i: k, text: text.slice(k * CH, (k + 1) * CH) };
    await store.save(p);
  }
  cur.data = { ...cur.data, ft: n, fx: INDEX_VERSION, ...(pages ? { pages } : {}) };
  await store.save(cur);
  sync.schedule();
}
/** quietly index documents that were added before 3.0 (or on devices without this version) */
function indexBacklog() {
  if (ui.indexing) return;
  const thumbTodo = store.list('file').filter((it) => !it.data.trashed && !it.data.thumb);
  for (const f of thumbTodo) queueFileThumb(f);
  const todo = store.list('file').filter((it) => !it.data.trashed && !it.data.fx && !files.progress.get(it.id) && indexable(it.data.type, it.data.name) && it.data.size < 60 * 1024 * 1024)
    .sort((a, b) => b.created - a.created);
  const it = todo.find((x) => !(ui.indexTried || (ui.indexTried = new Set())).has(x.id));
  if (!it) return;
  ui.indexTried.add(it.id);
  ui.indexing = true;
  const run = () => indexDocText(it).catch(() => {}).finally(() => { ui.indexing = false; setTimeout(indexBacklog, 1500); });
  (window.requestIdleCallback || ((f) => setTimeout(f, 800)))(run, { timeout: 4000 });
}

/* ───────── status bar colour follows what is on top (light, dark, paper) ───────── */

function syncThemeColor() {
  // the phone's status bar sits right above SyncPad's top bar, so it takes that colour
  // (or the note's paper while presenting full screen)
  const src = el.app.classList.contains('presenting') ? el.editor : $('.topbar');
  const c = solidColor(src) || solidColor(document.body);
  if (c) for (const m of document.querySelectorAll('meta[name="theme-color"]')) if (m.content !== c) m.content = c;
  if (window.SyncPadAndroid?.setTheme) {
    const isDark = document.documentElement.dataset.theme === 'dark';
    const bg = solidColor(document.body) || (isDark ? '#0e1014' : '#fcfcfd');
    window.SyncPadAndroid.setTheme(isDark, c || (isDark ? '#16181e' : '#ffffff'), bg);
  }
}
/** an element's background as plain #rrggbb (status bars don't understand transparency or color-mix) */
function solidColor(node) {
  if (!node) return null;
  const c = getComputedStyle(node).backgroundColor;
  if (!c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)) return null;
  const cv = solidColor.cv || (solidColor.cv = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, 1, 1);
  g.fillStyle = c;
  g.fillRect(0, 0, 1, 1);
  const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
  if (a < 200) return null;
  return '#' + [r, gg, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<div class="toasts" style="bottom:24px"><div class="toast"><span>SyncPad could not start: ${esc(err.message || err)}. Try reloading.</span></div></div>`);
});


/* ───────── YouTube links play privately, inside SyncPad (youtube-nocookie: no watch history, no cookies) ───────── */
function ytInfo(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = '';
  if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else { const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/); if (m) id = m[1]; }
  }
  if (!/^[\w-]{11}$/.test(id)) return null;
  const t = u.searchParams.get('t') || u.searchParams.get('start') || '';
  let start = 0;
  if (/^\d+$/.test(t)) start = +t;
  else { const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/); if (m) start = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); }
  return { id, start, list: u.searchParams.get('list') || '' };
}
let lamePromise = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve(window.lamejs);
  if (lamePromise) return lamePromise;
  lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/lame.min.js';
    s.onload = () => (window.lamejs ? resolve(window.lamejs) : reject(new Error('lamejs unavailable')));
    s.onerror = () => { lamePromise = null; reject(new Error('Could not load MP3 encoder')); };
    document.head.append(s);
  });
  return lamePromise;
}
function triggerBrowserDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  if (filename) a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}
function filenameFromHeader(cd, fallback) {
  if (!cd) return fallback;
  const u8 = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (u8 && u8[1]) { try { return decodeURIComponent(u8[1]).trim(); } catch {} }
  const plain = cd.match(/filename\s*=\s*"([^"]+)"/i);
  if (plain && plain[1]) return plain[1].trim();
  return fallback;
}
async function decodeAndEncodeMp3Blob(buf) {
  const lame = await loadLame();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let audioBuf;
  try { audioBuf = await ac.decodeAudioData(buf.slice(0)); } finally { ac.close().catch(() => {}); }
  const nCh = Math.min(2, audioBuf.numberOfChannels || 1);
  const sr = audioBuf.sampleRate || 44100;
  const enc = new lame.Mp3Encoder(nCh, sr, 128);
  const toI16 = (f32) => {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  const left = toI16(audioBuf.getChannelData(0));
  const right = nCh === 2 ? toI16(audioBuf.getChannelData(1)) : null;
  const chunks = [];
  const step = 1152 * 40;
  for (let i = 0; i < left.length; i += step) {
    const l = left.subarray(i, i + step);
    const mp3buf = nCh === 2 ? enc.encodeBuffer(l, right.subarray(i, i + step)) : enc.encodeBuffer(l);
    if (mp3buf.length) chunks.push(new Uint8Array(mp3buf));
    if (i % (step * 4) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));
  return new Blob(chunks, { type: 'audio/mpeg' });
}
async function downloadYoutube(url, mode = 'mp4', hintTitle = '') {
  const info = ytInfo(url);
  if (!info) return;
  const apiMode = mode === 'mp4' ? 'video' : mode === 'm4a' ? 'm4a' : 'audio';
  const q = new URLSearchParams({ s: store.get('space'), v: info.id, mode: apiMode });
  const cleanHint = String(hintTitle || '').replace(/\s+/g, ' ').trim();
  if (cleanHint && !/^https?:\/\//i.test(cleanHint)) q.set('title', cleanHint.slice(0, 90));

  let progToast = null;
  const setYtToast = (msg) => {
    if (progToast && progToast.isConnected && progToast.firstElementChild) {
      progToast.firstElementChild.textContent = msg;
      return;
    }
    const before = new Set($$('.toast', el.toasts));
    toast(msg, { duration: 180_000 });
    progToast = $$('.toast', el.toasts).find((t) => !before.has(t)) || el.toasts.lastElementChild;
  };
  const clearYtToast = () => {
    if (progToast && progToast.isConnected) progToast.remove();
    progToast = null;
  };
  const saveBlob = (blob, filename, msg) => {
    const blobUrl = URL.createObjectURL(blob);
    triggerBrowserDownload(blobUrl, filename);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
    clearYtToast();
    if (msg) toast(msg);
  };

  setYtToast(mode === 'mp4' ? 'Starting video download…' : mode === 'm4a' ? 'Preparing M4A audio…' : 'Preparing MP3 download…');
  try {
    const r = await fetch(`/api/ytdl?${q}&info=1`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      clearYtToast();
      toast(j.reason || `Could not download this YouTube ${mode === 'mp4' ? 'video' : 'audio'}.`);
      return;
    }

    const baseTitle = j.title || cleanHint || `youtube-${info.id}`;
    const streamUrl = `/api/ytdl?${q}`;

    // 1. Direct MP4 video
    if (mode === 'mp4') {
      clearYtToast();
      toast('Starting video download…');
      triggerBrowserDownload(streamUrl, `${baseTitle}.${j.ext || 'mp4'}`);
      return;
    }

    // 2. Direct M4A fast path (when YouTube allows >1 MB direct audio without PO token)
    if (mode === 'm4a' && j.hasDirectAudio && !j.muxed) {
      clearYtToast();
      toast('Starting M4A download…');
      triggerBrowserDownload(streamUrl, `${baseTitle}.${j.ext || 'm4a'}`);
      return;
    }

    // 3. Long recordings, M4A extraction from muxed MP4, or MP3 via streaming Range + WebCodecs
    const isMp4Container = /mp4/i.test(j.mime || '');
    const needStreaming = j.muxed || mode === 'm4a' || (j.size && j.size > 32 * 1024 * 1024);
    if (needStreaming && isMp4Container) {
      let rangeUrl = streamUrl;
      if (j.muxed) {
        const vq = new URLSearchParams(q);
        vq.set('mode', 'video');
        rangeUrl = `/api/ytdl?${vq}`;
      }
      const { downloadMp4AsAudio } = await import('/js/mp4audio.js');
      const out = await downloadMp4AsAudio({
        streamUrl: rangeUrl,
        totalSize: j.size,
        wantMp3: mode === 'mp3',
        loadLame,
        onProgress: (msg) => setYtToast(msg)
      });
      if (out.ext === 'mp3') {
        saveBlob(out.blob, `${baseTitle}.mp3`, 'MP3 ready — downloading');
      } else if (mode === 'mp3' && out.blob.size <= 36 * 1024 * 1024) {
        setYtToast('Converting audio to MP3…');
        const mp3Blob = await decodeAndEncodeMp3Blob(await out.blob.arrayBuffer());
        saveBlob(mp3Blob, `${baseTitle}.mp3`, 'MP3 ready — downloading');
      } else {
        saveBlob(out.blob, `${baseTitle}.m4a`, mode === 'mp3' ? 'Long recording saved as .m4a' : 'M4A ready — downloading');
      }
      return;
    }

    // 4. Short adaptive audio (<= 32 MB): fetch & convert to MP3
    setYtToast('Downloading & converting to MP3…');
    const res = await fetch(streamUrl);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      clearYtToast();
      toast(err.reason || `Audio download failed (HTTP ${res.status}).`);
      return;
    }
    const rawName = filenameFromHeader(res.headers.get('content-disposition'), `${baseTitle}.m4a`);
    const resolvedTitle = rawName.replace(/\.[^.]+$/, '') || baseTitle;
    const ctype = res.headers.get('content-type') || 'audio/mp4';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 36 * 1024 * 1024) {
      const ext = /webm/i.test(ctype) ? 'webm' : 'm4a';
      saveBlob(new Blob([buf], { type: ctype }), `${resolvedTitle}.${ext}`, `Long audio saved as .${ext}`);
      return;
    }
    try {
      const mp3Blob = await decodeAndEncodeMp3Blob(buf);
      saveBlob(mp3Blob, `${resolvedTitle}.mp3`, 'MP3 ready — downloading');
    } catch {
      const ext = /webm/i.test(ctype) ? 'webm' : 'm4a';
      saveBlob(new Blob([buf], { type: ctype }), `${resolvedTitle}.${ext}`, `Saved audio as .${ext}`);
    }
  } catch (e) {
    clearYtToast();
    toast((e && e.message) || 'YouTube download failed. Check your connection.');
  }
}
/* the player floats above the app: big, or a small corner player that keeps playing while you use SyncPad */
const YT_ORIGIN = 'https://www.youtube-nocookie.com';
const yt = { box: null, url: '', mode: '', state: -1, wanted: false, autoPaused: false, tries: 0, hideAt: 0, showAt: 0, listenT: 0, heard: false };
function ytMode(mode) {
  const box = yt.box;
  if (!box) return;
  const wasBig = yt.mode === 'big';
  yt.mode = mode;
  box.className = 'yt-float ' + mode;
  box.hidden = mode === '';
  if (mode === 'big' && !wasBig) pushLayer({ key: box, close: () => ytMode('mini') });
  if (mode !== 'big' && wasBig) { ui.fromPop || closeLayer(box); }
  if (mode === '') { clearInterval(yt.listenT); box.querySelector('.yt-frame').innerHTML = ''; yt.wanted = false; yt.autoPaused = false; yt.state = -1; }
}
/* talk to YouTube's own player (its official iframe messages), so it can be told to play on */
const ytFrame = () => (yt.box && yt.box.querySelector('.yt-frame iframe')) || null;
function ytSend(func, args = []) {
  const f = ytFrame();
  if (f && f.contentWindow) f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), YT_ORIGIN);
}
function ytListen() {
  clearInterval(yt.listenT);
  yt.heard = false;
  let n = 0;
  yt.listenT = setInterval(() => {
    const f = ytFrame();
    if (!f || yt.heard || ++n > 60) { clearInterval(yt.listenT); return; }
    try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN); } catch {}
  }, 250);
}
addEventListener('message', (e) => {
  const f = ytFrame();
  if (!f || e.source !== f.contentWindow || e.origin !== YT_ORIGIN) return;
  let d;
  try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  if (!d || !d.event) return;
  if (!yt.heard) { yt.heard = true; clearInterval(yt.listenT); ytSend('addEventListener', ['onStateChange']); }
  let st = null;
  if (d.event === 'onStateChange' && typeof d.info === 'number') st = d.info;
  else if (d.event === 'infoDelivery' && d.info && typeof d.info.playerState === 'number') st = d.info.playerState;
  if (st !== null && st !== yt.state) ytState(st);
});
function ytState(st) {
  yt.state = st;
  if (st === 1 || st === 3) { yt.wanted = true; if (st === 1) yt.autoPaused = false; return; } // playing / loading
  if (st === 0) { yt.wanted = false; yt.autoPaused = false; return; } // finished
  if (st !== 2) return;
  // paused. Right after the app went to the background, that was YouTube, not you: play on.
  const fresh = document.hidden && (Date.now() - yt.hideAt < 4000 || yt.hideAt <= yt.showAt);
  if (fresh && yt.wanted) {
    yt.autoPaused = true;
    if (yt.tries < 5) { yt.tries++; setTimeout(() => { if (yt.autoPaused) ytSend('playVideo'); }, 120 * yt.tries); }
  } else { yt.wanted = false; yt.autoPaused = false; } // you paused it
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { yt.hideAt = Date.now(); yt.tries = 0; return; }
  yt.showAt = Date.now();
  // back in SyncPad: if YouTube stopped it while you were away, carry on where it was
  if (yt.mode && yt.autoPaused && yt.wanted) { yt.autoPaused = false; ytSend('playVideo'); }
});
/* phones: full screen, then swipe up and the video keeps playing in a small floating window */
async function ytPopOut() {
  const f = ytFrame();
  if (!f) return;
  try {
    await f.requestFullscreen({ navigationUI: 'hide' });
    try { await screen.orientation.lock('landscape'); } catch {}
    toast('Now swipe up — the video keeps playing in a small window over your other apps.', { duration: 6000 });
  } catch { toast('Your phone did not allow full screen here. Use YouTube’s ⛶ button in the video.'); }
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) { try { screen.orientation.unlock(); } catch {} } });
function openUrl(url) {
  const info = ytInfo(url);
  if (!info) { window.open(url, '_blank', 'noopener'); return; }
  if (!yt.box) {
    const box = document.createElement('div');
    box.innerHTML = `<div class="yt-shade"></div><div class="yt-card"><div class="yt-bar"><span class="yt-note"><svg class="ic"><use href="#i-lock"/></svg><span>Private — not saved to your YouTube history</span></span><span class="spacer"></span><button class="btn btn-sm" id="yt-dl-mp3" title="Download MP3"><svg class="ic"><use href="#i-download"/></svg><span>MP3</span></button><button class="btn btn-sm" id="yt-dl-m4a" title="Download M4A Audio"><svg class="ic"><use href="#i-download"/></svg><span>M4A</span></button><button class="btn btn-sm" id="yt-dl-mp4" title="Download Video (MP4)"><svg class="ic"><use href="#i-download"/></svg><span>Video</span></button><button class="btn btn-sm" id="yt-pop" title="Full screen — then swipe up and it keeps playing over your other apps"><svg class="ic"><use href="#i-fit"/></svg><span>Pop out</span></button><a class="btn btn-sm" id="yt-open" target="_blank" rel="noopener noreferrer">Open in YouTube</a><button class="icon-btn" id="yt-min" aria-label="Keep playing in the corner" title="Keep playing in the corner"><svg class="ic"><use href="#i-chev"/></svg></button><button class="icon-btn" id="yt-max" aria-label="Bigger" title="Bigger"><svg class="ic"><use href="#i-fit"/></svg></button><button class="icon-btn" id="yt-close" aria-label="Stop and close" title="Stop and close"><svg class="ic"><use href="#i-x"/></svg></button></div><div class="yt-frame"></div></div>`;
    document.body.append(box);
    yt.box = box;
    box.addEventListener('click', (e) => {
      if (e.target.closest('.yt-shade, #yt-min')) ytMode('mini');
      else if (e.target.closest('#yt-max')) ytMode('big');
      else if (e.target.closest('#yt-pop')) ytPopOut();
      else if (e.target.closest('#yt-dl-mp3')) { if (yt.url) downloadYoutube(yt.url, 'mp3'); }
      else if (e.target.closest('#yt-dl-m4a')) { if (yt.url) downloadYoutube(yt.url, 'm4a'); }
      else if (e.target.closest('#yt-dl-mp4')) { if (yt.url) downloadYoutube(yt.url, 'mp4'); }
      else if (e.target.closest('#yt-close')) ytMode('');
      else if (e.target.closest('#yt-open')) ytMode('');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && yt.mode === 'big' && !document.fullscreenElement) { e.stopPropagation(); ytMode('mini'); } }, true);
  }
  yt.url = url;
  const q = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', modestbranding: '1', enablejsapi: '1', origin: location.origin });
  if (info.start) q.set('start', String(info.start));
  if (info.list) q.set('list', info.list);
  yt.state = -1; yt.wanted = true; yt.autoPaused = false; yt.tries = 0;
  yt.box.querySelector('.yt-frame').innerHTML = `<iframe src="${YT_ORIGIN}/embed/${info.id}?${q}" title="YouTube video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  ytFrame().addEventListener('load', ytListen);
  yt.box.querySelector('#yt-open').href = url;
  ytMode('big');
}
document.addEventListener('click', (e) => {
  const ytDl = e.target.closest && e.target.closest('[data-yt-dl]');
  if (ytDl) {
    const card = ytDl.closest('a.link-card');
    const href = ytDl.dataset.ytUrl || (card && card.href) || '';
    if (href && ytInfo(href)) {
      e.preventDefault();
      e.stopPropagation();
      const title = card ? (card.querySelector('.lc-t') && card.querySelector('.lc-t').textContent) || '' : '';
      if (ui.linkBubble && !ui.linkBubble.hidden) hideLinkBubble();
      downloadYoutube(href, ytDl.dataset.ytDl, title);
      return;
    }
  }
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0 || a.closest('.yt-float')) return;
  if (!ytInfo(a.href)) return;
  e.preventDefault();
  e.stopPropagation();
  openUrl(a.href);
}, true);


/* ───────── in-app Select all / Cut / Copy / Paste for notes (quicker than the phone's own pop-up) ───────── */
function editorSelection() {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return el.editorText.contains(r.commonAncestorContainer) ? { sel, r } : null;
}
async function writeClip(html, text) {
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
      return true;
    }
  } catch {}
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try { return document.execCommand('copy'); } catch { return false; }
}
async function clipAction(kind) {
  const ed = el.editorText;
  if (!ed) return;
  if (kind === 'sel') { setSelectMode(!ui.selMode); return; }
  if (kind === 'all') {
    ed.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(ed);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }
  if (kind === 'copy' || kind === 'cut') {
    let cur = editorSelection();
    const whole = !cur || cur.r.collapsed;
    if (whole && kind === 'cut') { toast('Select some text first (or tap All).'); return; }
    let html, text;
    if (whole) { html = ed.innerHTML; text = ed.innerText; }
    else { const box = document.createElement('div'); box.append(cur.r.cloneContents()); html = box.innerHTML; text = cur.sel.toString(); }
    const ok = await writeClip(html, text);
    if (!ok) { toast('Your browser blocked copying. Use the phone’s Copy instead.'); return; }
    if (kind === 'cut') {
      cur = editorSelection();
      if (cur && !cur.r.collapsed) { ed.focus({ preventScroll: true }); document.execCommand('delete'); }
      toast('Cut', { duration: 1000 });
    } else toast(whole ? 'Copied the whole note' : 'Copied', { duration: 1000 });
    return;
  }
  if (kind === 'paste') {
    let html = '';
    let text = '';
    try {
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
      } else text = await navigator.clipboard.readText();
    } catch {
      try { text = await navigator.clipboard.readText(); } catch { toast('Allow SyncPad to see the clipboard to paste here (or use the phone’s Paste).'); return; }
    }
    if (!html && !text) { toast('The clipboard is empty.'); return; }
    if (!editorSelection()) {
      // no cursor in the note yet: paste at the end
      ed.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    pasteIntoEditor({ preventDefault() {}, clipboardData: { getData: (t) => (t === 'text/html' ? html : t === 'text/plain' ? text : ''), files: [], items: [] } });
  }
}


/* ───────── finger select: drag over text to select it at once (no long-press, no wobbly handles);
             it snaps to whole words, scrolls by itself at the edges, two fingers scroll the note ───────── */
function setSelectMode(on) {
  ui.selMode = !!on;
  const b = el.fmtBar && el.fmtBar.querySelector('[data-clip="sel"]');
  if (b) b.setAttribute('aria-pressed', String(ui.selMode));
  el.editorText.classList.toggle('sel-mode', ui.selMode);
  if (ui.selMode) { el.editorText.setAttribute('inputmode', 'none'); document.activeElement && document.activeElement.blur && document.activeElement.blur(); toast('Drag your finger over the text to select it. Two fingers scroll. Tap Select again to go back to typing.', { duration: 3500 }); }
  else { el.editorText.removeAttribute('inputmode'); ui.kb && ui.kb.refreshTargets(); }
}
function caretAt(x, y) {
  if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y); if (c && el.editorText.contains(c.offsetNode)) return { node: c.offsetNode, off: c.offset }; }
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (r && el.editorText.contains(r.startContainer)) return { node: r.startContainer, off: r.startOffset }; }
  return null;
}
function snapWord(c, toEnd) {
  if (!c || c.node.nodeType !== 3) return c;
  const t = c.node.data;
  let i = c.off;
  const w = /[\p{L}\p{N}_'’-]/u;
  if (toEnd) { while (i < t.length && w.test(t[i])) i++; }
  else { while (i > 0 && w.test(t[i - 1])) i--; }
  return { node: c.node, off: i };
}
function cmpPos(a, b) {
  if (a.node === b.node) return a.off - b.off;
  return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}
function fingerSelect() {
  const ed = el.editorText;
  if (!ed) return;
  let g = null;
  let raf = 0;
  const apply = () => {
    if (!g || !g.cur) return;
    const fwd = cmpPos(g.anchor, g.cur) <= 0;
    const a = snapWord(g.anchor, !fwd);
    const f = snapWord(g.cur, fwd);
    try { getSelection().setBaseAndExtent(a.node, a.off, f.node, f.off); } catch {}
  };
  const edgeScroll = () => {
    raf = 0;
    if (!g || g.two) return;
    const r = ed.getBoundingClientRect();
    const zone = 56;
    let v = 0;
    if (g.y < r.top + zone) v = -Math.ceil((r.top + zone - g.y) / 4);
    else if (g.y > r.bottom - zone) v = Math.ceil((g.y - (r.bottom - zone)) / 4);
    if (v) { ed.scrollTop += v; const c = caretAt(g.x, Math.max(r.top + 2, Math.min(r.bottom - 2, g.y))); if (c) { g.cur = c; apply(); } raf = requestAnimationFrame(edgeScroll); }
  };
  ed.addEventListener('touchstart', (e) => {
    if (!ui.selMode) return;
    if (e.touches.length >= 2) { g = { two: true, y0: (e.touches[0].clientY + e.touches[1].clientY) / 2, st: ed.scrollTop }; e.preventDefault(); return; }
    const t = e.touches[0];
    const c = caretAt(t.clientX, t.clientY);
    if (!c) return;
    e.preventDefault();
    g = { anchor: c, cur: c, x: t.clientX, y: t.clientY, moved: false };
    try { getSelection().collapse(c.node, c.off); } catch {}
  }, { passive: false });
  ed.addEventListener('touchmove', (e) => {
    if (!ui.selMode || !g) return;
    e.preventDefault();
    if (g.two) {
      if (e.touches.length < 2) return;
      ed.scrollTop = g.st - ((e.touches[0].clientY + e.touches[1].clientY) / 2 - g.y0);
      return;
    }
    const t = e.touches[0];
    g.x = t.clientX; g.y = t.clientY; g.moved = true;
    const c = caretAt(t.clientX, t.clientY);
    if (c) { g.cur = c; apply(); }
    if (!raf) raf = requestAnimationFrame(edgeScroll);
  }, { passive: false });
  const end = () => {
    if (!g) return;
    const was = g;
    g = null;
    cancelAnimationFrame(raf); raf = 0;
    if (was.two || was.moved) return;
    // a tap selects the word under the finger
    const a = snapWord(was.anchor, false);
    const f = snapWord(was.anchor, true);
    try { getSelection().setBaseAndExtent(a.node, a.off, f.node, f.off); } catch {}
  };
  ed.addEventListener('touchend', end, { passive: true });
  ed.addEventListener('touchcancel', end, { passive: true });
}


/* ───────── number password: sign in on any computer with the SyncPad address + a password ───────── */
function setupPinLogin() {
  const f = $('#pin-login-form'), inp = $('#pin-login'), msg = $('#pin-login-msg');
  const say = (m, t, cls) => { m.textContent = t; m.className = 'form-msg' + (cls ? ' ' + cls : ''); };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = inp.value.replace(/\D/g, '');
    if (pin.length < 8) { say(msg, 'Your password has at least 8 digits.', 'err'); return; }
    say(msg, 'Signing in…');
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) throw new Error(`Too many wrong tries. Wait ${Math.max(1, Math.ceil((j.retry || 900000) / 60000))} minutes and try again.`);
      if (!j.space) throw new Error('That password is not right.');
      inp.value = '';
      if (j.space === store.get('space')) { say(msg, 'This device is already signed in to your space.', 'ok'); return; }
      el.dlgConnect.close();
      await new Promise((res) => setTimeout(res, 80));
      await offerJoin({ space: j.space, token: j.token || j.space });
    } catch (err) {
      say(msg, navigator.onLine ? err.message : 'You are offline. Connect to the internet first.', 'err');
    }
  });
  // setting it (from a device that is already in your space)
  const sf = $('#pin-set-form'), np = $('#pin-new'), sm = $('#pin-set-msg'), st = $('#pin-status'), rm = $('#pin-remove');
  const base = () => `/api/s/${store.get('space')}/login`;
  const refresh = async () => {
    if (!store.get('space')) { st.textContent = ''; return; }
    try {
      const j = await fetch(base(), { headers: sync.headers() }).then((r) => r.json());
      st.textContent = j.set ? '· On' : '· Not set yet';
      st.className = j.set ? 'ok-text' : 'muted';
      rm.hidden = !j.set;
      $('#pin-save').textContent = j.set ? 'Change' : 'Save';
    } catch { st.textContent = navigator.onLine ? '' : '· offline'; }
  };
  ui.pinRefresh = () => { refresh(); say(msg, ''); say(sm, ''); };
  sf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = np.value.replace(/\D/g, '');
    if (pin !== np.value.trim()) { say(sm, 'Numbers only, please.', 'err'); return; }
    if (pin.length < 8) { say(sm, 'Use at least 8 digits, so nobody can guess it.', 'err'); return; }
    if (/^(\d)\1+$/.test(pin) || '0123456789012345678901234567890'.includes(pin) || '9876543210987654321098765432109'.includes(pin)) { say(sm, 'Too easy to guess (like 11111111 or 12345678). Pick another.', 'err'); return; }
    say(sm, 'Saving…');
    try {
      const r = await fetch(base(), { method: 'POST', headers: sync.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ pin }) });
      const j = await r.json().catch(() => ({}));
      if (j.error === 'taken') throw new Error('Pick a different password.');
      if (j.error === 'main') throw new Error('Only a main device can change the password.');
      if (!r.ok || !j.ok) throw new Error('Could not save it. Try again.');
      np.value = '';
      say(sm, 'Saved. Write it down somewhere safe — it opens all your notes and files.', 'ok');
      refresh();
    } catch (err) { say(sm, navigator.onLine ? err.message : 'You are offline. Connect to the internet first.', 'err'); }
  });
  rm.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove the password?', 'You will only be able to add a computer with a 6-digit code from a device that is already connected.', 'Remove'))) return;
    const r = await fetch(base(), { method: 'DELETE', headers: sync.headers() }).catch(() => null);
    if (r && r.status === 403) { say(sm, 'Only a main device can remove the password.', 'err'); return; }
    say(sm, 'Password removed.', 'ok');
    refresh();
  });
}
