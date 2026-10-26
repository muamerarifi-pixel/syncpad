/**
 * SyncPad UI Rendering & Interaction Module
 * Clean, reactive DOM helpers for notes, live markdown preview, stats, modals, and toasts.
 */

import { parseMarkdown, getWordStats, extractExcerpt } from './markdown.js';

export function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 45) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Toast Notification Manager
 */
export function showToast(message, type = 'info', duration = 2800) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  const removeToast = () => {
    toast.classList.add('toast-fade-out');
    toast.addEventListener('animationend', () => {
      if (toast.parentElement) toast.remove();
    }, { once: true });
  };

  closeBtn.addEventListener('click', removeToast);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(removeToast, duration);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render Notes List in Sidebar
 */
export function renderNotesList({
  notes,
  activeNoteId,
  onSelectNote,
  onTogglePin,
  onDeleteNote
}) {
  const container = document.getElementById('notes-list');
  if (!container) return;

  if (notes.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
        <p class="empty-state-title">No notes found</p>
        <p class="empty-state-subtitle">Create a note or adjust your search filter</p>
      </div>
    `;
    return;
  }

  const pinnedNotes = notes.filter((n) => n.pinned);
  const regularNotes = notes.filter((n) => !n.pinned);

  let html = '';

  const renderCard = (note) => {
    const isActive = note.id === activeNoteId;
    const excerpt = extractExcerpt(note.content, 90) || 'Empty note…';
    const timeFormatted = formatRelativeTime(note.updatedAt);
    const tagsHtml = (note.tags || [])
      .map((tag) => `<span class="note-card-tag">#${escapeHtml(tag)}</span>`)
      .join('');

    return `
      <div class="note-card ${isActive ? 'active' : ''} ${note.pinned ? 'pinned' : ''}" data-id="${note.id}" tabindex="0" role="button">
        <div class="note-card-header">
          <h4 class="note-card-title">${escapeHtml(note.title || 'Untitled Note')}</h4>
          <div class="note-card-actions">
            <button class="icon-btn btn-pin ${note.pinned ? 'is-pinned' : ''}" title="${note.pinned ? 'Unpin' : 'Pin'}" data-action="pin" data-id="${note.id}" aria-label="Toggle pin">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="${note.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path>
              </svg>
            </button>
            <button class="icon-btn btn-delete" title="Delete note" data-action="delete" data-id="${note.id}" aria-label="Delete note">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
        <p class="note-card-excerpt">${escapeHtml(excerpt)}</p>
        <div class="note-card-footer">
          <span class="note-card-time">${timeFormatted}</span>
          ${tagsHtml ? `<div class="note-card-tags">${tagsHtml}</div>` : ''}
        </div>
      </div>
    `;
  };

  if (pinnedNotes.length > 0) {
    html += `
      <div class="notes-section-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
        <span>Pinned</span>
      </div>
      <div class="notes-group pinned-group">
        ${pinnedNotes.map(renderCard).join('')}
      </div>
    `;
  }

  if (regularNotes.length > 0) {
    if (pinnedNotes.length > 0) {
      html += `
        <div class="notes-section-title">
          <span>All Notes</span>
        </div>
      `;
    }
    html += `
      <div class="notes-group regular-group">
        ${regularNotes.map(renderCard).join('')}
      </div>
    `;
  }

  const previousScrollTop = container.scrollTop;
  container.innerHTML = html;
  container.scrollTop = previousScrollTop;

  // Bind clicks
  container.querySelectorAll('.note-card').forEach((card) => {
    const id = card.getAttribute('data-id');

    card.addEventListener('click', (e) => {
      const target = e.target.closest('button');
      if (target) {
        const action = target.getAttribute('data-action');
        if (action === 'pin') {
          e.stopPropagation();
          onTogglePin(id);
          return;
        }
        if (action === 'delete') {
          e.stopPropagation();
          onDeleteNote(id);
          return;
        }
      }
      onSelectNote(id);
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectNote(id);
      }
    });
  });
}

/**
 * Render Tag Filter Chips in Sidebar
 */
export function renderTagChips({ tags, activeTag, onSelectTag }) {
  const container = document.getElementById('tag-chips');
  if (!container) return;

  if (!tags || tags.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <button class="tag-chip ${!activeTag ? 'active' : ''}" data-tag="">
      <span>All</span>
    </button>
  `;

  for (const tag of tags) {
    const isSelected = activeTag === tag;
    html += `
      <button class="tag-chip ${isSelected ? 'active' : ''}" data-tag="${escapeHtml(tag)}">
        <span>#${escapeHtml(tag)}</span>
      </button>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.getAttribute('data-tag') || null;
      onSelectTag(tag);
    });
  });
}

/**
 * Update Editor Word and Reading Statistics
 */
export function updateWordStats(content) {
  const stats = getWordStats(content);
  const statsElem = document.getElementById('editor-stats');
  if (!statsElem) return;

  statsElem.innerHTML = `
    <span><strong>${stats.words}</strong> ${stats.words === 1 ? 'word' : 'words'}</span>
    <span class="dot-sep">&middot;</span>
    <span><strong>${stats.chars}</strong> chars</span>
    <span class="dot-sep">&middot;</span>
    <span><strong>${stats.lines}</strong> ${stats.lines === 1 ? 'line' : 'lines'}</span>
    <span class="dot-sep">&middot;</span>
    <span>~<strong>${stats.readingTimeMinutes}</strong> min read</span>
  `;
}

/**
 * Render Markdown Preview
 */
export function renderPreview(content, previewElem) {
  if (!previewElem) return;
  const html = parseMarkdown(content || '*No content yet. Start typing to see live preview…*');
  previewElem.innerHTML = html;

  // Bind copy buttons inside code blocks
  previewElem.querySelectorAll('.copy-code-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const codeBlock = btn.closest('.code-block-wrapper')?.querySelector('code');
      const code = codeBlock ? codeBlock.textContent : btn.getAttribute('data-code');
      if (code) {
        try {
          await navigator.clipboard.writeText(code);
          const orig = btn.innerHTML;
          btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>Copied!</span>
          `;
          btn.classList.add('copied');
          setTimeout(() => {
            btn.innerHTML = orig;
            btn.classList.remove('copied');
          }, 1800);
        } catch (_) {
          showToast('Failed to copy to clipboard', 'error');
        }
      }
    });
  });
}

/**
 * Insert or wrap text in textarea at current selection
 */
export function insertMarkdownSyntax(textarea, prefix, suffix = '', placeholder = '') {
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const original = textarea.value;
  const selectedText = original.substring(start, end);

  const replacement = selectedText
    ? `${prefix}${selectedText}${suffix}`
    : `${prefix}${placeholder}${suffix}`;

  textarea.value = original.substring(0, start) + replacement + original.substring(end);

  const newCursorPos = selectedText
    ? start + replacement.length
    : start + prefix.length + placeholder.length;

  textarea.focus();
  textarea.setSelectionRange(
    selectedText ? newCursorPos : start + prefix.length,
    newCursorPos
  );

  // Trigger input event for auto-save and preview updates
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
