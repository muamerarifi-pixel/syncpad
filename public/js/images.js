/**
 * SyncPad Image Processing, Attachment & Lightbox Module
 * Provides client-side compression (WebP/JPEG), drag-and-drop, clipboard paste, and modal handling.
 */

import { showToast } from './ui.js';

/**
 * Compress and read image file to a lightweight data URL
 * Scales down large camera/screenshot images to max dimensions preserving aspect ratio.
 *
 * @param {File|Blob} file
 * @param {object} options
 * @returns {Promise<{ dataUrl: string, name: string, width: number, height: number, size: number }>}
 */
export async function compressImage(file, options = {}) {
  const maxWidth = options.maxWidth || 1400;
  const maxHeight = options.maxHeight || 1400;
  const quality = options.quality !== undefined ? options.quality : 0.82;

  // SVG images do not need canvas rasterization
  if (file.type === 'image/svg+xml') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          dataUrl: reader.result,
          name: file.name || 'vector.svg',
          width: 0,
          height: 0,
          size: file.size
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Small GIFs (< 400KB) preserve animation
  if (file.type === 'image/gif' && file.size < 400 * 1024) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          dataUrl: reader.result,
          name: file.name || 'animation.gif',
          width: 0,
          height: 0,
          size: file.size
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load image for compression'));
      el.src = objectUrl;
    });

    let { width, height } = img;

    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context not available');
    }

    // High quality scaling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, width, height);

    // Try WebP first for optimal compression
    let dataUrl = canvas.toDataURL('image/webp', quality);
    if (!dataUrl.startsWith('data:image/webp')) {
      // Fallback to JPEG if WebP is not supported by device canvas
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    const approxSize = Math.round((dataUrl.length * 3) / 4);

    return {
      dataUrl,
      name: file.name || 'image.webp',
      width,
      height,
      size: approxSize
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Format bytes to readable string (e.g. "45.2 KB")
 */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Insert an image Markdown tag into the given textarea at cursor or end
 */
export function insertImageMarkdown(textarea, alt, url) {
  if (!textarea) return;

  const cleanAlt = (alt || 'Image').replace(/[\[\]]/g, '').trim();
  const markdownTag = `\n\n![${cleanAlt}](${url})\n\n`;

  const start = textarea.selectionStart !== undefined ? textarea.selectionStart : textarea.value.length;
  const end = textarea.selectionEnd !== undefined ? textarea.selectionEnd : start;

  const currentVal = textarea.value;
  const before = currentVal.substring(0, start);
  const after = currentVal.substring(end);

  textarea.value = before + markdownTag + after;

  const newPos = start + markdownTag.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();

  // Dispatch input event to trigger auto-save and preview update
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Insert a clean image attachment tag into the textarea
 */
export function insertImagePlaceholder(textarea, alt, imageId) {
  if (!textarea) return;
  const cleanAlt = (alt || 'Picture').replace(/[\[\]]/g, '').trim();
  const tag = `\n\n![${cleanAlt}](attachment:${imageId})\n\n`;

  const start = textarea.selectionStart !== undefined ? textarea.selectionStart : textarea.value.length;
  const end = textarea.selectionEnd !== undefined ? textarea.selectionEnd : start;

  const currentVal = textarea.value;
  const before = currentVal.substring(0, start);
  const after = currentVal.substring(end);

  textarea.value = before + tag + after;

  const newPos = start + tag.length;
  textarea.setSelectionRange(newPos, newPos);
  textarea.focus();

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Copy an image Data URL to the system clipboard as a binary image
 */
export async function copyImageDataUrlToClipboard(dataUrl) {
  if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
    throw new Error('Clipboard image copying is not supported by your browser');
  }

  // Convert to PNG blob via canvas for universal clipboard compatibility
  const blob = await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to create PNG blob'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Failed to load image for clipboard copy'));
    img.src = dataUrl;
  });

  const item = new ClipboardItem({ 'image/png': blob });
  await navigator.clipboard.write([item]);
}

/**
 * Scan note content for inline raw base64 data URLs, extract them to note.images,
 * and replace the 50,000-char string with a clean attachment tag.
 */
export function extractAndMigrateNoteImages(note) {
  if (!note) return false;
  if (!Array.isArray(note.images)) note.images = [];
  let modified = false;

  if (note.content && typeof note.content === 'string') {
    const regex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/g;
    let match;
    const replacements = [];

    while ((match = regex.exec(note.content)) !== null) {
      const fullMatch = match[0];
      const alt = (match[1] || 'Picture').trim();
      const dataUrl = match[2];
      const imageId = 'img-' + (note.images.length + 1);

      let existing = note.images.find(img => img.dataUrl === dataUrl);
      if (!existing) {
        existing = {
          id: imageId,
          name: alt || 'Picture',
          dataUrl,
          size: Math.round((dataUrl.length * 3) / 4),
          createdAt: Date.now()
        };
        note.images.push(existing);
      }

      replacements.push({
        from: fullMatch,
        to: `![${existing.name}](attachment:${existing.id})`
      });
      modified = true;
    }

    for (const rep of replacements) {
      note.content = note.content.replaceAll(rep.from, rep.to);
    }
  }

  return modified;
}

/**
 * Render visual picture cards into the attached-images-strip
 */
export function renderAttachedImagesStrip({
  container,
  images = [],
  onCopyImage,
  onDownloadImage,
  onZoomImage,
  onRemoveImage
}) {
  if (!container) return;

  if (!images || images.length === 0) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '';
  container.style.display = 'flex';

  const header = document.createElement('div');
  header.className = 'attachment-strip-header';
  header.innerHTML = `
    <span class="attachment-strip-title">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <polyline points="21 15 16 10 5 21"></polyline>
      </svg>
      <span>Attached Pictures (${images.length})</span>
    </span>
    <span class="attachment-strip-hint">Tap picture to zoom • 1-tap copy to clipboard</span>
  `;
  container.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'attachment-cards-grid';

  images.forEach((img, idx) => {
    const card = document.createElement('div');
    card.className = 'attachment-card';

    // Thumbnail
    const thumbWrapper = document.createElement('div');
    thumbWrapper.className = 'attachment-thumb-wrapper';
    thumbWrapper.title = 'Click to zoom picture';
    thumbWrapper.addEventListener('click', () => {
      if (onZoomImage) onZoomImage(img.dataUrl, img.name);
    });

    const imgEl = document.createElement('img');
    imgEl.className = 'attachment-thumb-img';
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name || 'Attached Picture';
    imgEl.loading = 'lazy';
    thumbWrapper.appendChild(imgEl);

    // Meta details
    const info = document.createElement('div');
    info.className = 'attachment-info';

    const name = document.createElement('div');
    name.className = 'attachment-name';
    name.textContent = img.name || `Photo ${idx + 1}`;
    name.title = img.name || '';

    const size = document.createElement('div');
    size.className = 'attachment-size';
    size.textContent = formatBytes(img.size || 0);

    info.appendChild(name);
    info.appendChild(size);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'attachment-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'attachment-btn btn-copy-image';
    copyBtn.title = 'Copy image to clipboard (paste into WhatsApp, Word, etc.)';
    copyBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy Image</span>
    `;
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = copyBtn.querySelector('span');
      const origText = label ? label.textContent : 'Copy Image';
      try {
        await onCopyImage(img.dataUrl);
        if (label) label.textContent = 'Copied! ✓';
        copyBtn.classList.add('copied');
        showToast('Image copied to clipboard! 🖼️📋', 'success', 2000);
        setTimeout(() => {
          if (label) label.textContent = origText;
          copyBtn.classList.remove('copied');
        }, 1800);
      } catch (err) {
        console.error('Failed to copy image:', err);
        showToast('Failed to copy image directly', 'error');
      }
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'attachment-btn btn-icon-only';
    downloadBtn.title = 'Download picture';
    downloadBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
    `;
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onDownloadImage) onDownloadImage(img.dataUrl, img.name);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'attachment-btn btn-icon-only btn-danger';
    deleteBtn.title = 'Remove picture';
    deleteBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onRemoveImage) onRemoveImage(img.id, idx);
    });

    actions.appendChild(copyBtn);
    actions.appendChild(downloadBtn);
    actions.appendChild(deleteBtn);

    card.appendChild(thumbWrapper);
    card.appendChild(info);
    card.appendChild(actions);

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

/**
 * Lightbox Manager for zooming and previewing attached images
 */
export class LightboxViewer {
  constructor() {
    this.modal = document.getElementById('lightbox-modal');
    this.imgEl = document.getElementById('lightbox-image');
    this.captionEl = document.getElementById('lightbox-caption');
    this.closeBtn = document.getElementById('btn-close-lightbox');
    this.downloadBtn = document.getElementById('btn-download-lightbox');
    this.currentSrc = '';
    this.currentAlt = '';

    this.bindEvents();
  }

  bindEvents() {
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.close());
    }

    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.close();
      });
    }

    if (this.downloadBtn) {
      this.downloadBtn.addEventListener('click', () => {
        if (!this.currentSrc) return;
        const a = document.createElement('a');
        a.href = this.currentSrc;
        const ext = this.currentSrc.startsWith('data:image/webp') ? 'webp' : 'png';
        a.download = `${(this.currentAlt || 'syncpad-image').replace(/[^a-z0-9_-]/gi, '_')}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast('Image download started', 'info', 1800);
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.close();
      }
    });
  }

  isOpen() {
    return Boolean(this.modal && this.modal.classList.contains('open'));
  }

  open(src, alt = '') {
    if (!this.modal || !this.imgEl) return;
    this.currentSrc = src;
    this.currentAlt = alt;

    this.imgEl.src = src;
    this.imgEl.alt = alt;

    if (this.captionEl) {
      this.captionEl.textContent = alt || '';
      this.captionEl.style.display = alt ? 'block' : 'none';
    }

    this.modal.classList.add('open');
  }

  close() {
    if (this.modal) {
      this.modal.classList.remove('open');
      if (this.imgEl) this.imgEl.src = '';
    }
  }
}
