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
      const choice = await pickDisplaySource(sources);
      if (!choice) return callback({});
      // System audio capture ("loopback") is only available on Windows.
      callback(choice.audio ? { video: choice.source, audio: 'loopback' } : { video: choice.source });
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

// Default dark theme tokens (src/styles/theme.css), used when the app window can't be queried.
const DEFAULT_PICKER_THEME = {
  bg: '#0b0b14', panel: '#12121f', tile: '#1a1a2e', hover: '#252540', active: '#2e2e50',
  border: '#2a2a40', text: '#e8e8f0', textSecondary: '#8888a8', accent: '#ff2d78', light: false,
};

// Reads the live theme tokens (theme + user accent) from the app so the picker matches it.
async function readAppTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return DEFAULT_PICKER_THEME;
  try {
    const t = await mainWindow.webContents.executeJavaScript(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      return {
        bg: v('--color-bg-primary'), panel: v('--color-bg-secondary'), tile: v('--color-bg-tertiary'),
        hover: v('--color-bg-hover'), active: v('--color-bg-active'), border: v('--color-border'),
        text: v('--color-text-primary'), textSecondary: v('--color-text-secondary'),
        accent: v('--color-accent-pink'),
        light: document.documentElement.getAttribute('data-theme') === 'light',
      };
    })()`);
    const safe = { ...DEFAULT_PICKER_THEME };
    for (const key of Object.keys(DEFAULT_PICKER_THEME)) {
      if (key === 'light') safe.light = t.light === true;
      else if (typeof t[key] === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(t[key])) safe[key] = t[key];
    }
    return safe;
  } catch {
    return DEFAULT_PICKER_THEME;
  }
}

// Modal picker for screen share sources. The page reports the choice through its title so no
// preload/IPC bridge is needed: "pick:<index>:<audio 0|1>" or "cancel".
async function pickDisplaySource(sources) {
  if (sources.length === 0) return null;
  const theme = await readAppTheme();
  const canShareAudio = process.platform === 'win32';

  const tile = (s, i) => `
      <button class="source" data-i="${i}" title="${escapeHtml(s.name)}">
        <img src="${s.thumbnail.toDataURL()}" alt="">
        <span>${escapeHtml(s.name)}</span>
      </button>`;
  const screens = sources.map((s, i) => [s, i]).filter(([s]) => s.id.startsWith('screen:'));
  const windows = sources.map((s, i) => [s, i]).filter(([s]) => !s.id.startsWith('screen:'));
  const section = (title, list) => list.length === 0 ? '' : `
      <section>
        <h2>${title}</h2>
        <div class="grid">${list.map(([s, i]) => tile(s, i)).join('')}</div>
      </section>`;

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>picker</title><style>
    :root {
      color-scheme: ${theme.light ? 'light' : 'dark'};
      --bg: ${theme.bg}; --panel: ${theme.panel}; --tile: ${theme.tile}; --hover: ${theme.hover};
      --active: ${theme.active}; --border: ${theme.border}; --text: ${theme.text};
      --text-2: ${theme.textSecondary}; --accent: ${theme.accent};
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text);
      font: 13px/1.4 'Segoe UI', system-ui, -apple-system, sans-serif; user-select: none;
    }
    header { padding: 18px 20px 4px; }
    h1 { margin: 0; font-size: 16px; font-weight: 600; }
    header p { margin: 2px 0 0; color: var(--text-2); }
    main { flex: 1; overflow: auto; padding: 4px 20px 16px; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    h2 { margin: 16px 0 8px; font-size: 12px; font-weight: 600; color: var(--text-2); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
    .source {
      all: unset; box-sizing: border-box; cursor: pointer; display: flex; flex-direction: column; gap: 8px;
      padding: 8px; border-radius: 12px; background: var(--panel); border: 2px solid var(--border);
      transition: background-color 150ms, border-color 150ms;
    }
    .source:hover { background: var(--hover); }
    .source:focus-visible { outline: 2px solid var(--text-2); outline-offset: 2px; }
    .source[aria-pressed="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--panel)); }
    .source img { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #000; border-radius: 8px; }
    .source span { padding: 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    footer {
      display: flex; align-items: center; gap: 8px; padding: 12px 20px;
      background: var(--panel); border-top: 1px solid var(--border);
    }
    label { display: flex; align-items: center; gap: 8px; margin-right: auto; color: var(--text-2); cursor: pointer; }
    input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); cursor: pointer; }
    .btn {
      all: unset; cursor: pointer; padding: 7px 16px; border-radius: 8px; font-weight: 600;
      transition: background-color 150ms, filter 150ms;
    }
    .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    #cancel { background: var(--hover); color: var(--text); }
    #cancel:hover { background: var(--active); }
    #share { background: var(--accent); color: #fff; }
    #share:hover { filter: brightness(1.08); }
    #share:disabled { opacity: .4; cursor: not-allowed; filter: none; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style></head><body>
    <header>
      <h1>Partager ton écran</h1>
      <p>Choisis un écran entier ou une seule fenêtre.</p>
    </header>
    <main>${section('Écrans', screens)}${section('Fenêtres', windows)}</main>
    <footer>
      ${canShareAudio ? '<label><input type="checkbox" id="audio" checked> Partager aussi le son</label>' : '<span style="margin-right:auto"></span>'}
      <button class="btn" id="cancel">Annuler</button>
      <button class="btn" id="share" disabled>Partager</button>
    </footer>
    <script>
      let selected = null;
      const shareBtn = document.getElementById('share');
      const audio = document.getElementById('audio');
      const sources = [...document.querySelectorAll('.source')];
      const submit = () => {
        if (selected === null) return;
        document.title = 'pick:' + selected + ':' + (audio && audio.checked ? 1 : 0);
      };
      sources.forEach((b) => {
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => {
          sources.forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
          selected = b.dataset.i;
          shareBtn.disabled = false;
        });
        b.addEventListener('dblclick', () => { selected = b.dataset.i; submit(); });
      });
      shareBtn.addEventListener('click', submit);
      document.getElementById('cancel').addEventListener('click', () => { document.title = 'cancel'; });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.title = 'cancel';
        if (e.key === 'Enter' && selected !== null && !e.target.matches('button')) submit();
      });
      if (sources[0]) sources[0].focus();
    </script>
  </body></html>`;

  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      width: 820,
      height: 600,
      minWidth: 480,
      minHeight: 360,
      title: 'Partager ton écran',
      backgroundColor: theme.bg,
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
      const m = /^pick:(\d+):([01])$/.exec(title);
      const source = m && sources[Number(m[1])];
      if (source) finish({ source, audio: canShareAudio && m[2] === '1' });
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
