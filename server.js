const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Resolve ffmpeg: prefer the binary bundled with the app (ffmpeg-static),
// then fall back to system locations (GUI apps on macOS don't inherit shell PATH)
function findFfmpeg() {
  try {
    let bundled = require('ffmpeg-static');
    if (bundled) {
      // When packaged by Electron, the binary lives outside the asar archive
      bundled = bundled.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch (e) { /* ffmpeg-static not installed; use system ffmpeg */ }
  const candidates = os.platform() === 'win32'
    ? [
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')
      ]
    : [
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg'
      ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return 'ffmpeg'; // fall back to PATH
}
const FFMPEG = findFfmpeg();

// Shown in Settings so we can confirm which build is actually installed
const APP_VERSION = (() => {
  try { return require('./package.json').version; } catch (e) { return '?'; }
})();
const BUILD_ID = 'capture-engine-2';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const WATCH_PORT = process.env.WATCH_PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));

// --- Watch-only server on its own port ---------------------------------
// Hands out nothing but the feed. There is no draw page, no settings and no
// control API here, and its sockets are hard-coded to the read-only role, so
// a viewer on this port cannot change what is on air even deliberately.
const watchApp = express();
const watchServer = http.createServer(watchApp);
const watchWss = new WebSocketServer({ server: watchServer });

function sendWatchPage(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
}
watchApp.get('/', sendWatchPage);
watchApp.get('/watch.html', sendWatchPage);
watchApp.get('/index.html', sendWatchPage);

watchApp.get('/video/stream', (req, res) => mjpegHandler(req, res));

// Just enough for the page to know whether a feed is live
watchApp.get('/api/devices', (req, res) => {
  res.json({ devices: [], current: currentVideoDevice });
});
watchApp.get('/api/watch-config', (req, res) => watchConfig(req, res));

// Anything else on this port is not available
watchApp.use((req, res) => res.status(404).send('Watch only.'));

// --- State ---
let strokes = [];
let currentVideoDevice = null;
let ffmpegProcess = null;
let captureWs = null;      // Electron hidden window doing getUserMedia capture
let captureDevices = [];   // devices reported by the Electron capture window
let captureError = null;   // last capture failure, surfaced in Settings UI
let capturePermission = 'unknown'; // camera permission as seen by the capture window
let captureSource = null;  // actual resolution/frameRate the camera delivers
let mjpegClients = [];     // open /video/stream responses
let testVideo = null; // { videoId } when test video mode is active
let hidden = false;   // TD has pulled drawings off the output
let autoClear = { enabled: false, seconds: 15 };
let autoClearTimer = null;
let keyMode = 'luma'; // 'luma' = black background, 'chroma' = green background

function scheduleAutoClear() {
  clearTimeout(autoClearTimer);
  if (!autoClear.enabled) return;
  autoClearTimer = setTimeout(() => {
    if (strokes.length > 0) {
      strokes = [];
      broadcast({ type: 'clear' });
      console.log('[auto-clear] cleared after inactivity');
    }
  }, autoClear.seconds * 1000);
}

// --- WebSocket handling ---
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'draw';

  console.log(`Client connected: ${role}`);
  ws.role = role;

  if (role === 'capture') {
    captureWs = ws;
  }

  ws.send(JSON.stringify({ type: 'state', strokes, testVideo, hidden, autoClear, keyMode }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // JPEG frame from the Electron capture window
      if (ws === captureWs) distributeFrame(data);
      return;
    }
    try {
      const msg = JSON.parse(data);
      handleMessage(msg, ws);
    } catch (e) {
      console.error('Bad message:', e);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${role}`);
    if (ws === captureWs) {
      captureWs = null;
      captureDevices = [];
      currentVideoDevice = null;
    }
  });
});

// Roles allowed to change what is on air. Watch clients are read-only, and
// this is enforced here rather than only in the UI so it cannot be bypassed.
const WRITE_ROLES = new Set(['draw', 'settings', 'output', 'capture']);
const WRITE_TYPES = new Set([
  'stroke', 'stroke-update', 'undo', 'clear', 'spotlight',
  'test-video', 'keymode', 'video-control'
]);

function handleMessage(msg, sender) {
  if (WRITE_TYPES.has(msg.type) && !WRITE_ROLES.has(sender.role)) {
    return; // view-only client tried to change state
  }

  switch (msg.type) {
    case 'stroke':
      strokes.push(msg.stroke);
      broadcast({ type: 'stroke', stroke: msg.stroke }, sender);
      scheduleAutoClear();
      break;

    case 'stroke-update':
      const idx = strokes.findIndex(s => s.id === msg.id);
      if (idx !== -1) {
        strokes[idx] = { ...strokes[idx], points: msg.points };
      }
      broadcast({ type: 'stroke-update', id: msg.id, points: msg.points }, sender);
      scheduleAutoClear();
      break;

    case 'undo':
      strokes.pop();
      broadcast({ type: 'undo' }, sender);
      break;

    case 'clear':
      strokes = [];
      broadcast({ type: 'clear' }, sender);
      break;

    case 'spotlight':
      broadcast({ type: 'spotlight', x: msg.x, y: msg.y, active: msg.active });
      break;

    case 'test-video':
      testVideo = msg.videoId ? { videoId: msg.videoId } : null;
      broadcast({ type: 'test-video', testVideo });
      break;

    case 'keymode':
      if (msg.mode === 'luma' || msg.mode === 'chroma') {
        keyMode = msg.mode;
        broadcast({ type: 'keymode', keyMode });
      }
      break;

    case 'video-control':
      // play / pause / seek commands from the drawing page -> relay to outputs
      broadcast({ type: 'video-control', action: msg.action, time: msg.time, playing: msg.playing }, sender);
      break;

    // --- Messages from the Electron capture window ---
    case 'capture-devices':
      captureDevices = msg.devices || [];
      if (msg.permission) capturePermission = msg.permission;
      if (msg.error) captureError = msg.error;
      else if (captureDevices.length) captureError = null;
      console.log(`[capture] devices: ${captureDevices.map(d => d.name).join(', ') || '(none)'}`);
      broadcast({ type: 'capture-info', ...captureInfo() });
      break;

    case 'capture-state':
      currentVideoDevice = msg.current;
      if (msg.source) captureSource = msg.source;
      if (msg.current) captureError = null;
      broadcast({ type: 'capture-info', ...captureInfo() });
      break;

    case 'capture-error':
      captureError = msg.message;
      if (msg.permission) capturePermission = msg.permission;
      console.error('[capture] error:', msg.message);
      broadcast({ type: 'capture-info', ...captureInfo() });
      break;
  }
}

// Viewers on the watch port: receive state, never send it
watchWss.on('connection', (ws) => {
  ws.role = 'watch';
  console.log('Client connected: watch (port ' + WATCH_PORT + ')');
  ws.send(JSON.stringify({ type: 'state', strokes, hidden }));
  // Deliberately no message handler — this socket is receive-only
  ws.on('close', () => console.log('Client disconnected: watch'));
});

function broadcast(msg, excludeSender) {
  const data = JSON.stringify(msg);
  const send = (client) => {
    if (client !== excludeSender && client.readyState === 1) {
      client.send(data);
    }
  };
  wss.clients.forEach(send);
  watchWss.clients.forEach(send);
}

// --- Video capture (MJPEG stream from capture card) ---
// macOS: AVFoundation (device by index). Windows: DirectShow (device by name).
function listVideoDevices() {
  return new Promise((resolve) => {
    const platform = os.platform();
    let args;
    if (platform === 'darwin') {
      args = ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""'];
    } else if (platform === 'win32') {
      args = ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
    } else {
      resolve([]);
      return;
    }

    let proc;
    try {
      proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve([]);
      return;
    }
    proc.on('error', () => resolve([]));

    let output = '';
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => {
      const devices = [];
      const lines = output.split('\n');
      if (platform === 'darwin') {
        let inVideo = false;
        for (const line of lines) {
          if (line.includes('AVFoundation video devices')) inVideo = true;
          else if (line.includes('AVFoundation audio devices')) inVideo = false;
          else if (inVideo) {
            const match = line.match(/\[(\d+)\]\s+(.+)/);
            if (match) {
              devices.push({ index: match[1], name: match[2].trim() });
            }
          }
        }
      } else {
        // dshow lists: [dshow @ ...] "Device Name" (video)
        for (const line of lines) {
          const match = line.match(/"([^"]+)"\s+\(video\)/);
          if (match) {
            devices.push({ index: match[1], name: match[1] });
          }
        }
      }
      resolve(devices);
    });
  });
}

function buildCaptureArgs(deviceIndex) {
  const common = ['-f', 'mjpeg', '-q:v', '3', '-r', '30', '-an', 'pipe:1'];
  if (os.platform() === 'win32') {
    return [
      '-f', 'dshow',
      '-framerate', '30',
      '-video_size', '1920x1080',
      '-i', `video=${deviceIndex}`,
      ...common
    ];
  }
  return [
    '-f', 'avfoundation',
    '-framerate', '30',
    '-video_size', '1920x1080',
    '-pixel_format', 'uyvy422',
    '-i', `${deviceIndex}:none`,
    ...common
  ];
}

// Write a JPEG frame to every open /video/stream response.
// Frames are dropped for any client whose socket is still draining — on a
// live telestrator a fresh frame always beats a queued one, and without
// this the preview falls progressively further behind on a slow link.
let framesDropped = 0;
function distributeFrame(frame) {
  const now = Date.now();
  for (let i = mjpegClients.length - 1; i >= 0; i--) {
    const res = mjpegClients[i];
    if (res.writableNeedDrain) {
      framesDropped++;
      continue;
    }
    // Per-client frame rate: watchers take a slice of the same encoded
    // frames, so a lower rate costs bandwidth only, never extra CPU.
    if (res.minInterval && now - res.lastFrameAt < res.minInterval - 2) continue;
    res.lastFrameAt = now;
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
    } catch (e) {
      mjpegClients.splice(i, 1);
    }
  }
}

function captureActive() {
  return (captureWs && currentVideoDevice !== null) || ffmpegProcess !== null;
}

// Everything needed to diagnose a "no video" problem without a terminal
function captureInfo() {
  return {
    engine: captureWs ? 'electron' : 'ffmpeg-fallback',
    captureWindowConnected: captureWs !== null,
    cameraPermission: capturePermission,
    deviceCount: captureWs ? captureDevices.length : null,
    devices: captureWs ? captureDevices.map(d => d.name) : null,
    currentDevice: currentVideoDevice,
    source: captureSource,
    previewFps: captureFps,
    previewSize,
    watchFps,
    capturing: captureActive(),
    streamViewers: mjpegClients.length,
    framesDropped,
    lastError: captureError,
    platform: `${os.platform()} ${os.arch()}`,
    ffmpegPath: FFMPEG,
    ffmpegExists: (() => { try { return fs.existsSync(FFMPEG); } catch (e) { return false; } })(),
    appVersion: APP_VERSION,
    buildId: BUILD_ID
  };
}

app.get('/api/diagnostics', (req, res) => res.json(captureInfo()));

// --- Output window control (only available when running inside Electron) ---
// main.js injects these so the Settings page can place the output window on a
// chosen display without the app hijacking a screen at launch.
const windowHooks = {
  listDisplays: null,
  openOutput: null,
  closeOutput: null,
  getOutputState: null
};
module.exports = {
  setWindowHooks(hooks) { Object.assign(windowHooks, hooks); }
};

app.get('/api/displays', (req, res) => {
  if (!windowHooks.listDisplays) {
    res.json({ electron: false, displays: [], output: null });
    return;
  }
  res.json({
    electron: true,
    displays: windowHooks.listDisplays(),
    output: windowHooks.getOutputState ? windowHooks.getOutputState() : null
  });
});

app.post('/api/output/open', express.json(), (req, res) => {
  if (!windowHooks.openOutput) {
    res.json({ ok: false, reason: 'not running inside the desktop app' });
    return;
  }
  windowHooks.openOutput({
    displayId: req.body.displayId,
    fullscreen: req.body.fullscreen !== false
  });
  res.json({ ok: true });
});

app.post('/api/output/close', (req, res) => {
  if (!windowHooks.closeOutput) {
    res.json({ ok: false, reason: 'not running inside the desktop app' });
    return;
  }
  windowHooks.closeOutput();
  res.json({ ok: true });
});

// Preview frame rate. Higher costs CPU (every frame is JPEG-encoded) and
// bandwidth; it can never exceed what the camera itself delivers.
let captureFps = 30;

// Preview resolution. Fewer pixels is the cheapest way to buy CPU headroom
// when running at a high frame rate; it does not affect the on-air output,
// only what the iPad and watchers see.
let previewSize = { width: 1280, height: 720 };
app.post('/api/capture/size', (req, res) => {
  const w = parseInt(req.query.width);
  const h = parseInt(req.query.height);
  if (!(w > 0 && h > 0)) {
    res.json({ ok: false, reason: 'width and height required' });
    return;
  }
  previewSize = { width: w, height: h };
  if (captureWs) captureWs.send(JSON.stringify({ type: 'capture-size', width: w, height: h }));
  console.log(`[capture] preview size -> ${w}x${h}`);
  res.json({ ok: true, ...previewSize });
});

// Watcher frame rate. Watchers receive a slice of frames that were already
// encoded for the drawer, so raising this costs bandwidth per viewer but no
// extra CPU at all. Capped at the capture rate — there is nothing above it.
let watchFps = 30;
app.post('/api/watch/fps', (req, res) => {
  const v = parseInt(req.query.value);
  if (!(v > 0 && v <= 60)) {
    res.json({ ok: false, reason: 'value must be 1-60' });
    return;
  }
  watchFps = v;
  console.log(`[watch] viewer fps -> ${v}`);
  res.json({ ok: true, fps: v });
});

// Both servers expose this so the watch page knows what to request
function watchConfig(req, res) {
  res.json({ fps: Math.min(watchFps, captureFps) });
}
app.get('/api/watch-config', watchConfig);
app.post('/api/capture/fps', (req, res) => {
  const v = parseInt(req.query.value);
  if (!(v > 0 && v <= 60)) {
    res.json({ ok: false, reason: 'value must be 1-60' });
    return;
  }
  captureFps = v;
  if (captureWs) captureWs.send(JSON.stringify({ type: 'capture-fps', fps: v }));
  console.log(`[capture] preview fps -> ${v}`);
  res.json({ ok: true, fps: v });
});

// Force the capture window to re-enumerate cameras (e.g. after quitting OBS
// or granting camera permission) — Refresh alone only re-read a cached list.
app.post('/api/devices/rescan', (req, res) => {
  if (!captureWs) {
    res.json({ ok: false, reason: 'capture window not connected' });
    return;
  }
  captureError = null;
  captureWs.send(JSON.stringify({ type: 'capture-rescan' }));
  res.json({ ok: true });
});

app.get('/api/devices', async (req, res) => {
  // Electron capture window (getUserMedia) is the primary source — it sees
  // UVC cameras AND virtual cameras (OBS etc.). ffmpeg is the headless fallback.
  if (captureWs) {
    res.json({ devices: captureDevices, current: currentVideoDevice });
    return;
  }
  const devices = await listVideoDevices();
  res.json({ devices, current: currentVideoDevice });
});

app.post('/api/capture/start', express.json(), (req, res) => {
  const device = req.body.device;

  if (captureWs) {
    currentVideoDevice = device;
    captureWs.send(JSON.stringify({ type: 'capture-start', deviceId: device }));
    res.json({ ok: true, device, via: 'electron' });
    return;
  }

  // Headless fallback: ffmpeg
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }

  currentVideoDevice = device || '0';

  ffmpegProcess = spawn(FFMPEG, buildCaptureArgs(currentVideoDevice), { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpegProcess.on('error', (err) => {
    console.error('ffmpeg failed to start (is it installed?):', err.message);
    ffmpegProcess = null;
    currentVideoDevice = null;
  });

  // Parse MJPEG stream from ffmpeg stdout into individual frames
  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);
  ffmpegProcess.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const soiIdx = buffer.indexOf(SOI);
      const eoiIdx = buffer.indexOf(EOI, soiIdx);
      if (soiIdx === -1 || eoiIdx === -1) break;
      const frame = buffer.subarray(soiIdx, eoiIdx + 2);
      buffer = buffer.subarray(eoiIdx + 2);
      distributeFrame(frame);
    }
  });

  ffmpegProcess.stderr.on('data', (d) => {
    const line = d.toString().trim();
    if (line && !line.startsWith('frame=')) {
      console.log('[ffmpeg]', line);
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`ffmpeg exited with code ${code}`);
    ffmpegProcess = null;
    currentVideoDevice = null;
  });

  res.json({ ok: true, device: currentVideoDevice, via: 'ffmpeg' });
});

app.post('/api/capture/stop', (req, res) => {
  if (captureWs) {
    captureWs.send(JSON.stringify({ type: 'capture-stop' }));
  }
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }
  currentVideoDevice = null;
  res.json({ ok: true });
});

// MJPEG stream endpoint — frames come from the Electron capture window
// (or ffmpeg in headless mode) via distributeFrame(). Shared by both ports.
function mjpegHandler(req, res) {
  if (!captureActive()) {
    res.status(503).send('No capture running. Start capture first.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // ?fps=N thins the stream for this viewer (watch pages ask for less)
  const fps = parseInt(req.query.fps);
  res.minInterval = (fps > 0 && fps < 30) ? 1000 / fps : 0;
  res.lastFrameAt = 0;

  mjpegClients.push(res);
  req.on('close', () => {
    const i = mjpegClients.indexOf(res);
    if (i !== -1) mjpegClients.splice(i, 1);
  });
}
app.get('/video/stream', mjpegHandler);

// --- Companion / external control (Bitfocus Companion "Generic HTTP") ---
// GET or POST both work so any HTTP-capable controller can use these.
function companionEndpoint(path, handler) {
  app.get(path, (req, res) => { handler(req); res.json({ ok: true }); });
  app.post(path, (req, res) => { handler(req); res.json({ ok: true }); });
}

companionEndpoint('/api/clear', () => {
  strokes = [];
  broadcast({ type: 'clear' });
  console.log('[companion] clear');
});

companionEndpoint('/api/undo', () => {
  strokes.pop();
  broadcast({ type: 'undo' });
  console.log('[companion] undo');
});

function setHidden(value) {
  hidden = value;
  broadcast({ type: 'hidden', hidden });
  console.log(`[companion] ${hidden ? 'hide' : 'show'}`);
}
companionEndpoint('/api/hide', () => setHidden(true));
companionEndpoint('/api/show', () => setHidden(false));
companionEndpoint('/api/hide/toggle', () => setHidden(!hidden));

function setAutoClear(enabled, req) {
  const secs = parseInt(req.query.seconds);
  if (!isNaN(secs) && secs > 0) autoClear.seconds = secs;
  autoClear.enabled = enabled;
  broadcast({ type: 'autoclear', autoClear });
  scheduleAutoClear();
  console.log(`[companion] auto-clear ${enabled ? `armed (${autoClear.seconds}s)` : 'disarmed'}`);
}
companionEndpoint('/api/autoclear/on', (req) => setAutoClear(true, req));
companionEndpoint('/api/autoclear/off', (req) => setAutoClear(false, req));
companionEndpoint('/api/autoclear/toggle', (req) => setAutoClear(!autoClear.enabled, req));

function setKeyMode(mode) {
  keyMode = mode;
  broadcast({ type: 'keymode', keyMode });
  console.log(`[companion] key mode: ${keyMode}`);
}
companionEndpoint('/api/keymode/luma', () => setKeyMode('luma'));
companionEndpoint('/api/keymode/chroma', () => setKeyMode('chroma'));
companionEndpoint('/api/keymode/toggle', () => setKeyMode(keyMode === 'luma' ? 'chroma' : 'luma'));

// Status for Companion button feedback (poll this with Generic HTTP feedbacks)
app.get('/api/status', (req, res) => {
  res.json({
    strokes: strokes.length,
    hidden,
    autoClear,
    keyMode,
    capturing: captureActive(),
    testVideo: testVideo ? testVideo.videoId : null,
    clients: wss.clients.size,
    watchers: watchWss.clients.size,
    watchPort: WATCH_PORT
  });
});

// --- Get local IP for display ---
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

// Make sure ffmpeg dies with us (Electron quit, Ctrl+C, crashes)
function cleanupCapture() {
  if (ffmpegProcess) {
    try { ffmpegProcess.kill('SIGTERM'); } catch (e) {}
    ffmpegProcess = null;
  }
}
process.on('exit', cleanupCapture);
process.on('SIGINT', () => { cleanupCapture(); process.exit(0); });
process.on('SIGTERM', () => { cleanupCapture(); process.exit(0); });

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('=== TELESTRATOR ===');
  console.log('');
  console.log(`  Share (choose): http://${ip}:${PORT}`);
  console.log(`  Draw:           http://${ip}:${PORT}/draw.html`);
  console.log(`  Output (ATEM):  http://${ip}:${PORT}/output.html`);
  console.log(`  Settings:       http://${ip}:${PORT}/settings.html`);
  console.log('');
  console.log(`  WATCHERS:       http://${ip}:${WATCH_PORT}`);
  console.log('');
});

watchServer.listen(WATCH_PORT, '0.0.0.0', () => {
  console.log(`Watch-only server listening on ${WATCH_PORT}`);
});
