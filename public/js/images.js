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
