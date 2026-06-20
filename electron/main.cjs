// electron/main.cjs  — CommonJS wrapper (avoids "type":"module" conflict)
'use strict';

const { app, BrowserWindow, shell, session, protocol } = require('electron');
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
    cb(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(perm));
  });

  createWindow();
});

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
      for (const p of [
        path.join(__dirname, '..', 'build', 'icon.png'),
        path.join(__dirname, '..', 'public', 'favicon.png'),
        path.join(__dirname, '..', 'public', 'favicon.ico'),
      ]) {
        if (fs.existsSync(p)) return p;
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
