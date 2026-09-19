// electron/main.cjs  — CommonJS wrapper (avoids "type":"module" conflict)
'use strict';

const { app, BrowserWindow, shell, session, protocol, desktopCapturer } = require('electron');
const path = require('path');
const fs   = require('fs');
const url  = require('url');

// ── Single-instance lock ──────────────────────────────────────────────────────
let mainWindow = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Custom protocol: waifutxt:// ──────────────────────────────────────────────
// Serves dist/ with correct MIME types, including application/wasm for E2EE.
// Must be registered before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'waifutxt',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
      corsEnabled: false,
    },
  },
]);

const DIST = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html':  'text/html',
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.cjs':   'application/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.wasm':  'application/wasm',   // ← required for matrix-sdk-crypto-wasm
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.webp':  'image/webp',
  '.ttf':   'font/ttf',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.mp3':   'audio/mpeg',
  '.ogg':   'audio/ogg',
  '.mp4':   'video/mp4',
  '.webm':  'video/webm',
  '.txt':   'text/plain',
  '.xml':   'application/xml',
};

function resolveFile(reqPath) {
  // strip query / hash
  const clean = reqPath.split('?')[0].split('#')[0];
  const abs   = path.join(DIST, clean);

  // exact match
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;

  // SPA fallback — all unknown paths serve index.html
  const idx = path.join(DIST, 'index.html');
  if (fs.existsSync(idx)) return idx;

  return null;
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.setName('WaifuTxT_');

  // Register waifutxt:// protocol handler
  protocol.handle('waifutxt', (request) => {
    const parsed  = new URL(request.url);
    const reqPath = decodeURIComponent(parsed.pathname);
    const file    = resolveFile(reqPath);

    if (!file) {
      return new Response('Not found', { status: 404 });
    }

    const ext  = path.extname(file).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(file);

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mime,
        // Allow SharedArrayBuffer (needed by wasm crypto in some builds)
        'Cross-Origin-Opener-Policy':   'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    });
  });

  // Permissions: allow mic + notifications (voice messages, voice rooms, notifs)
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(['media', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(perm));
  });

  // Screen share (getDisplayMedia) needs a source picker in Electron.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
      });
      const source = await pickDisplaySource(sources);
      if (!source) return callback({});
      // System audio capture is only available on Windows.
      callback(process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
    } catch (err) {
      console.error('[screen-share] source selection failed', err);
      callback({});
    }
  });

  createWindow();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Modal picker for screen share sources. The page reports the choice through its title so no
// preload/IPC bridge is needed: "pick:<index>" or "cancel".
function pickDisplaySource(sources) {
  return new Promise((resolve) => {
    if (sources.length === 0) return resolve(null);

    const items = sources.map((s, i) => `
      <button data-i="${i}" title="${escapeHtml(s.name)}">
        <img src="${s.thumbnail.toDataURL()}" alt="">
        <span>${escapeHtml(s.name)}</span>
      </button>`).join('');
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>picker</title><style>
      :root { color-scheme: dark; }
      body { margin: 0; font: 13px system-ui, sans-serif; background: #0b0b12; color: #e8e8f0; }
      header { padding: 14px 16px 6px; font-size: 15px; font-weight: 600; }
      main { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; padding: 10px 16px; }
      button { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 10px; background: #16161f; border: 2px solid transparent; }
      button:hover, button:focus-visible { border-color: #ff2d78; }
      img { width: 100%; aspect-ratio: 16/9; object-fit: contain; background: #000; border-radius: 6px; }
      span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      footer { position: sticky; bottom: 0; display: flex; justify-content: flex-end; padding: 10px 16px; background: #0b0b12; }
      #cancel { padding: 6px 14px; background: #262633; }
    </style></head><body>
      <header>Choisis ce que tu veux partager</header>
      <main>${items}</main>
      <footer><button id="cancel">Annuler</button></footer>
      <script>
        document.querySelectorAll('main button').forEach((b) => b.addEventListener('click', () => { document.title = 'pick:' + b.dataset.i; }));
        document.getElementById('cancel').addEventListener('click', () => { document.title = 'cancel'; });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.title = 'cancel'; });
      </script>
    </body></html>`;

    const picker = new BrowserWindow({
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      width: 760,
      height: 540,
      title: 'Partager l\'écran',
      backgroundColor: '#0b0b12',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!picker.isDestroyed()) picker.close();
    };
    picker.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (title === 'cancel') return finish(null);
      const m = /^pick:(\d+)$/.exec(title);
      if (m) finish(sources[Number(m[1])] || null);
    });
    picker.on('closed', () => finish(null));
    picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    minWidth:  800,
    minHeight: 520,
    backgroundColor: '#0b0b12',
    autoHideMenuBar: true,
    // icon is resolved at runtime so missing icon never crashes the app
    icon: (() => {
      // dist/ is packaged inside the asar; process.resourcesPath points to
      // the app's resources dir at runtime. Check several candidates.
      for (const p of [
        path.join(__dirname, '..', 'dist', 'icon.png'),
        path.join(process.resourcesPath || '', 'app.asar', 'dist', 'icon.png'),
        path.join(__dirname, '..', 'build', 'icon.png'),
        path.join(__dirname, '..', 'dist', 'favicon.png'),
        path.join(__dirname, '..', 'dist', 'favicon.ico'),
      ]) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
      }
      return undefined;
    })(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      spellcheck:       true,
      // Sandbox must be off — matrix-sdk-crypto-wasm calls SharedArrayBuffer
      sandbox: false,
    },
  });

  // Open all http/https links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    if (/^https?:/.test(navUrl)) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });

  mainWindow.loadURL('waifutxt://app/index.html');
}

app.on('window-all-closed', () => app.quit());
