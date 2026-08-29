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

function createOutputWindow() {
  outputWindow = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false }
  });
  outputWindow.loadURL(`http://localhost:${PORT}/output.html`);
  outputWindow.on('closed', () => {
    outputWindow = null;
    // The hidden capture window would otherwise keep the app alive
    if (process.platform !== 'darwin') app.quit();
  });
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 700,
    height: 900,
    title: 'Telestrator Settings',
    autoHideMenuBar: true
  });
  settingsWindow.loadURL(`http://localhost:${PORT}/settings.html`);
  settingsWindow.on('closed', () => { settingsWindow = null; });
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
          label: 'Toggle Output Fullscreen',
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
  require('./server.js');

  // Camera access: prompt macOS properly, and auto-grant our own pages
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media');
  });
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('camera'); } catch (e) {}
  }

  buildMenu();
  registerHotkeys();
  // Give the server a beat to bind before loading from it
  setTimeout(() => {
    createOutputWindow();
    createCaptureWindow();
  }, 300);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOutputWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
