import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 8788;
const CHROME_PORT = 9223;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = path.resolve('scratch-chrome-profile-' + Date.now());

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json'
};

// 1. Static HTTP Server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  
  if (url.pathname === '/api/room') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ roomCode: 'E2E-TEST' }));
    return;
  }
  if (url.pathname === '/api/sync') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ notes: [], version: 1 }));
    return;
  }
  if (url.pathname === '/api/link-metadata') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const target = url.searchParams.get('url') || '';
    if (target.includes('github.com')) {
      res.end(JSON.stringify({
        status: 'ok',
        url: target,
        isImage: false,
        title: 'SyncPad GitHub Repository',
        description: 'Real-time cross-device notes and markdown editor.',
        image: 'https://images.unsplash.com/photo-test.jpg',
        siteName: 'github.com'
      }));
    } else {
      res.end(JSON.stringify({
        status: 'ok',
        url: target,
        isImage: true,
        title: 'sample-photo',
        image: target
      }));
    }
    return;
  }
  if (url.pathname === '/api/proxy') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Access-Control-Allow-Origin': '*'
    });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>');
    return;
  }

  let filePath = path.join(process.cwd(), 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

async function main() {
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`Server listening at http://127.0.0.1:${PORT}`);

  // 2. Launch Chrome Headless
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CHROME_PORT}`,
    '--headless=new',
    '--no-first-run',
    '--disable-extensions',
    '--disable-gpu',
    '--disable-features=IsolateOrigins,site-per-process',
    `--user-data-dir=${USER_DATA_DIR}`,
    'about:blank'
  ]);

  try {
    // Wait for Chrome remote debugging endpoint
    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const resp = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`);
        const list = await resp.json();
        const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch (_) {}
    }

    if (!wsUrl) {
      throw new Error('Failed to obtain WebSocket URL from Chrome');
    }

    console.log('Connected to Chrome CDP:', wsUrl);

    // 3. Connect via WebSocket
    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const pending = new Map();
    const consoleErrors = [];

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map(a => a.value || a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params.exceptionDetails.text);
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    function sendCommand(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function evaluate(expression) {
      const res = await sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.text || 'Evaluation failed');
      }
      return res.result.value;
    }

    await sendCommand('Page.enable');
    await sendCommand('Runtime.enable');
    await sendCommand('Network.enable');
    await sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
    await sendCommand('Network.clearBrowserCache');

    // Set Desktop viewport (1280x800)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });

    console.log('Navigating to SyncPad...');
    await sendCommand('Page.navigate', { url: `http://127.0.0.1:${PORT}` });
    
    // Robust wait for DOM ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 150));
      const ready = await evaluate(`Boolean(document.querySelector('.brand-logo-premium'))`).catch(() => false);
      if (ready) break;
    }

    // TEST 1: Premium Logo check
    const logoRendered = await evaluate(`
      (() => {
        const logo = document.querySelector('.brand-logo-premium');
        const sidebar = document.getElementById('sidebar');
        return {
          exists: Boolean(logo),
          offsetWidth: logo ? logo.offsetWidth : -1,
          offsetHeight: logo ? logo.offsetHeight : -1,
          sidebarWidth: sidebar ? sidebar.offsetWidth : -1,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight
        };
      })()
    `);
    console.log('Premium logo details:', logoRendered);
    if (!logoRendered.exists) throw new Error('Premium logo not found');

    // TEST 2: Command Ribbon Buttons exist on desktop
    const ribbonCheck = await evaluate(`
      (() => {
        const paste = document.getElementById('btn-quick-paste');
        const photo = document.getElementById('btn-quick-photo');
        const copy = document.getElementById('btn-copy-md');
        const toggleTools = document.getElementById('btn-toggle-tools');
        return {
          paste: Boolean(paste && paste.offsetWidth > 0),
          photo: Boolean(photo && photo.offsetWidth > 0),
          copy: Boolean(copy && copy.offsetWidth > 0),
          toggleTools: Boolean(toggleTools && toggleTools.offsetWidth > 0)
        };
      })()
    `);
    console.log('✓ Desktop Ribbon buttons:', ribbonCheck);
    if (!ribbonCheck.paste || !ribbonCheck.copy) throw new Error('Ribbon buttons missing');

    // TEST 3: Detected Link Banner Auto-Detection
    const detectedLinksResult = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        if (!app) return { error: 'App not initialized' };
        
        // Input text with a URL
        app.dom.noteContentTextarea.value = "Check out this project: https://github.com/muamerarifi-pixel/syncpad for real-time syncing!";
        await app.handleEditorInput();

        const bar = document.getElementById('detected-links-bar');
        const chips = bar ? bar.querySelectorAll('.detected-link-chip') : [];
        const openBtn = bar ? bar.querySelector('.link-chip-btn') : null;
        
        return {
          barVisible: bar ? bar.style.display !== 'none' : false,
          chipsCount: chips.length,
          chipText: chips[0] ? chips[0].innerText : '',
          openBtnText: openBtn ? openBtn.innerText : ''
        };
      })()
    `);
    console.log('✓ Detected links banner:', detectedLinksResult);
    if (!detectedLinksResult.barVisible || detectedLinksResult.chipsCount === 0) {
      throw new Error('Detected links banner did not appear');
    }

    // TEST 4: Quick Copy visual feedback & functional copy
    const quickCopyFeedback = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        let copiedText = '';
        if (!navigator.clipboard) navigator.clipboard = {};
        navigator.clipboard.writeText = async (txt) => { copiedText = txt; return true; };
        
        await app.handleQuickCopyAll();
        const label = document.getElementById('btn-copy-md-label');
        return {
          copiedText,
          label: label ? label.textContent : '',
          hasCopiedClass: app.dom.copyMdBtn ? app.dom.copyMdBtn.classList.contains('copied') : false
        };
      })()
    `);
    console.log('✓ 1-Tap Copy feedback:', quickCopyFeedback);
    if (!quickCopyFeedback.label.includes('Copied') || !quickCopyFeedback.hasCopiedClass) {
      throw new Error('Copy feedback failed');
    }
    if (!quickCopyFeedback.copiedText.includes('github.com')) {
      throw new Error('Copy content failed');
    }

    // TEST 4b: Quick Paste functional test
    const quickPasteResult = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        navigator.clipboard.readText = async () => 'https://example.com/shared-link';
        await app.handleQuickPaste();
        return {
          content: app.dom.noteContentTextarea.value,
          includesPasted: app.dom.noteContentTextarea.value.includes('https://example.com/shared-link')
        };
      })()
    `);
    console.log('✓ 1-Tap Paste functional test:', quickPasteResult);
    if (!quickPasteResult.includesPasted) {
      throw new Error('Quick paste failed');
    }

    // TEST 5: QR Code in Room Modal
    const qrModalCheck = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        app.openRoomModal();
        const qrBox = document.getElementById('modal-qr-code');
        const svg = qrBox ? qrBox.querySelector('svg') : null;
        const rects = svg ? svg.querySelectorAll('rect') : [];
        return {
          modalOpen: app.dom.roomModal.classList.contains('open'),
          hasSvg: Boolean(svg),
          rectCount: rects.length
        };
      })()
    `);
    console.log('✓ QR Code in room modal:', qrModalCheck);
    if (!qrModalCheck.modalOpen || !qrModalCheck.hasSvg || qrModalCheck.rectCount < 10) {
      throw new Error('QR code modal failed');
    }

    // TEST 6: Formatting Toolbar Toggle
    const toolbarToggleCheck = await evaluate(`
      (() => {
        const app = window.__syncpadApp;
        const tb = document.getElementById('markdown-toolbar');
        const initialHidden = tb.classList.contains('hidden');
        app.toggleMarkdownToolbar();
        const toggledHidden = tb.classList.contains('hidden');
        app.toggleMarkdownToolbar(); // toggle back
        return { initialHidden, toggledHidden };
      })()
    `);
    console.log('✓ Toolbar toggle:', toolbarToggleCheck);
    if (toolbarToggleCheck.initialHidden === toolbarToggleCheck.toggledHidden) {
      throw new Error('Toolbar toggle failed');
    }

    // TEST 7: Mobile Viewport & Bottom Action Dock (375x667)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    });
    await new Promise(r => setTimeout(r, 400));

    const mobileDockCheck = await evaluate(`
      (() => {
        const dock = document.querySelector('.mobile-bottom-dock');
        const pasteBtn = document.getElementById('m-btn-quick-paste');
        const photoBtn = document.getElementById('m-btn-quick-photo');
        const copyBtn = document.getElementById('m-btn-quick-copy');
        const newBtn = document.getElementById('m-btn-new-note');
        const roomBtn = document.getElementById('m-btn-room');

        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
        };

        return {
          dockVisible: isVisible(dock),
          pasteVisible: isVisible(pasteBtn),
          photoVisible: isVisible(photoBtn),
          copyVisible: isVisible(copyBtn),
          newVisible: isVisible(newBtn),
          roomVisible: isVisible(roomBtn)
        };
      })()
    `);
    console.log('✓ Mobile bottom dock check (375px viewport):', mobileDockCheck);
    if (!mobileDockCheck.dockVisible || !mobileDockCheck.pasteVisible || !mobileDockCheck.copyVisible) {
      throw new Error('Mobile bottom dock not visible on mobile');
    }

    // TEST 8: Web URL / Website Link Import in Attach Picture Modal
    const webUrlImageTest = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        app.openImageModal();
        app.switchImageTab('url');

        const tabUrlPane = document.getElementById('tab-pane-image-url');
        const inputUrl = document.getElementById('input-image-web-url');
        const confirmBtn = document.getElementById('btn-confirm-insert-url');
        const previewContainer = document.getElementById('web-image-preview-container');

        // Input an HTTP image URL served by our test server
        const testImgUrl = window.location.origin + '/icons/icon-192.svg';
        inputUrl.value = testImgUrl;
        await app.inspectWebUrl();

        const previewVisible = previewContainer && previewContainer.style.display !== 'none';
        const buttonEnabled = confirmBtn && !confirmBtn.disabled;
        const buttonText = confirmBtn ? confirmBtn.textContent : '';

        // Click Insert Image
        await app.attachWebImage();

        const content = app.dom.noteContentTextarea.value;
        const modalClosed = !app.dom.imageModal.classList.contains('open');

        return {
          paneVisible: tabUrlPane.style.display !== 'none',
          previewVisible,
          buttonEnabled,
          buttonText,
          modalClosed,
          contentHasImage: content.includes('icon-192.svg')
        };
      })()
    `);
    console.log('✓ Web URL Image Import test:', webUrlImageTest);
    if (!webUrlImageTest.paneVisible || !webUrlImageTest.previewVisible || !webUrlImageTest.contentHasImage) {
      throw new Error('Web URL Image import failed: ' + JSON.stringify(webUrlImageTest));
    }

    // TEST 9: Website Link Metadata Preview & Bookmark Insertion
    const websiteLinkTest = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        app.openImageModal();
        app.switchImageTab('url');

        const inputUrl = document.getElementById('input-image-web-url');
        inputUrl.value = 'https://github.com/muamerarifi-pixel/syncpad';
        await app.inspectWebUrl();

        const metaCard = document.getElementById('web-link-meta-card');
        const metaTitle = document.getElementById('web-meta-title');
        const btnBookmark = document.getElementById('btn-insert-web-bookmark');
        const captionInput = document.getElementById('input-image-web-caption');

        const metaCardVisible = metaCard && metaCard.style.display !== 'none';
        const extractedTitle = metaTitle ? metaTitle.textContent : '';
        const captionVal = captionInput ? captionInput.value : '';
        const bookmarkVisible = btnBookmark && btnBookmark.style.display !== 'none';

        // Insert as Bookmark
        app.insertWebBookmark();

        const content = app.dom.noteContentTextarea.value;
        const hasBookmark = content.includes('SyncPad GitHub Repository') && content.includes('github.com/muamerarifi-pixel/syncpad');

        return {
          metaCardVisible,
          extractedTitle,
          captionVal,
          bookmarkVisible,
          hasBookmark
        };
      })()
    `);
    console.log('✓ Website Link Metadata Import test:', websiteLinkTest);
    if (!websiteLinkTest.metaCardVisible || !websiteLinkTest.hasBookmark) {
      throw new Error('Website link metadata import failed: ' + JSON.stringify(websiteLinkTest));
    }

    // TEST 10: Invalid Web URL error handling
    const invalidUrlTest = await evaluate(`
      (async () => {
        const app = window.__syncpadApp;
        app.openImageModal();
        app.switchImageTab('url');

        const inputUrl = document.getElementById('input-image-web-url');
        inputUrl.value = 'not-a-valid-url';
        await app.inspectWebUrl();

        const statusEl = document.getElementById('web-url-status');
        const confirmBtn = document.getElementById('btn-confirm-insert-url');
        const previewContainer = document.getElementById('web-image-preview-container');

        const hasError = statusEl && statusEl.classList.contains('error') && statusEl.style.display !== 'none';
        const buttonDisabled = confirmBtn ? confirmBtn.disabled : false;
        const previewHidden = !previewContainer || previewContainer.style.display === 'none';

        app.closeImageModal();

        return {
          hasError,
          buttonDisabled,
          previewHidden
        };
      })()
    `);
    console.log('✓ Invalid URL Error feedback test:', invalidUrlTest);
    if (!invalidUrlTest.hasError || !invalidUrlTest.buttonDisabled || !invalidUrlTest.previewHidden) {
      throw new Error('Invalid URL handling failed: ' + JSON.stringify(invalidUrlTest));
    }

    // TEST 11: Console Errors check
    console.log('Console errors encountered:', consoleErrors);
    if (consoleErrors.length > 0) {
      throw new Error('Console errors encountered during testing: ' + consoleErrors.join('; '));
    }

    console.log('\n=======================================');
    console.log('ALL E2E BROWSER TESTS PASSED PERFECTLY!');
    console.log('=======================================\n');

    ws.close();
  } finally {
    chrome.kill();
    server.close();
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch(err => {
  console.error('E2E TEST FAILURE:', err);
  process.exit(1);
});
