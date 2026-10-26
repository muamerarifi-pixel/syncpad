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

class SyncPadApp {
  constructor() {
    this.activeNote = null;
    this.allNotes = [];
    this.searchQuery = '';
    this.activeTag = null;
    this.viewMode = 'split'; // 'split' | 'edit' | 'preview'
    this.saveDebounceTimer = null;
    this.theme = 'dark';

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
      
      // Theme
      themeToggleBtn: document.getElementById('btn-toggle-theme')
    };

    window.__syncpadApp = this;
  }

  async init() {
    // 1. Unconditionally bind DOM events, keyboard shortcuts, and toolbar first
    // so all buttons and UI interactions are responsive immediately
    this.bindEvents();
    this.bindKeyboardShortcuts();
    this.bindMarkdownToolbar();

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
      renderPreview(this.dom.noteContentTextarea.value, this.dom.markdownPreview);
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

    // Update preview
    renderPreview(note.content || '', this.dom.markdownPreview);

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
    if (this.dom.markdownPreview) renderPreview(contentValue, this.dom.markdownPreview);
    updateWordStats(contentValue);

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
    }
  }

  closeRoomModal() {
    if (this.dom.roomModal) {
      this.dom.roomModal.classList.remove('open');
    }
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
    if (this.dom.copyMdBtn) {
      this.dom.copyMdBtn.addEventListener('click', async () => {
        if (!this.activeNote) {
          showToast('No note selected to copy', 'info');
          return;
        }
        try {
          await navigator.clipboard.writeText(this.activeNote.content || '');
          showToast('Markdown copied to clipboard!', 'success', 2000);
        } catch (_) {
          showToast('Failed to copy', 'error');
        }
      });
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

      // Escape: Close modals
      if (e.key === 'Escape') {
        this.closeRoomModal();
        this.closeMobileSidebar();
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
      table: () => insertMarkdownSyntax(textarea, '\n| Column 1 | Column 2 |\n| --- | --- |\n| Item 1 | Item 2 |\n', '', ''),
      link: () => insertMarkdownSyntax(textarea, '[', '](https://example.com)', 'link text'),
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
          actions[action]();
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
