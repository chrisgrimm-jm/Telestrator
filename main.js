const { app, BrowserWindow, Menu, shell, dialog, session, systemPreferences, globalShortcut } = require('electron');
const os = require('os');
const http = require('http');

let outputWindow = null;
let settingsWindow = null;
let captureWindow = null;

const PORT = process.env.PORT || 3000;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Invisible window that captures the camera (getUserMedia sees UVC devices
// and virtual cameras like OBS) and streams frames to the embedded server
function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false }
  });
  captureWindow.loadURL(`http://localhost:${PORT}/capture.html`);
  captureWindow.on('closed', () => { captureWindow = null; });
}

function listDisplays() {
  const { screen } = require('electron');
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Display ${i + 1} — ${d.size.width}x${d.size.height}` +
           (d.id === primaryId ? ' (primary)' : ''),
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primaryId
  }));
}

// The output window is what the switcher captures. It is opened on demand
// from Settings so launching the app never hijacks the whole desktop.
function openOutputWindow({ displayId, fullscreen = true } = {}) {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const target = displays.find(d => String(d.id) === String(displayId))
    || screen.getPrimaryDisplay();

  if (outputWindow) {
    placeOutput(target, fullscreen);
    outputWindow.show();
    return;
  }

  outputWindow = new BrowserWindow({
    x: target.bounds.x + 40,
    y: target.bounds.y + 40,
    width: 960,
    height: 540,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Telestrator Output',
    webPreferences: { backgroundThrottling: false }
  });
  outputWindow.loadURL(`http://localhost:${PORT}/output.html`);

  // Escape always gets you out of fullscreen — never be trapped
  outputWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && outputWindow.isFullScreen()) {
      outputWindow.setFullScreen(false);
      event.preventDefault();
    }
  });

  outputWindow.on('closed', () => {
    outputWindow = null;
    quitIfNoVisibleWindows();
  });

  outputWindow.once('ready-to-show', () => placeOutput(target, fullscreen));
}

function placeOutput(display, fullscreen) {
  if (!outputWindow) return;
  if (fullscreen) {
    // Move onto the target display first, then go fullscreen there
    outputWindow.setFullScreen(false);
    outputWindow.setBounds(display.bounds);
    outputWindow.setFullScreen(true);
  } else {
    outputWindow.setFullScreen(false);
    outputWindow.setBounds({
      x: display.bounds.x + 40,
      y: display.bounds.y + 40,
      width: 960,
      height: 540
    });
  }
}

function closeOutputWindow() {
  if (outputWindow) outputWindow.close();
}

function getOutputState() {
  return {
    open: outputWindow !== null,
    fullscreen: outputWindow ? outputWindow.isFullScreen() : false
  };
}

// The hidden capture window must not keep the app alive on its own
function quitIfNoVisibleWindows() {
  if (!outputWindow && !settingsWindow) app.quit();
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 780,
    height: 950,
    title: 'Telestrator Settings',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true
  });
  settingsWindow.loadURL(`http://localhost:${PORT}/settings.html`);
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    quitIfNoVisibleWindows();
  });
}

// Fire one of the app's own control endpoints (same paths Companion uses)
function control(path) {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path, method: 'POST' },
    (res) => res.resume()
  );
  req.on('error', (e) => console.error('[hotkey] failed:', e.message));
  req.end();
}

// Panic keys for whoever is sitting at the machine. Registered globally so
// they work even when Telestrator is not the focused app.
const HOTKEYS = [
  { accel: 'CommandOrControl+Alt+C', path: '/api/clear',       label: 'Clear drawings' },
  { accel: 'CommandOrControl+Alt+H', path: '/api/hide/toggle', label: 'Hide / show output' },
  { accel: 'CommandOrControl+Alt+Z', path: '/api/undo',        label: 'Undo last stroke' }
];

function registerHotkeys() {
  for (const hk of HOTKEYS) {
    const ok = globalShortcut.register(hk.accel, () => control(hk.path));
    console.log(`[hotkey] ${hk.accel} -> ${hk.label}: ${ok ? 'registered' : 'FAILED (in use by another app)'}`);
  }
}

function buildMenu() {
  const ip = getLocalIP();
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Telestrator',
      submenu: [
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: openSettingsWindow
        },
        {
          label: 'Show iPad URL',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'Connect your iPad',
              message: `Open this on the iPad:\n\nhttp://${ip}:${PORT}`,
              buttons: ['OK']
            });
          }
        },
        { type: 'separator' },
        // Accelerators shown for discoverability only; globalShortcut does the
        // actual work so these also fire when the app is not focused.
        {
          label: 'Clear Drawings',
          accelerator: 'CommandOrControl+Alt+C',
          registerAccelerator: false,
          click: () => control('/api/clear')
        },
        {
          label: 'Hide / Show Output',
          accelerator: 'CommandOrControl+Alt+H',
          registerAccelerator: false,
          click: () => control('/api/hide/toggle')
        },
        {
          label: 'Undo Last Stroke',
          accelerator: 'CommandOrControl+Alt+Z',
          registerAccelerator: false,
          click: () => control('/api/undo')
        },
        { type: 'separator' },
        {
          label: 'Open Output Window',
          click: () => openOutputWindow({ fullscreen: false })
        },
        {
          label: 'Close Output Window',
          click: closeOutputWindow
        },
        {
          label: 'Toggle Output Fullscreen  (Esc exits)',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+F' : 'F11',
          click: () => {
            if (outputWindow) outputWindow.setFullScreen(!outputWindow.isFullScreen());
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Start the embedded web/WebSocket server (it listens on module load)
  const serverApi = require('./server.js');

  // Let the Settings page drive the output window over the same HTTP API
  serverApi.setWindowHooks({
    listDisplays,
    openOutput: openOutputWindow,
    closeOutput: closeOutputWindow,
    getOutputState
  });

  // Camera access: prompt macOS properly, and auto-grant our own pages
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); } catch (e) {}
  }

  buildMenu();
  registerHotkeys();
  // Open Settings first so the operator can pick a camera and an output
  // display before anything takes over a screen.
  setTimeout(() => {
    openSettingsWindow();
    createCaptureWindow();
  }, 300);

  app.on('activate', () => {
    if (!settingsWindow && !outputWindow) openSettingsWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
