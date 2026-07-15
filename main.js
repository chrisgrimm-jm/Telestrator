const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const os = require('os');

let outputWindow = null;
let settingsWindow = null;

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

function createOutputWindow() {
  outputWindow = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false }
  });
  outputWindow.loadURL(`http://localhost:${PORT}/output.html`);
  outputWindow.on('closed', () => { outputWindow = null; });
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

app.whenReady().then(() => {
  // Start the embedded web/WebSocket server (it listens on module load)
  require('./server.js');

  buildMenu();
  // Give the server a beat to bind before loading from it
  setTimeout(createOutputWindow, 300);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOutputWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
