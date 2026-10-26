/**
 * SyncPad Main Application Controller
 * Orchestrates IndexedDB, live synchronization, markdown editing, view modes, and keyboard shortcuts.
 */

import {
  initDB,
  getAllNotes,
  getNote,
  saveNote,
  deleteNote,
  searchNotes,
  getSetting,
  setSetting
} from './db.js';

import { syncManager, SyncStatus } from './sync.js';
import {
  renderNotesList,
  renderTagChips,
  updateWordStats,
  renderPreview,
  insertMarkdownSyntax,
  showToast
} from './ui.js';
import { extractFirstTitle } from './markdown.js';
import {
  compressImage,
  formatBytes,
  insertImageMarkdown,
  insertImagePlaceholder,
  copyImageDataUrlToClipboard,
  renderAttachedImagesStrip,
  extractAndMigrateNoteImages,
  LightboxViewer
} from './images.js';
import { generateQRCodeSVG } from './qr.js';

class SyncPadApp {
  constructor() {
    this.activeNote = null;
    this.allNotes = [];
    this.searchQuery = '';
    this.activeTag = null;
    this.viewMode = 'split'; // 'split' | 'edit' | 'preview'
    this.saveDebounceTimer = null;
    this.theme = 'dark';
    this.stagedImageData = null;

    // DOM Elements
    this.dom = {
      sidebar: document.getElementById('sidebar'),
      sidebarToggleBtn: document.getElementById('btn-toggle-sidebar'),
      sidebarOverlay: document.getElementById('sidebar-overlay'),
      newNoteBtn: document.getElementById('btn-new-note'),
      searchInput: document.getElementById('search-input'),
      searchClearBtn: document.getElementById('btn-clear-search'),
      tagChipsContainer: document.getElementById('tag-chips'),
      notesListContainer: document.getElementById('notes-list'),
      
      // Editor
      noteTitleInput: document.getElementById('note-title'),
      noteContentTextarea: document.getElementById('note-content'),
      markdownPreview: document.getElementById('markdown-preview'),
      editorPane: document.getElementById('editor-pane'),
      previewPane: document.getElementById('preview-pane'),
      editorContainer: document.getElementById('editor-container'),
      editorDropZone: document.getElementById('editor-drop-zone'),
      
      // Editor Actions
      pinNoteBtn: document.getElementById('btn-pin-note'),
      deleteCurrentNoteBtn: document.getElementById('btn-delete-current-note'),
      exportMdBtn: document.getElementById('btn-export-md'),
      copyMdBtn: document.getElementById('btn-copy-md'),
      
      // Tags
      tagsContainer: document.getElementById('note-tags-container'),
      newTagInput: document.getElementById('input-new-tag'),
      
      // View mode toggles
      viewModeEditBtn: document.getElementById('mode-edit'),
      viewModeSplitBtn: document.getElementById('mode-split'),
      viewModePreviewBtn: document.getElementById('mode-preview'),
      
      // Room & Sync
      roomBadgeBtn: document.getElementById('btn-room-badge'),
      roomStatusPill: document.getElementById('room-status-pill'),
      roomStatusText: document.getElementById('room-status-text'),
      roomCodeDisplay: document.getElementById('room-code-display'),
      roomModal: document.getElementById('room-modal'),
      closeRoomModalBtn: document.getElementById('btn-close-room-modal'),
      modalRoomCode: document.getElementById('modal-room-code'),
      copyRoomCodeBtn: document.getElementById('btn-copy-room-code'),
      copyRoomLinkBtn: document.getElementById('btn-copy-room-link'),
      joinRoomInput: document.getElementById('input-join-room'),
      joinRoomBtn: document.getElementById('btn-join-room'),
      createNewRoomBtn: document.getElementById('btn-create-new-room'),
      peerPresenceBadge: document.getElementById('peer-presence-badge'),

      // Image Attachment & Lightbox
      insertImageBtn: document.getElementById('btn-insert-image'),
      imageModal: document.getElementById('image-modal'),
      closeImageModalBtn: document.getElementById('btn-close-image-modal'),
      tabImageUpload: document.getElementById('tab-btn-image-upload'),
      tabImageUrl: document.getElementById('tab-btn-image-url'),
      paneImageUpload: document.getElementById('tab-pane-image-upload'),
      paneImageUrl: document.getElementById('tab-pane-image-url'),
      imageDropArea: document.getElementById('image-drop-area'),
      inputImageFile: document.getElementById('input-image-file'),
      imagePreviewWrapper: document.getElementById('image-preview-wrapper'),
      imagePreviewThumb: document.getElementById('image-preview-thumb'),
      imagePreviewName: document.getElementById('image-preview-name'),
      imagePreviewSize: document.getElementById('image-preview-size'),
      clearImageFileBtn: document.getElementById('btn-clear-image-file'),
      inputImageCaption: document.getElementById('input-image-caption'),
      confirmInsertFileBtn: document.getElementById('btn-confirm-insert-file'),
      inputImageWebUrl: document.getElementById('input-image-web-url'),
      inputImageWebCaption: document.getElementById('input-image-web-caption'),
      webImagePreviewContainer: document.getElementById('web-image-preview-container'),
      webImagePreviewImg: document.getElementById('web-image-preview-img'),
      confirmInsertUrlBtn: document.getElementById('btn-confirm-insert-url'),
      btnFetchWebUrl: document.getElementById('btn-fetch-web-url'),
      webUrlStatus: document.getElementById('web-url-status'),
      webLinkMetaCard: document.getElementById('web-link-meta-card'),
      webMetaSite: document.getElementById('web-meta-site'),
      webMetaTitle: document.getElementById('web-meta-title'),
      webMetaDesc: document.getElementById('web-meta-desc'),
      btnSaveWebImage: document.getElementById('btn-save-web-image'),
      btnInsertWebBookmark: document.getElementById('btn-insert-web-bookmark'),
      
      // Theme
      themeToggleBtn: document.getElementById('btn-toggle-theme'),

      // 1-Tap Ribbon & Mobile Dock Elements
      btnQuickPaste: document.getElementById('btn-quick-paste'),
      btnQuickPhoto: document.getElementById('btn-quick-photo'),
      inputQuickPhoto: document.getElementById('input-quick-photo'),
      copyMdLabel: document.getElementById('btn-copy-md-label'),
      btnToggleTools: document.getElementById('btn-toggle-tools'),
      markdownToolbar: document.getElementById('markdown-toolbar'),
      detectedLinksBar: document.getElementById('detected-links-bar'),
      attachedImagesStrip: document.getElementById('attached-images-strip'),
      modalQrCode: document.getElementById('modal-qr-code'),

      // Mobile Bottom Dock
      mobileDock: document.getElementById('mobile-bottom-dock'),
      mBtnNewNote: document.getElementById('m-btn-new-note'),
      mBtnQuickPaste: document.getElementById('m-btn-quick-paste'),
      mBtnQuickPhoto: document.getElementById('m-btn-quick-photo'),
      mBtnQuickCopy: document.getElementById('m-btn-quick-copy'),
      mBtnRoom: document.getElementById('m-btn-room')
    };

    this.lightbox = new LightboxViewer();
    window.__syncpadApp = this;
  }

  async init() {
    // 1. Unconditionally bind DOM events, keyboard shortcuts, and toolbar first
    // so all buttons and UI interactions are responsive immediately
    this.bindEvents();
    this.bindKeyboardShortcuts();
    this.bindMarkdownToolbar();

    // Initialize formatting toolbar visibility
    try {
      const savedToolbar = localStorage.getItem('syncpad_show_toolbar');
      if (savedToolbar === 'false' && this.dom.markdownToolbar) {
        this.dom.markdownToolbar.classList.add('hidden');
        if (this.dom.btnToggleTools) this.dom.btnToggleTools.classList.remove('active');
      } else if (this.dom.btnToggleTools) {
        this.dom.btnToggleTools.classList.add('active');
      }
    } catch (_) {}

    // 2. Safely initialize theme & view mode
    try {
      await this.initTheme();
    } catch (err) {
      console.warn('initTheme error:', err);
    }

    try {
      await this.initViewMode();
    } catch (err) {
      console.warn('initViewMode error:', err);
    }

    // 3. Safely initialize IndexedDB
    try {
      await initDB();
    } catch (err) {
      console.error('initDB error:', err);
      showToast('IndexedDB storage initialization warning', 'warning');
    }

    // 4. Initialize room sync
    let roomCode = null;
    try {
      roomCode = await syncManager.init();
      this.updateRoomUI(roomCode, syncManager.status, syncManager.peerCount);
    } catch (err) {
      console.error('syncManager.init error:', err);
    }

    // Setup sync manager event handlers
    syncManager.on('statusChange', ({ status, roomCode: rCode, peerCount }) => {
      this.updateRoomUI(rCode || this.roomCode, status, peerCount);
    });

    syncManager.on('presence', ({ count }) => {
      this.updateRoomUI(this.roomCode, syncManager.status, count);
    });

    syncManager.on('remoteNoteChange', async ({ note, action }) => {
      try {
        await this.refreshNotesList();
        // If the currently open note was modified remotely, update editor
        if (this.activeNote && this.activeNote.id === note.id) {
          if (action === 'delete') {
            showToast('The current note was deleted from another device', 'warning');
            await this.selectFirstAvailableNote();
          } else {
            this.activeNote = note;
            this.populateEditor(note, false);
            showToast('Note synced from connected device', 'info', 2000);
          }
        }
      } catch (err) {
        console.error('remoteNoteChange handler error:', err);
      }
    });

    syncManager.on('roomSynced', async () => {
      try {
        await this.refreshNotesList();
        if (!this.activeNote) {
          await this.selectFirstAvailableNote();
        }
        showToast('All notes synchronized with room', 'success', 2200);
      } catch (err) {
        console.error('roomSynced handler error:', err);
      }
    });

    // 5. Load notes
    try {
      await this.refreshNotesList();

      if (this.allNotes.length === 0) {
        if (!syncManager.isJoinedFromUrl) {
          await this.createWelcomeNote(false);
        } else {
          await this.createNewNote();
        }
      } else {
        const lastNoteId = await getSetting('activeNoteId');
        const found = this.allNotes.find((n) => n.id === lastNoteId);
        await this.selectNote(found ? found.id : this.allNotes[0].id);
      }
    } catch (err) {
      console.error('Notes loading error in init:', err);
    }
  }

  async initTheme() {
    const savedTheme = await getSetting('theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.theme = savedTheme || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', this.theme);
  }

  async toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this.theme);
    await setSetting('theme', this.theme);
  }

  async initViewMode() {
    const savedMode = await getSetting('viewMode');
    if (savedMode && ['split', 'edit', 'preview'].includes(savedMode)) {
      this.setViewMode(savedMode);
    } else {
      // On mobile screens, default to 'edit' or 'split' based on screen width
      this.setViewMode(window.innerWidth < 768 ? 'edit' : 'split');
    }
  }

  setViewMode(mode) {
    this.viewMode = mode;
    setSetting('viewMode', mode);

    if (this.dom.editorContainer) {
      this.dom.editorContainer.setAttribute('data-mode', mode);
    }

    // Update active button state
    [this.dom.viewModeEditBtn, this.dom.viewModeSplitBtn, this.dom.viewModePreviewBtn].forEach((btn) => {
      if (btn) {
        const btnMode = btn.getAttribute('data-mode');
        btn.classList.toggle('active', btnMode === mode);
      }
    });

    if (mode === 'preview' && this.activeNote) {
      renderPreview(this.dom.noteContentTextarea.value, this.dom.markdownPreview, this.activeNote.images || []);
    }
  }

  updateRoomUI(roomCode, status, peerCount) {
    this.roomCode = roomCode;
    if (this.dom.roomCodeDisplay) {
      this.dom.roomCodeDisplay.textContent = roomCode || 'DISCONNECTED';
    }
    if (this.dom.modalRoomCode) {
      this.dom.modalRoomCode.textContent = roomCode || '---';
    }

    // Status pill
    if (this.dom.roomStatusPill && this.dom.roomStatusText) {
      this.dom.roomStatusPill.className = `status-pill status-${status}`;
      let text = 'Offline';
      if (status === SyncStatus.CONNECTED) text = 'Live';
      else if (status === SyncStatus.CONNECTING) text = 'Connecting';
      else if (status === SyncStatus.SYNCING) text = 'Syncing';
      this.dom.roomStatusText.textContent = text;
    }

    // Peer presence
    if (this.dom.peerPresenceBadge) {
      const count = Math.max(1, peerCount || 1);
      this.dom.peerPresenceBadge.textContent = `${count} ${count === 1 ? 'device' : 'devices'} active`;
    }

    // Refresh QR code if room modal is open
    if (this.dom.roomModal && this.dom.roomModal.classList.contains('open')) {
      this.renderQRCode();
    }
  }

  async refreshNotesList() {
    this.allNotes = await searchNotes(this.searchQuery, this.activeTag);

    // Collect all available tags across all non-deleted notes
    const all = await getAllNotes();
    const tagSet = new Set();
    all.forEach((n) => (n.tags || []).forEach((t) => tagSet.add(t)));
    const sortedTags = Array.from(tagSet).sort();

    renderTagChips({
      tags: sortedTags,
      activeTag: this.activeTag,
      onSelectTag: (tag) => {
        this.activeTag = tag;
        this.refreshNotesList();
      }
    });

    renderNotesList({
      notes: this.allNotes,
      activeNoteId: this.activeNote ? this.activeNote.id : null,
      onSelectNote: (id) => this.selectNote(id),
      onTogglePin: (id) => this.togglePinNote(id),
      onDeleteNote: (id) => this.confirmDeleteNote(id)
    });
  }

  async selectNote(id) {
    const note = await getNote(id);
    if (!note || note.isDeleted) {
      await this.selectFirstAvailableNote();
      return;
    }

    this.activeNote = note;
    await setSetting('activeNoteId', note.id);
    this.populateEditor(note, true);
    await this.refreshNotesList();

    // Close mobile sidebar if open
    this.closeMobileSidebar();
  }

  async selectFirstAvailableNote() {
    const notes = await getAllNotes();
    if (notes.length > 0) {
      await this.selectNote(notes[0].id);
    } else {
      await this.createNewNote();
    }
  }

  populateEditor(note, resetSelection = false) {
    if (!this.dom.noteTitleInput || !this.dom.noteContentTextarea) return;

    // Auto-migrate any raw base64 data URLs from existing notes to clean attachment objects
    const migrated = extractAndMigrateNoteImages(note);
    if (migrated) {
      saveNote(note, true).catch(console.warn);
    }

    const isContentFocused = document.activeElement === this.dom.noteContentTextarea;
    const isTitleFocused = document.activeElement === this.dom.noteTitleInput;
    const selStart = this.dom.noteContentTextarea.selectionStart;
    const selEnd = this.dom.noteContentTextarea.selectionEnd;
    const titleStart = this.dom.noteTitleInput.selectionStart;
    const titleEnd = this.dom.noteTitleInput.selectionEnd;

    this.dom.noteTitleInput.value = note.title || '';
    this.dom.noteContentTextarea.value = note.content || '';

    if (isContentFocused && !resetSelection) {
      const len = (note.content || '').length;
      this.dom.noteContentTextarea.setSelectionRange(
        Math.min(selStart, len),
        Math.min(selEnd, len)
      );
    }

    if (isTitleFocused && !resetSelection) {
      const len = (note.title || '').length;
      this.dom.noteTitleInput.setSelectionRange(
        Math.min(titleStart, len),
        Math.min(titleEnd, len)
      );
    }

    // Update tags
    this.renderNoteTagsEditor(note.tags || []);

    // Update pin button
    if (this.dom.pinNoteBtn) {
      this.dom.pinNoteBtn.classList.toggle('active', Boolean(note.pinned));
      this.dom.pinNoteBtn.title = note.pinned ? 'Unpin note' : 'Pin note';
    }

    // Update stats
    updateWordStats(note.content || '');

    // Update preview with images
    renderPreview(note.content || '', this.dom.markdownPreview, note.images || []);

    // Update detected links bar for 1-tap open / copy
    this.updateDetectedLinks(note.content || '');

    // Update visual attached images strip (thumbnails & 1-tap copy!)
    this.updateAttachedImagesUI();

    if (resetSelection) {
      this.dom.noteContentTextarea.scrollTop = 0;
      this.dom.markdownPreview.scrollTop = 0;
    }
  }

  renderNoteTagsEditor(tags) {
    if (!this.dom.tagsContainer) return;
    this.dom.tagsContainer.innerHTML = '';

    tags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'note-tag-pill';
      chip.innerHTML = `
        <span>#${tag}</span>
        <button type="button" class="remove-tag-btn" data-tag="${tag}" aria-label="Remove tag">&times;</button>
      `;
      chip.querySelector('.remove-tag-btn').addEventListener('click', () => {
        this.removeTagFromActiveNote(tag);
      });
      this.dom.tagsContainer.appendChild(chip);
    });
  }

  async addTagToActiveNote(tagText) {
    if (!this.activeNote || !tagText) return;
    const cleanTag = tagText.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanTag) return;

    const currentTags = this.activeNote.tags || [];
    if (!currentTags.includes(cleanTag)) {
      this.activeNote.tags = [...currentTags, cleanTag];
      await this.saveActiveNote(true);
      this.renderNoteTagsEditor(this.activeNote.tags);
      await this.refreshNotesList();
    }
  }

  async removeTagFromActiveNote(tagText) {
    if (!this.activeNote) return;
    this.activeNote.tags = (this.activeNote.tags || []).filter((t) => t !== tagText);
    await this.saveActiveNote(true);
    this.renderNoteTagsEditor(this.activeNote.tags);
    await this.refreshNotesList();
  }

  async createNewNote() {
    const newNote = {
      title: 'Untitled Note',
      content: '',
      tags: this.activeTag ? [this.activeTag] : [],
      pinned: false
    };

    const saved = await saveNote(newNote, true);
    syncManager.broadcastNoteUpdate(saved);
    await this.selectNote(saved.id);
    showToast('New note created', 'info', 1800);

    // Focus title
    setTimeout(() => {
      if (this.dom.noteTitleInput) {
        this.dom.noteTitleInput.focus();
        this.dom.noteTitleInput.select();
      }
    }, 50);
  }

  async togglePinNote(id) {
    const note = await getNote(id);
    if (!note) return;
    note.pinned = !note.pinned;
    const saved = await saveNote(note, true);
    syncManager.broadcastNoteUpdate(saved);

    if (this.activeNote && this.activeNote.id === id) {
      this.activeNote.pinned = note.pinned;
      if (this.dom.pinNoteBtn) {
        this.dom.pinNoteBtn.classList.toggle('active', note.pinned);
      }
    }

    await this.refreshNotesList();
    showToast(note.pinned ? 'Note pinned to top' : 'Note unpinned', 'info', 1800);
  }

  async confirmDeleteNote(id) {
    const note = await getNote(id);
    if (!note) return;

    const confirmed = window.confirm(`Delete "${note.title || 'Untitled Note'}"? This will sync across all devices in this room.`);
    if (!confirmed) return;

    const tombstone = await deleteNote(id, true);
    syncManager.broadcastNoteDelete(id, tombstone.updatedAt, tombstone.version);
    showToast('Note deleted', 'info', 2000);

    await this.refreshNotesList();

    if (this.activeNote && this.activeNote.id === id) {
      await this.selectFirstAvailableNote();
    }
  }

  async handleEditorInput() {
    const titleValue = this.dom.noteTitleInput ? this.dom.noteTitleInput.value : '';
    const contentValue = this.dom.noteContentTextarea ? this.dom.noteContentTextarea.value : '';

    // Live update preview & stats immediately
    if (this.dom.markdownPreview) {
      renderPreview(contentValue, this.dom.markdownPreview, this.activeNote ? this.activeNote.images : []);
    }
    updateWordStats(contentValue);

    // Live update detected links bar for 1-tap open / copy
    this.updateDetectedLinks(contentValue);

    // Live update attached images strip
    this.updateAttachedImagesUI();

    if (!this.activeNote) {
      // Auto-create note on typing when no note was selected
      const newNote = {
        title: titleValue.trim() || extractFirstTitle(contentValue, 'Untitled Note'),
        content: contentValue,
        tags: this.activeTag ? [this.activeTag] : [],
        pinned: false
      };
      const saved = await saveNote(newNote, true);
      this.activeNote = saved;
      await setSetting('activeNoteId', saved.id);
      syncManager.broadcastNoteUpdate(saved);
      await this.refreshNotesList();
      return;
    }

    // Debounced save (250ms)
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(async () => {
      await this.saveActiveNote(true);
    }, 250);
  }

  async saveActiveNote(broadcast = true) {
    if (!this.activeNote) return;

    let title = this.dom.noteTitleInput.value.trim();
    const content = this.dom.noteContentTextarea.value;

    // Fallback title from markdown heading if title is empty
    if (!title) {
      title = extractFirstTitle(content, 'Untitled Note');
    }

    this.activeNote.title = title;
    this.activeNote.content = content;

    const saved = await saveNote(this.activeNote, true);
    this.activeNote = saved;

    if (broadcast) {
      syncManager.broadcastNoteUpdate(saved);
    }

    // Refresh list excerpt without disrupting focus
    await this.refreshNotesList();
  }

  async createWelcomeNote(broadcast = false) {
    const welcome = {
      title: 'Welcome to SyncPad! 🚀',
      tags: ['guide', 'welcome'],
      pinned: true,
      content: `# Welcome to SyncPad 🚀\n\nA distraction-free, real-time cross-device **Markdown Editor & Notes PWA** deployed on Cloudflare Workers.\n\n### ⚡ Zero-Friction Multi-Device Sync\n1. Look at the room code in the top header (e.g. \`${this.roomCode}\`).\n2. Click the room badge to copy your invite link.\n3. Open that link on your phone, tablet, or another browser.\n4. **Type here — and watch it sync across all your devices in real-time!**\n\n---\n\n### 📋 Rich Markdown Features\n\n- [x] Real-time bidirectional WebSocket synchronization\n- [x] Offline-first IndexedDB persistence with auto-sync queue\n- [x] Distraction-free split, edit, and preview modes\n- [x] Tag filtering & instant search\n- [x] Dark and Light theme toggle\n\n### 💻 Code Syntax & Copy\n\`\`\`javascript\n// Real-time synchronization event listener\nsyncManager.on('remoteNoteChange', ({ note }) => {\n  console.log('Real-time sync update received:', note.title);\n});\n\`\`\`\n\n### 📊 Feature Overview\n| Feature | Description | Status |\n| :--- | :--- | :--- |\n| **Real-Time Sync** | WebSockets via Cloudflare Workers | 🟢 Active |\n| **Offline-First** | IndexedDB with sync queue | 🟢 Active |\n| **PWA Installable** | Works offline anytime, anywhere | 🟢 Active |\n\n> "Simplicity is the prerequisite for reliability."\n\nStart typing below or create a new note with **Ctrl+N**! ✨`
    };

    const saved = await saveNote(welcome, broadcast);
    if (broadcast) {
      syncManager.broadcastNoteUpdate(saved);
    }
    await this.selectNote(saved.id);
  }

  // Mobile sidebar controls
  openMobileSidebar() {
    if (this.dom.sidebar) this.dom.sidebar.classList.add('open');
    if (this.dom.sidebarOverlay) this.dom.sidebarOverlay.classList.add('visible');
  }

  closeMobileSidebar() {
    if (this.dom.sidebar) this.dom.sidebar.classList.remove('open');
    if (this.dom.sidebarOverlay) this.dom.sidebarOverlay.classList.remove('visible');
  }

  // Room modal controls
  openRoomModal() {
    if (this.dom.roomModal) {
      this.dom.roomModal.classList.add('open');
      if (this.dom.joinRoomInput) this.dom.joinRoomInput.value = '';
      this.renderQRCode();
    }
  }

  closeRoomModal() {
    if (this.dom.roomModal) {
      this.dom.roomModal.classList.remove('open');
    }
  }

  renderQRCode() {
    if (!this.dom.modalQrCode) return;
    const room = this.roomCode || 'DISCONNECTED';
    const fullRoomUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room)}`;
    try {
      const svg = generateQRCodeSVG(fullRoomUrl, 176);
      this.dom.modalQrCode.innerHTML = svg;
    } catch (err) {
      console.warn('QR code generation error:', err);
    }
  }

  // 1-Tap Quick Actions
  async handleQuickPaste() {
    // 1. Try reading clipboard items directly (handles images copied from screenshot tools or right-click copy)
    if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const ext = imageType.split('/')[1] || 'png';
            const file = new File([blob], `clipboard-image-${Date.now()}.${ext}`, { type: imageType });
            await this.processAndInsertFiles([file]);
            return;
          }
        }
      } catch (_) {
        // Clipboard read permission for images might not be granted; fall through to readText
      }
    }

    // 2. Try reading clipboard text (links, markdown, plain text)
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim().length > 0) {
          if (!this.activeNote) {
            await this.createNewNote();
          }
          const textarea = this.dom.noteContentTextarea;
          const current = textarea.value;
          const separator = (!current || current.endsWith('\n\n')) ? '' : (current.endsWith('\n') ? '\n' : '\n\n');
          textarea.value = current + separator + text;

          await this.handleEditorInput();
          textarea.scrollTop = textarea.scrollHeight;
          textarea.focus();
          showToast('Pasted from clipboard! 📋', 'success', 2000);
          return;
        } else {
          showToast('Clipboard is empty', 'info', 2000);
          return;
        }
      } catch (err) {
        console.warn('Clipboard readText failed:', err);
      }
    }

    // 3. Fallback: prompt user to paste
    if (this.dom.noteContentTextarea) {
      this.dom.noteContentTextarea.focus();
    }
    showToast('Clipboard access denied. Tap or press Ctrl+V to paste', 'info', 2500);
  }

  async handleQuickCopyAll() {
    if (!this.activeNote || !this.dom.noteContentTextarea) {
      showToast('No note selected to copy', 'info');
      return;
    }

    const content = this.dom.noteContentTextarea.value || this.activeNote.content || '';
    if (!content.trim()) {
      showToast('Note is empty', 'info');
      return;
    }

    try {
      await navigator.clipboard.writeText(content);

      // Visual feedback on ribbon button
      if (this.dom.copyMdLabel) {
        const origText = this.dom.copyMdLabel.textContent;
        this.dom.copyMdLabel.textContent = 'Copied! ✓';
        if (this.dom.copyMdBtn) this.dom.copyMdBtn.classList.add('copied');
        setTimeout(() => {
          this.dom.copyMdLabel.textContent = origText;
          if (this.dom.copyMdBtn) this.dom.copyMdBtn.classList.remove('copied');
        }, 1800);
      }

      // Visual feedback on mobile dock button
      if (this.dom.mBtnQuickCopy) {
        const span = this.dom.mBtnQuickCopy.querySelector('span');
        if (span) {
          const origText = span.textContent;
          span.textContent = 'Copied! ✓';
          this.dom.mBtnQuickCopy.classList.add('copied');
          setTimeout(() => {
            span.textContent = origText;
            this.dom.mBtnQuickCopy.classList.remove('copied');
          }, 1800);
        }
      }

      showToast('All content copied to clipboard! 📋', 'success', 2000);
    } catch (err) {
      console.error('Copy failed:', err);
      showToast('Failed to copy to clipboard', 'error');
    }
  }

  handleQuickPhoto() {
    if (this.dom.inputQuickPhoto) {
      this.dom.inputQuickPhoto.value = '';
      this.dom.inputQuickPhoto.click();
    } else if (this.dom.inputImageFile) {
      this.dom.inputImageFile.value = '';
      this.dom.inputImageFile.click();
    } else {
      this.openImageModal();
    }
  }

  toggleMarkdownToolbar() {
    if (!this.dom.markdownToolbar) return;
    const isHidden = this.dom.markdownToolbar.classList.toggle('hidden');
    if (this.dom.btnToggleTools) {
      this.dom.btnToggleTools.classList.toggle('active', !isHidden);
      this.dom.btnToggleTools.title = isHidden ? 'Show formatting toolbar' : 'Hide formatting toolbar';
    }
    try {
      localStorage.setItem('syncpad_show_toolbar', isHidden ? 'false' : 'true');
    } catch (_) {}
  }

  updateDetectedLinks(content) {
    if (!this.dom.detectedLinksBar) return;
    if (!content || typeof content !== 'string') {
      this.dom.detectedLinksBar.style.display = 'none';
      this.dom.detectedLinksBar.innerHTML = '';
      return;
    }

    const urlRegex = /(https?:\/\/[^\s)\]>"'<>]+)/gi;
    const matches = content.match(urlRegex);

    if (!matches || matches.length === 0) {
      this.dom.detectedLinksBar.style.display = 'none';
      this.dom.detectedLinksBar.innerHTML = '';
      return;
    }

    const uniqueUrls = Array.from(new Set(matches)).slice(0, 4);

    this.dom.detectedLinksBar.innerHTML = '';
    uniqueUrls.forEach((url) => {
      let domain = url;
      try {
        const parsed = new URL(url);
        domain = parsed.hostname + (parsed.pathname !== '/' && parsed.pathname.length > 1 ? parsed.pathname.slice(0, 16) + (parsed.pathname.length > 16 ? '…' : '') : '');
      } catch (_) {}

      const chip = document.createElement('div');
      chip.className = 'detected-link-chip';

      const domainSpan = document.createElement('span');
      domainSpan.className = 'detected-link-domain';
      domainSpan.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="flex-shrink:0">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
        </svg>
        <span>${this.escapeText(domain)}</span>
      `;

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'link-chip-actions';

      const openBtn = document.createElement('a');
      openBtn.className = 'link-chip-btn';
      openBtn.href = url;
      openBtn.target = '_blank';
      openBtn.rel = 'noopener noreferrer';
      openBtn.textContent = 'Open ↗';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'link-chip-btn';
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy 📋';
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = 'Copied! ✓';
          setTimeout(() => { copyBtn.textContent = 'Copy 📋'; }, 1500);
        } catch (_) {
          showToast('Failed to copy link', 'error');
        }
      });

      actionsDiv.appendChild(openBtn);
      actionsDiv.appendChild(copyBtn);
      chip.appendChild(domainSpan);
      chip.appendChild(actionsDiv);
      this.dom.detectedLinksBar.appendChild(chip);
    });

    this.dom.detectedLinksBar.style.display = 'flex';
  }

  escapeText(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return m;
      }
    });
  }

  // Image modal controls
  openImageModal(defaultTab = 'upload') {
    if (this.dom.imageModal) {
      this.dom.imageModal.classList.add('open');
      this.resetImageModal();
      this.switchImageTab(defaultTab);
      setTimeout(() => {
        if (defaultTab === 'url' && this.dom.inputImageWebUrl) {
          this.dom.inputImageWebUrl.focus();
        } else if (this.dom.imageDropArea) {
          this.dom.imageDropArea.focus();
        }
      }, 60);
    }
  }

  closeImageModal() {
    if (this.dom.imageModal) {
      this.dom.imageModal.classList.remove('open');
      this.resetImageModal();
    }
  }

  resetImageModal() {
    this.stagedImageData = null;
    this.stagedWebImageUrl = null;
    this.stagedWebMetadata = null;
    if (this.dom.inputImageFile) this.dom.inputImageFile.value = '';
    if (this.dom.imagePreviewWrapper) this.dom.imagePreviewWrapper.style.display = 'none';
    if (this.dom.imageDropArea) this.dom.imageDropArea.style.display = 'flex';
    if (this.dom.inputImageCaption) this.dom.inputImageCaption.value = '';
    if (this.dom.confirmInsertFileBtn) this.dom.confirmInsertFileBtn.disabled = true;

    if (this.dom.inputImageWebUrl) this.dom.inputImageWebUrl.value = '';
    if (this.dom.inputImageWebCaption) this.dom.inputImageWebCaption.value = '';
    if (this.dom.webImagePreviewContainer) this.dom.webImagePreviewContainer.style.display = 'none';
    if (this.dom.webImagePreviewImg) {
      this.dom.webImagePreviewImg.src = '';
      this.dom.webImagePreviewImg.style.display = 'none';
    }
    if (this.dom.webLinkMetaCard) this.dom.webLinkMetaCard.style.display = 'none';
    if (this.dom.webUrlStatus) {
      this.dom.webUrlStatus.style.display = 'none';
      this.dom.webUrlStatus.className = 'web-url-status';
      this.dom.webUrlStatus.textContent = '';
    }
    if (this.dom.confirmInsertUrlBtn) {
      this.dom.confirmInsertUrlBtn.disabled = true;
      this.dom.confirmInsertUrlBtn.textContent = 'Insert Image';
    }
    if (this.dom.btnSaveWebImage) this.dom.btnSaveWebImage.style.display = 'none';
    if (this.dom.btnInsertWebBookmark) this.dom.btnInsertWebBookmark.style.display = 'none';
  }

  switchImageTab(tabName) {
    if (!this.dom.tabImageUpload || !this.dom.tabImageUrl) return;
    const isUpload = tabName === 'upload';

    this.dom.tabImageUpload.classList.toggle('active', isUpload);
    this.dom.tabImageUrl.classList.toggle('active', !isUpload);

    if (this.dom.paneImageUpload) {
      this.dom.paneImageUpload.style.display = isUpload ? 'flex' : 'none';
    }
    if (this.dom.paneImageUrl) {
      this.dom.paneImageUrl.style.display = !isUpload ? 'flex' : 'none';
      if (!isUpload && this.dom.inputImageWebUrl) {
        setTimeout(() => this.dom.inputImageWebUrl.focus(), 60);
      }
    }
  }

  async stageImageFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      showToast('Please select a valid picture file', 'warning');
      return;
    }

    try {
      showToast('Optimizing picture...', 'info', 1000);
      const processed = await compressImage(file);
      this.stagedImageData = processed;

      if (this.dom.imagePreviewThumb) this.dom.imagePreviewThumb.src = processed.dataUrl;
      if (this.dom.imagePreviewName) this.dom.imagePreviewName.textContent = file.name || 'picture.webp';
      if (this.dom.imagePreviewSize) this.dom.imagePreviewSize.textContent = `${formatBytes(processed.size)} (optimized)`;
      if (this.dom.imagePreviewWrapper) this.dom.imagePreviewWrapper.style.display = 'flex';
      if (this.dom.imageDropArea) this.dom.imageDropArea.style.display = 'none';
      if (this.dom.confirmInsertFileBtn) this.dom.confirmInsertFileBtn.disabled = false;

      // Suggest caption from file name without extension if caption is blank
      if (this.dom.inputImageCaption && !this.dom.inputImageCaption.value.trim()) {
        const baseName = (file.name || 'Picture').replace(/\.[^/.]+$/, '');
        this.dom.inputImageCaption.value = baseName;
      }
    } catch (err) {
      console.error('Error staging image:', err);
      showToast('Failed to process picture', 'error');
    }
  }

  async attachStagedImage() {
    if (!this.stagedImageData) return;
    if (!this.activeNote) {
      await this.createNewNote();
    }
    if (!Array.isArray(this.activeNote.images)) {
      this.activeNote.images = [];
    }

    const caption = (this.dom.inputImageCaption?.value.trim()) || this.stagedImageData.name || 'Picture';
    const imageId = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    this.activeNote.images.push({
      id: imageId,
      name: caption,
      dataUrl: this.stagedImageData.dataUrl,
      size: this.stagedImageData.size,
      createdAt: Date.now()
    });

    insertImagePlaceholder(this.dom.noteContentTextarea, caption, imageId);
    this.updateAttachedImagesUI();
    await this.saveActiveNote(true);

    this.closeImageModal();
    showToast('Picture attached to note! 📸', 'success', 2200);
  }

  showWebUrlStatus(type, message) {
    if (!this.dom.webUrlStatus) return;
    this.dom.webUrlStatus.className = `web-url-status ${type}`;
    this.dom.webUrlStatus.innerHTML = message;
    this.dom.webUrlStatus.style.display = 'flex';
  }

  hideWebUrlStatus() {
    if (!this.dom.webUrlStatus) return;
    this.dom.webUrlStatus.style.display = 'none';
    this.dom.webUrlStatus.innerHTML = '';
  }

  renderWebImagePreview(imgSrc) {
    if (this.dom.webImagePreviewContainer) {
      this.dom.webImagePreviewContainer.style.display = 'flex';
    }
    if (this.dom.webImagePreviewImg) {
      this.dom.webImagePreviewImg.src = imgSrc;
      this.dom.webImagePreviewImg.style.display = 'block';
    }
    if (this.dom.webLinkMetaCard) {
      this.dom.webLinkMetaCard.style.display = 'none';
    }
  }

  renderWebMetadataPreview(meta) {
    if (this.dom.webImagePreviewContainer) {
      this.dom.webImagePreviewContainer.style.display = 'flex';
    }
    if (this.dom.webImagePreviewImg) {
      if (meta.image) {
        this.dom.webImagePreviewImg.src = meta.image;
        this.dom.webImagePreviewImg.style.display = 'block';
      } else {
        this.dom.webImagePreviewImg.style.display = 'none';
      }
    }
    if (this.dom.webLinkMetaCard) {
      this.dom.webLinkMetaCard.style.display = 'block';
      if (this.dom.webMetaSite) this.dom.webMetaSite.textContent = meta.siteName || '';
      if (this.dom.webMetaTitle) this.dom.webMetaTitle.textContent = meta.title || '';
      if (this.dom.webMetaDesc) this.dom.webMetaDesc.textContent = meta.description || '';
    }
  }

  disableWebUrlActions() {
    if (this.dom.confirmInsertUrlBtn) {
      this.dom.confirmInsertUrlBtn.disabled = true;
      this.dom.confirmInsertUrlBtn.textContent = 'Insert Image';
    }
    if (this.dom.btnSaveWebImage) this.dom.btnSaveWebImage.style.display = 'none';
    if (this.dom.btnInsertWebBookmark) this.dom.btnInsertWebBookmark.style.display = 'none';
    if (this.dom.webImagePreviewContainer) this.dom.webImagePreviewContainer.style.display = 'none';
  }

  resetWebUrlPreview() {
    this.hideWebUrlStatus();
    this.disableWebUrlActions();
    this.stagedWebImageUrl = null;
    this.stagedWebMetadata = null;
  }

  async inspectWebUrl() {
    let rawVal = this.dom.inputImageWebUrl?.value.trim() || '';
    if (!rawVal) {
      this.resetWebUrlPreview();
      return;
    }

    // Strip wrapping quotes or brackets from copy-paste
    rawVal = rawVal.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim();

    // Auto-prefix https:// if missing protocol and looks like a domain
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(rawVal) && !rawVal.startsWith('data:image/')) {
      if (rawVal.includes('.') || rawVal.includes(':')) {
        rawVal = 'https://' + rawVal;
      }
    }

    // Validate URL syntax and protocol
    let parsedUrl;
    try {
      parsedUrl = new URL(rawVal);
    } catch (_) {
      this.showWebUrlStatus('error', '⚠️ Please enter a valid URL (e.g. https://example.com/photo.jpg)');
      this.disableWebUrlActions();
      return;
    }

    const isDataImg = parsedUrl.protocol === 'data:' && rawVal.startsWith('data:image/');
    if (!['http:', 'https:'].includes(parsedUrl.protocol) && !isDataImg) {
      this.showWebUrlStatus('error', '⚠️ Please enter a valid http:// or https:// web address');
      this.disableWebUrlActions();
      return;
    }

    this.showWebUrlStatus('loading', '⏳ Loading preview and checking link...');
    this.disableWebUrlActions();

    this.stagedWebImageUrl = null;
    this.stagedWebMetadata = null;

    // Helper: Test loading directly as an image with timeout
    const tryDirectImageLoad = (url) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        let doneCalled = false;
        const finish = (ok) => {
          if (!doneCalled) {
            doneCalled = true;
            resolve(ok ? img : null);
          }
        };
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = url;
        setTimeout(() => finish(false), 2000);
      });
    };

    const isKnownImageExt = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?.*)?$/i.test(parsedUrl.pathname);

    // 1. If known image extension or data image, try direct image load first
    if (isKnownImageExt || isDataImg) {
      const directImg = await tryDirectImageLoad(rawVal);
      if (directImg) {
        this.stagedWebImageUrl = rawVal;
        this.renderWebImagePreview(rawVal);
        this.showWebUrlStatus('success', '✓ Picture loaded successfully');

        // Auto-suggest caption from filename
        if (this.dom.inputImageWebCaption && !this.dom.inputImageWebCaption.value.trim()) {
          const pathPart = parsedUrl.pathname.split('/').filter(Boolean).pop() || '';
          const namePart = pathPart.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');
          if (namePart) this.dom.inputImageWebCaption.value = namePart;
        }

        if (this.dom.confirmInsertUrlBtn) {
          this.dom.confirmInsertUrlBtn.disabled = false;
          this.dom.confirmInsertUrlBtn.textContent = 'Insert Picture';
        }
        if (this.dom.btnSaveWebImage) this.dom.btnSaveWebImage.style.display = 'inline-flex';
        if (this.dom.btnInsertWebBookmark) this.dom.btnInsertWebBookmark.style.display = 'none';
        return;
      }
    }

    // 2. Query /api/link-metadata for website OpenGraph cards or direct images
    try {
      const metaResp = await fetch(`/api/link-metadata?url=${encodeURIComponent(rawVal)}`);
      if (metaResp.ok) {
        const meta = await metaResp.json();
        this.stagedWebMetadata = meta;

        // Case A: Target is a direct image that had CORS/hotlink restrictions
        if (meta.isImage) {
          const proxiedUrl = `/api/proxy?url=${encodeURIComponent(rawVal)}`;
          this.stagedWebImageUrl = rawVal;
          this.renderWebImagePreview(proxiedUrl);
          this.showWebUrlStatus('success', '✓ Picture verified via secure proxy');

          if (this.dom.inputImageWebCaption && !this.dom.inputImageWebCaption.value.trim() && meta.title) {
            this.dom.inputImageWebCaption.value = meta.title.replace(/\.[^/.]+$/, '');
          }

          if (this.dom.confirmInsertUrlBtn) {
            this.dom.confirmInsertUrlBtn.disabled = false;
            this.dom.confirmInsertUrlBtn.textContent = 'Insert Picture';
          }
          if (this.dom.btnSaveWebImage) this.dom.btnSaveWebImage.style.display = 'inline-flex';
          if (this.dom.btnInsertWebBookmark) this.dom.btnInsertWebBookmark.style.display = 'none';
          return;
        }

        // Case B: Webpage with metadata (title, description, optional og:image)
        if (meta.title || meta.image) {
          if (this.dom.inputImageWebCaption && !this.dom.inputImageWebCaption.value.trim() && meta.title) {
            this.dom.inputImageWebCaption.value = meta.title;
          }

          this.renderWebMetadataPreview(meta);

          if (meta.image) {
            this.stagedWebImageUrl = meta.image;
            this.showWebUrlStatus('success', `✓ Found preview from ${meta.siteName || parsedUrl.hostname}`);
            if (this.dom.confirmInsertUrlBtn) {
              this.dom.confirmInsertUrlBtn.disabled = false;
              this.dom.confirmInsertUrlBtn.textContent = 'Insert Picture with Link';
            }
            if (this.dom.btnSaveWebImage) this.dom.btnSaveWebImage.style.display = 'inline-flex';
          } else {
            this.showWebUrlStatus('success', `✓ Found webpage from ${meta.siteName || parsedUrl.hostname}`);
            if (this.dom.confirmInsertUrlBtn) {
              this.dom.confirmInsertUrlBtn.disabled = false;
              this.dom.confirmInsertUrlBtn.textContent = 'Insert Markdown Link';
            }
          }

          if (this.dom.btnInsertWebBookmark) this.dom.btnInsertWebBookmark.style.display = 'inline-flex';
          return;
        }
      }
    } catch (err) {
      console.warn('Metadata fetch failed:', err);
    }

    // 3. Fallback: try proxying raw URL in case it's an image requiring proxy
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(rawVal)}`;
    const proxyImg = await tryDirectImageLoad(proxyUrl);
    if (proxyImg) {
      this.stagedWebImageUrl = rawVal;
      this.renderWebImagePreview(proxyUrl);
      this.showWebUrlStatus('success', '✓ Picture loaded via secure proxy');
      if (this.dom.confirmInsertUrlBtn) {
        this.dom.confirmInsertUrlBtn.disabled = false;
        this.dom.confirmInsertUrlBtn.textContent = 'Insert Picture';
      }
      if (this.dom.btnSaveWebImage) this.dom.btnSaveWebImage.style.display = 'inline-flex';
      return;
    }

    // 4. Graceful Fallback: The link is valid, but the upstream site blocked scraping (e.g. 403 or captcha)
    // Never trap or block the user; allow inserting as link or bookmark
    const fallbackTitle = parsedUrl.hostname.replace(/^www\./i, '') + (parsedUrl.pathname !== '/' && parsedUrl.pathname.length > 1 ? parsedUrl.pathname : '');
    if (this.dom.inputImageWebCaption && !this.dom.inputImageWebCaption.value.trim()) {
      this.dom.inputImageWebCaption.value = fallbackTitle;
    }
    this.showWebUrlStatus('success', `✓ Link verified (${parsedUrl.hostname})`);
    if (this.dom.confirmInsertUrlBtn) {
      this.dom.confirmInsertUrlBtn.disabled = false;
      this.dom.confirmInsertUrlBtn.textContent = 'Insert Markdown Link';
    }
    if (this.dom.btnInsertWebBookmark) {
      this.dom.btnInsertWebBookmark.style.display = 'inline-flex';
    }
  }

  async attachWebImage() {
    let rawUrl = this.dom.inputImageWebUrl?.value.trim();
    if (!rawUrl) return;

    rawUrl = rawUrl.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim();
    if (!/^https?:\/\//i.test(rawUrl) && !/^data:image\//i.test(rawUrl)) {
      rawUrl = 'https://' + rawUrl;
    }

    if (!this.activeNote) {
      await this.createNewNote();
    }

    const caption = (this.dom.inputImageWebCaption?.value.trim()) ||
                    (this.stagedWebMetadata && this.stagedWebMetadata.title) ||
                    'Link';

    // If it's a webpage with an image, insert linked image: [![caption](imgUrl)](pageUrl)
    if (this.stagedWebMetadata && !this.stagedWebMetadata.isImage && this.stagedWebImageUrl) {
      insertImageMarkdown(this.dom.noteContentTextarea, caption, this.stagedWebImageUrl, rawUrl);
      showToast('Linked picture inserted! 🔗', 'success', 2200);
    } else if (this.stagedWebImageUrl) {
      // Direct image
      insertImageMarkdown(this.dom.noteContentTextarea, caption, this.stagedWebImageUrl);
      showToast('Picture attached to note! 📸', 'success', 2200);
    } else {
      // General link without image
      const cleanCaption = caption.replace(/[\[\]]/g, '').trim() || rawUrl;
      const cleanUrl = rawUrl.replace(/ /g, '%20');
      const linkTag = `\n\n[${cleanCaption}](${cleanUrl})\n\n`;
      const textarea = this.dom.noteContentTextarea;
      if (textarea) {
        const start = textarea.selectionStart !== undefined ? textarea.selectionStart : textarea.value.length;
        const end = textarea.selectionEnd !== undefined ? textarea.selectionEnd : start;
        textarea.value = textarea.value.substring(0, start) + linkTag + textarea.value.substring(end);
        const newPos = start + linkTag.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      showToast('Link inserted into note! 🔗', 'success', 2200);
    }

    await this.saveActiveNote(true);
    this.closeImageModal();
  }

  async saveWebImageToNote() {
    const url = this.stagedWebImageUrl || this.dom.inputImageWebUrl?.value.trim();
    if (!url) return;

    if (!this.activeNote) {
      await this.createNewNote();
    }
    if (!Array.isArray(this.activeNote.images)) {
      this.activeNote.images = [];
    }

    showToast('Downloading and saving picture...', 'info', 1500);

    try {
      let blob = null;
      try {
        const resp = await fetch(url, { mode: 'cors' });
        if (resp.ok) blob = await resp.blob();
      } catch (_) {}

      if (!blob) {
        const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
        const resp = await fetch(proxyUrl);
        if (resp.ok) blob = await resp.blob();
      }

      if (!blob) {
        throw new Error('Failed to retrieve image data');
      }

      const processed = await compressImage(blob);
      const caption = this.dom.inputImageWebCaption?.value.trim() || 'Picture';
      const imageId = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

      this.activeNote.images.push({
        id: imageId,
        name: caption,
        dataUrl: processed.dataUrl,
        size: processed.size,
        createdAt: Date.now()
      });

      insertImagePlaceholder(this.dom.noteContentTextarea, caption, imageId);
      this.updateAttachedImagesUI();
      await this.saveActiveNote(true);

      this.closeImageModal();
      showToast('Picture saved to note attachments! 📸', 'success', 2500);
    } catch (err) {
      console.error('Failed to save web image to note:', err);
      showToast('Failed to save image locally to note', 'error');
    }
  }

  async insertWebBookmark() {
    const meta = this.stagedWebMetadata;
    let url = this.dom.inputImageWebUrl?.value.trim() || '';
    if (!url) return;

    url = url.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim();
    if (!/^https?:\/\//i.test(url) && !url.startsWith('data:image/')) {
      url = 'https://' + url;
    }

    if (!this.activeNote) {
      await this.createNewNote();
    }

    const rawTitle = this.dom.inputImageWebCaption?.value.trim() || (meta && meta.title) || url;
    const title = rawTitle.replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
    const desc = (meta && meta.description) || '';
    const img = this.stagedWebImageUrl || (meta && meta.image) || '';
    const cleanUrl = url.replace(/ /g, '%20');

    let descBlock = '';
    if (desc) {
      descBlock = desc
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => '> ' + l)
        .join('\n');
    }

    let mdSnippet = '';
    if (img) {
      const cleanImg = img.replace(/ /g, '%20');
      mdSnippet = `\n\n[![${title}](${cleanImg})](${cleanUrl})\n\n> [**${title}**](${cleanUrl})${descBlock ? '\n' + descBlock : ''}\n\n`;
    } else {
      mdSnippet = `\n\n> [**${title}**](${cleanUrl})${descBlock ? '\n' + descBlock : ''}\n\n`;
    }

    const textarea = this.dom.noteContentTextarea;
    if (textarea) {
      const start = textarea.selectionStart !== undefined ? textarea.selectionStart : textarea.value.length;
      const end = textarea.selectionEnd !== undefined ? textarea.selectionEnd : start;
      const before = textarea.value.substring(0, start);
      const after = textarea.value.substring(end);
      textarea.value = before + mdSnippet + after;
      const newPos = start + mdSnippet.length;
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus();
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await this.saveActiveNote(true);
    this.closeImageModal();
    showToast('Website bookmark inserted! 🔗', 'success', 2200);
  }

  async processAndInsertFiles(fileList) {
    const imageFiles = Array.from(fileList || []).filter(f => f.type && f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    if (!this.activeNote) {
      await this.createNewNote();
    }
    if (!Array.isArray(this.activeNote.images)) {
      this.activeNote.images = [];
    }

    showToast(`Attaching ${imageFiles.length} picture(s)...`, 'info', 1500);

    for (const file of imageFiles) {
      try {
        const processed = await compressImage(file);
        const baseName = (file.name || 'Picture').replace(/\.[^/.]+$/, '');
        const imageId = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

        this.activeNote.images.push({
          id: imageId,
          name: baseName,
          dataUrl: processed.dataUrl,
          size: processed.size,
          createdAt: Date.now()
        });

        // Insert clean placeholder into textarea instead of dumping 48,000 raw base64 chars!
        insertImagePlaceholder(this.dom.noteContentTextarea, baseName, imageId);
      } catch (err) {
        console.error('Failed to attach image:', file.name, err);
      }
    }

    this.updateAttachedImagesUI();
    await this.saveActiveNote(true);
    showToast(`Attached ${imageFiles.length} picture(s)! 📸`, 'success', 2500);
  }

  updateAttachedImagesUI() {
    if (!this.dom.attachedImagesStrip) return;
    const images = (this.activeNote && Array.isArray(this.activeNote.images)) ? this.activeNote.images : [];
    renderAttachedImagesStrip({
      container: this.dom.attachedImagesStrip,
      images,
      onCopyImage: async (dataUrl) => {
        try {
          await copyImageDataUrlToClipboard(dataUrl);
        } catch (err) {
          console.warn('Clipboard image write failed:', err);
          showToast('Failed to copy image to clipboard', 'error');
        }
      },
      onDownloadImage: (dataUrl, name) => {
        const a = document.createElement('a');
        a.href = dataUrl;
        const ext = dataUrl.startsWith('data:image/webp') ? 'webp' : 'png';
        a.download = `${(name || 'syncpad-image').replace(/[^a-z0-9_-]/gi, '_')}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast('Image download started', 'info', 1800);
      },
      onZoomImage: (dataUrl, name) => {
        this.lightbox.open(dataUrl, name);
      },
      onRemoveImage: async (id) => {
        if (!this.activeNote || !this.activeNote.images) return;
        this.activeNote.images = this.activeNote.images.filter((img) => img.id !== id);
        if (this.dom.noteContentTextarea) {
          const val = this.dom.noteContentTextarea.value;
          const clean = val.replace(new RegExp(`!?\\[[^\\]]*\\]\\(attachment:${id}\\)`, 'g'), '');
          this.dom.noteContentTextarea.value = clean.trim();
          await this.handleEditorInput();
        }
        this.updateAttachedImagesUI();
        await this.saveActiveNote(true);
        showToast('Picture removed', 'info', 1800);
      }
    });
  }

  bindEvents() {
    // Mobile sidebar toggle
    if (this.dom.sidebarToggleBtn) {
      this.dom.sidebarToggleBtn.addEventListener('click', () => this.openMobileSidebar());
    }
    if (this.dom.sidebarOverlay) {
      this.dom.sidebarOverlay.addEventListener('click', () => this.closeMobileSidebar());
    }

    // New Note
    if (this.dom.newNoteBtn) {
      this.dom.newNoteBtn.addEventListener('click', () => this.createNewNote());
    }

    // Search
    if (this.dom.searchInput) {
      this.dom.searchInput.addEventListener('input', (e) => {
        this.searchQuery = e.target.value;
        if (this.dom.searchClearBtn) {
          this.dom.searchClearBtn.style.display = this.searchQuery ? 'flex' : 'none';
        }
        this.refreshNotesList();
      });
    }

    if (this.dom.searchClearBtn) {
      this.dom.searchClearBtn.addEventListener('click', () => {
        this.searchQuery = '';
        this.dom.searchInput.value = '';
        this.dom.searchClearBtn.style.display = 'none';
        this.refreshNotesList();
        this.dom.searchInput.focus();
      });
    }

    // Editor inputs
    if (this.dom.noteTitleInput) {
      this.dom.noteTitleInput.addEventListener('input', () => this.handleEditorInput());
    }
    if (this.dom.noteContentTextarea) {
      this.dom.noteContentTextarea.addEventListener('input', () => this.handleEditorInput());
      
      // Synchronize scroll from editor to preview
      this.dom.noteContentTextarea.addEventListener('scroll', () => {
        if (this.viewMode === 'split' && this.dom.markdownPreview) {
          const textarea = this.dom.noteContentTextarea;
          const preview = this.dom.markdownPreview;
          const percentage = textarea.scrollTop / (textarea.scrollHeight - textarea.clientHeight || 1);
          preview.scrollTop = percentage * (preview.scrollHeight - preview.clientHeight);
        }
      });
    }

    // Pin & Delete in Editor
    if (this.dom.pinNoteBtn) {
      this.dom.pinNoteBtn.addEventListener('click', () => {
        if (this.activeNote) this.togglePinNote(this.activeNote.id);
        else showToast('Please select or create a note first', 'info');
      });
    }
    if (this.dom.deleteCurrentNoteBtn) {
      this.dom.deleteCurrentNoteBtn.addEventListener('click', () => {
        if (this.activeNote) this.confirmDeleteNote(this.activeNote.id);
        else showToast('Please select or create a note first', 'info');
      });
    }

    // New tag input
    if (this.dom.newTagInput) {
      this.dom.newTagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const val = this.dom.newTagInput.value.replace(/#/g, '');
          if (val) {
            this.addTagToActiveNote(val);
            this.dom.newTagInput.value = '';
          }
        }
      });
    }

    // View mode buttons
    if (this.dom.viewModeEditBtn) {
      this.dom.viewModeEditBtn.addEventListener('click', () => this.setViewMode('edit'));
    }
    if (this.dom.viewModeSplitBtn) {
      this.dom.viewModeSplitBtn.addEventListener('click', () => this.setViewMode('split'));
    }
    if (this.dom.viewModePreviewBtn) {
      this.dom.viewModePreviewBtn.addEventListener('click', () => this.setViewMode('preview'));
    }

    // Theme toggle
    if (this.dom.themeToggleBtn) {
      this.dom.themeToggleBtn.addEventListener('click', () => this.toggleTheme());
    }

    // Export & Copy
    if (this.dom.exportMdBtn) {
      this.dom.exportMdBtn.addEventListener('click', () => this.exportMarkdownFile());
    }

    // 1-Tap Quick Actions (Ribbon & Mobile Dock)
    if (this.dom.btnQuickPaste) {
      this.dom.btnQuickPaste.addEventListener('click', () => this.handleQuickPaste());
    }
    if (this.dom.mBtnQuickPaste) {
      this.dom.mBtnQuickPaste.addEventListener('click', () => this.handleQuickPaste());
    }

    if (this.dom.btnQuickPhoto) {
      this.dom.btnQuickPhoto.addEventListener('click', () => this.handleQuickPhoto());
    }
    if (this.dom.mBtnQuickPhoto) {
      this.dom.mBtnQuickPhoto.addEventListener('click', () => this.handleQuickPhoto());
    }
    if (this.dom.inputQuickPhoto) {
      this.dom.inputQuickPhoto.addEventListener('change', async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          await this.processAndInsertFiles(e.target.files);
          e.target.value = '';
        }
      });
    }

    if (this.dom.copyMdBtn) {
      this.dom.copyMdBtn.addEventListener('click', () => this.handleQuickCopyAll());
    }
    if (this.dom.mBtnQuickCopy) {
      this.dom.mBtnQuickCopy.addEventListener('click', () => this.handleQuickCopyAll());
    }

    if (this.dom.btnToggleTools) {
      this.dom.btnToggleTools.addEventListener('click', () => this.toggleMarkdownToolbar());
    }

    if (this.dom.mBtnNewNote) {
      this.dom.mBtnNewNote.addEventListener('click', () => this.createNewNote());
    }
    if (this.dom.mBtnRoom) {
      this.dom.mBtnRoom.addEventListener('click', () => this.openRoomModal());
    }

    // Room Modal
    if (this.dom.roomBadgeBtn) {
      this.dom.roomBadgeBtn.addEventListener('click', () => this.openRoomModal());
    }
    if (this.dom.closeRoomModalBtn) {
      this.dom.closeRoomModalBtn.addEventListener('click', () => this.closeRoomModal());
    }
    if (this.dom.roomModal) {
      this.dom.roomModal.addEventListener('click', (e) => {
        if (e.target === this.dom.roomModal) this.closeRoomModal();
      });
    }

    // Copy room code
    if (this.dom.copyRoomCodeBtn) {
      this.dom.copyRoomCodeBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(this.roomCode);
          showToast(`Room code copied: ${this.roomCode}`, 'success', 2000);
        } catch (_) {
          showToast('Failed to copy', 'error');
        }
      });
    }

    // Copy invite link
    if (this.dom.copyRoomLinkBtn) {
      this.dom.copyRoomLinkBtn.addEventListener('click', async () => {
        const link = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(this.roomCode)}`;
        try {
          await navigator.clipboard.writeText(link);
          showToast('Sync invite link copied to clipboard!', 'success', 2500);
        } catch (_) {
          showToast('Failed to copy link', 'error');
        }
      });
    }

    // Join room
    if (this.dom.joinRoomBtn) {
      this.dom.joinRoomBtn.addEventListener('click', () => {
        const code = this.dom.joinRoomInput.value.trim();
        if (code) {
          syncManager.joinRoom(code);
          this.closeRoomModal();
          showToast(`Joined sync room: ${code.toUpperCase()}`, 'success', 2500);
        }
      });
    }

    // Create new random room
    if (this.dom.createNewRoomBtn) {
      this.dom.createNewRoomBtn.addEventListener('click', () => {
        const newCode = syncManager.generateRoomCode();
        syncManager.joinRoom(newCode);
        this.closeRoomModal();
        showToast(`Created new sync room: ${newCode}`, 'success', 2500);
      });
    }

    // Image Modal Triggers
    if (this.dom.insertImageBtn) {
      this.dom.insertImageBtn.addEventListener('click', () => this.openImageModal());
    }
    if (this.dom.closeImageModalBtn) {
      this.dom.closeImageModalBtn.addEventListener('click', () => this.closeImageModal());
    }
    if (this.dom.imageModal) {
      this.dom.imageModal.addEventListener('click', (e) => {
        if (e.target === this.dom.imageModal) this.closeImageModal();
      });
    }

    // Image Modal Tabs
    if (this.dom.tabImageUpload) {
      this.dom.tabImageUpload.addEventListener('click', () => this.switchImageTab('upload'));
    }
    if (this.dom.tabImageUrl) {
      this.dom.tabImageUrl.addEventListener('click', () => this.switchImageTab('url'));
    }

    // Image File Selection & Drop Area in Modal
    if (this.dom.imageDropArea && this.dom.inputImageFile) {
      this.dom.imageDropArea.addEventListener('click', () => this.dom.inputImageFile.click());
      this.dom.imageDropArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.dom.inputImageFile.click();
        }
      });

      this.dom.imageDropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.dom.imageDropArea.classList.add('dragover');
      });
      this.dom.imageDropArea.addEventListener('dragleave', () => {
        this.dom.imageDropArea.classList.remove('dragover');
      });
      this.dom.imageDropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        this.dom.imageDropArea.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          this.stageImageFile(e.dataTransfer.files[0]);
        }
      });

      this.dom.inputImageFile.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
          this.stageImageFile(e.target.files[0]);
        }
      });
    }

    if (this.dom.clearImageFileBtn) {
      this.dom.clearImageFileBtn.addEventListener('click', () => this.resetImageModal());
    }

    if (this.dom.confirmInsertFileBtn) {
      this.dom.confirmInsertFileBtn.addEventListener('click', () => this.attachStagedImage());
    }

    // Web URL Image & Website Link Input
    if (this.dom.inputImageWebUrl) {
      let debounceTimer = null;
      this.dom.inputImageWebUrl.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => this.inspectWebUrl(), 350);
      });

      this.dom.inputImageWebUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(debounceTimer);
          this.inspectWebUrl();
        }
      });
    }

    if (this.dom.btnFetchWebUrl) {
      this.dom.btnFetchWebUrl.addEventListener('click', () => this.inspectWebUrl());
    }

    if (this.dom.confirmInsertUrlBtn) {
      this.dom.confirmInsertUrlBtn.addEventListener('click', () => this.attachWebImage());
    }

    if (this.dom.btnSaveWebImage) {
      this.dom.btnSaveWebImage.addEventListener('click', () => this.saveWebImageToNote());
    }

    if (this.dom.btnInsertWebBookmark) {
      this.dom.btnInsertWebBookmark.addEventListener('click', () => this.insertWebBookmark());
    }

    // Direct Drag-and-Drop on Editor Pane
    const editorPane = this.dom.editorPane;
    if (editorPane) {
      ['dragenter', 'dragover'].forEach((eventName) => {
        editorPane.addEventListener(eventName, (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            editorPane.classList.add('drag-active');
          }
        });
      });

      ['dragleave', 'dragend'].forEach((eventName) => {
        editorPane.addEventListener(eventName, (e) => {
          if (e.target === editorPane || !editorPane.contains(e.relatedTarget)) {
            editorPane.classList.remove('drag-active');
          }
        });
      });

      editorPane.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        editorPane.classList.remove('drag-active');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          this.processAndInsertFiles(e.dataTransfer.files);
          return;
        }

        // Web drag-and-drop: image URL or link dropped from external tab or web
        if (e.dataTransfer) {
          const rawUri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
          if (rawUri && /^https?:\/\//i.test(rawUri.trim())) {
            const uri = rawUri.trim();
            if (/\.(jpe?g|png|gif|webp|svg|avif|bmp)(\?.*)?$/i.test(uri)) {
              insertImageMarkdown(this.dom.noteContentTextarea, 'Image', uri);
              showToast('Web image dropped! 📸', 'success', 2000);
            } else {
              insertMarkdownSyntax(this.dom.noteContentTextarea, '[', `](${uri})`, 'Link');
              showToast('Web link dropped! 🔗', 'success', 2000);
            }
          }
        }
      });
    }

    // Direct Clipboard Image Paste in Note Textarea
    if (this.dom.noteContentTextarea) {
      this.dom.noteContentTextarea.addEventListener('paste', async (e) => {
        if (!e.clipboardData || !e.clipboardData.items) return;
        const items = Array.from(e.clipboardData.items);
        const imageItems = items.filter((it) => it.type && it.type.startsWith('image/'));

        if (imageItems.length > 0) {
          e.preventDefault();
          const files = imageItems.map((it) => it.getAsFile()).filter(Boolean);
          await this.processAndInsertFiles(files);
        }
      });
    }

    // Markdown Preview Image Click -> Lightbox Viewer
    if (this.dom.markdownPreview) {
      this.dom.markdownPreview.addEventListener('click', (e) => {
        const img = e.target.closest('img.markdown-image');
        if (img && img.src && !img.src.includes('#unsafe')) {
          this.lightbox.open(img.src, img.alt || '');
        }
      });
    }
  }

  exportMarkdownFile() {
    if (!this.activeNote) {
      showToast('No note selected to export', 'info');
      return;
    }
    const filename = `${(this.activeNote.title || 'untitled').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    const blob = new Blob([this.activeNote.content || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported "${filename}"`, 'info', 2000);
  }

  bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;

      // Ctrl+S / Cmd+S: Save
      if (isCmdOrCtrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveActiveNote(true);
        showToast('Saved & Synced', 'info', 1500);
        return;
      }

      // Ctrl+N / Cmd+N: New Note
      if (isCmdOrCtrl && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        this.createNewNote();
        return;
      }

      // Ctrl+P / Cmd+P: Toggle Preview mode
      if (isCmdOrCtrl && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        const next = this.viewMode === 'preview' ? 'split' : 'preview';
        this.setViewMode(next);
        return;
      }

      // Ctrl+Shift+I / Cmd+Shift+I: Attach Picture
      if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        this.openImageModal();
        return;
      }

      // Escape: Close modals
      if (e.key === 'Escape') {
        this.closeRoomModal();
        this.closeMobileSidebar();
        this.closeImageModal();
        this.lightbox.close();
      }
    });
  }

  bindMarkdownToolbar() {
    const textarea = this.dom.noteContentTextarea;
    const toolbar = document.getElementById('markdown-toolbar');
    if (!toolbar || !textarea) return;

    const actions = {
      bold: () => insertMarkdownSyntax(textarea, '**', '**', 'bold text'),
      italic: () => insertMarkdownSyntax(textarea, '*', '*', 'italic text'),
      strike: () => insertMarkdownSyntax(textarea, '~~', '~~', 'strikethrough text'),
      h1: () => insertMarkdownSyntax(textarea, '# ', '', 'Heading 1'),
      h2: () => insertMarkdownSyntax(textarea, '## ', '', 'Heading 2'),
      h3: () => insertMarkdownSyntax(textarea, '### ', '', 'Heading 3'),
      quote: () => insertMarkdownSyntax(textarea, '> ', '', 'quote'),
      code: () => insertMarkdownSyntax(textarea, '`', '`', 'code'),
      codeblock: () => insertMarkdownSyntax(textarea, '```javascript\n', '\n```', '// your code here'),
      ul: () => insertMarkdownSyntax(textarea, '- ', '', 'list item'),
      ol: () => insertMarkdownSyntax(textarea, '1. ', '', 'first item'),
      task: () => insertMarkdownSyntax(textarea, '- [ ] ', '', 'task item'),
      link: async () => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selected = textarea.value.substring(start, end).trim();

        // If selected text is already a URL, wrap it with [Link](url)
        if (/^https?:\/\//i.test(selected)) {
          insertMarkdownSyntax(textarea, '[Link](', ')', '');
          return;
        }

        let clipboardUrl = '';
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          try {
            const clip = (await navigator.clipboard.readText()).trim();
            if (/^https?:\/\//i.test(clip)) {
              clipboardUrl = clip;
            }
          } catch (_) {}
        }

        if (clipboardUrl) {
          const label = selected || 'link';
          insertMarkdownSyntax(textarea, `[${label}](`, `)`, clipboardUrl);
          return;
        }

        // If no clipboard URL, open Web URL modal with selected text as caption
        this.openImageModal('url');
        if (selected && this.dom.inputImageWebCaption) {
          this.dom.inputImageWebCaption.value = selected;
        }
      },
      image: () => this.openImageModal(),
      hr: () => insertMarkdownSyntax(textarea, '\n---\n', '', '')
    };

    toolbar.querySelectorAll('button[data-format]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!this.activeNote) {
          await this.createNewNote();
        }
        const action = btn.getAttribute('data-format');
        if (actions[action]) {
          await actions[action]();
          this.handleEditorInput();
        }
      });
    });
  }
}

// Service worker registration
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.log('SW registration note:', err.message);
    });
  });
}

// Bootstrap
function startApp() {
  const app = new SyncPadApp();
  app.init().catch((err) => {
    console.error('Failed to initialize SyncPad:', err);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
