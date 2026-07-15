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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// --- State ---
let strokes = [];
let currentVideoDevice = null;
let ffmpegProcess = null;
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
      broadcast({ type: 'clear', fade: true });
      console.log('[auto-clear] cleared after inactivity');
    }
  }, autoClear.seconds * 1000);
}

// --- WebSocket handling ---
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get('role') || 'draw';

  console.log(`Client connected: ${role}`);

  ws.send(JSON.stringify({ type: 'state', strokes, testVideo, hidden, autoClear, keyMode }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(msg, ws);
    } catch (e) {
      console.error('Bad message:', e);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${role}`);
  });
});

function handleMessage(msg, sender) {
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
      broadcast({ type: 'clear', fade: true }, sender);
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
  }
}

function broadcast(msg, excludeSender) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client !== excludeSender && client.readyState === 1) {
      client.send(data);
    }
  });
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

app.get('/api/devices', async (req, res) => {
  const devices = await listVideoDevices();
  res.json({ devices, current: currentVideoDevice });
});

app.post('/api/capture/start', express.json(), (req, res) => {
  const deviceIndex = req.body.device || '0';

  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }

  currentVideoDevice = deviceIndex;

  ffmpegProcess = spawn(FFMPEG, buildCaptureArgs(deviceIndex), { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpegProcess.on('error', (err) => {
    console.error('ffmpeg failed to start (is it installed?):', err.message);
    ffmpegProcess = null;
    currentVideoDevice = null;
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

  res.json({ ok: true, device: deviceIndex });
});

app.post('/api/capture/stop', (req, res) => {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
    currentVideoDevice = null;
  }
  res.json({ ok: true });
});

// MJPEG stream endpoint - serves raw JPEG frames from ffmpeg
app.get('/video/stream', (req, res) => {
  if (!ffmpegProcess) {
    res.status(503).send('No capture running. Start capture first.');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const soiIdx = buffer.indexOf(SOI);
      const eoiIdx = buffer.indexOf(EOI, soiIdx);
      if (soiIdx === -1 || eoiIdx === -1) break;

      const frame = buffer.subarray(soiIdx, eoiIdx + 2);
      buffer = buffer.subarray(eoiIdx + 2);

      try {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      } catch (e) {
        cleanup();
        return;
      }
    }
  }

  function cleanup() {
    if (ffmpegProcess && ffmpegProcess.stdout) {
      ffmpegProcess.stdout.removeListener('data', onData);
    }
  }

  if (ffmpegProcess && ffmpegProcess.stdout) {
    ffmpegProcess.stdout.on('data', onData);
  }

  req.on('close', cleanup);
});

// --- Companion / external control (Bitfocus Companion "Generic HTTP") ---
// GET or POST both work so any HTTP-capable controller can use these.
function companionEndpoint(path, handler) {
  app.get(path, (req, res) => { handler(req); res.json({ ok: true }); });
  app.post(path, (req, res) => { handler(req); res.json({ ok: true }); });
}

companionEndpoint('/api/clear', () => {
  strokes = [];
  broadcast({ type: 'clear', fade: true });
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
    capturing: currentVideoDevice !== null,
    testVideo: testVideo ? testVideo.videoId : null,
    clients: wss.clients.size
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
  console.log(`  iPad (draw):    http://${ip}:${PORT}`);
  console.log(`  Output (ATEM):  http://${ip}:${PORT}/output.html`);
  console.log(`  Settings:       http://${ip}:${PORT}/settings.html`);
  console.log('');
});
