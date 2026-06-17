const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BROADCAST_KEY = process.env.BROADCAST_KEY || 'LgPDW26rae8w';

const branding = {
  name: 'Live Stream',
  subtitle: 'Tap play to start listening',
  logoUrl: '',
  primaryColor: '#6366f1',
  accentColor: '#8b5cf6',
  bgStyle: 'gradient1',
  cardStyle: 'shadow',
  font: 'modern',
  showLiveBadge: true,
  offlineMessage: 'Stream is currently offline',
  buttonShape: 'circle',
  footerText: '',
};

app.get('/api/branding', (req, res) => res.json(branding));
app.post('/api/branding', (req, res) => {
  Object.assign(branding, req.body);
  res.json(branding);
});

const state = {
  isLive: false,
  listenerCount: 0,
  streamListeners: [],
  piStatus: null,
};

function wavHeader() {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(0xFFFFFFFF, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(0xFFFFFFFF, 40);
  return buf;
}

app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
  });
  res.write(wavHeader());
  state.streamListeners.push(res);
  req.on('close', () => {
    state.streamListeners = state.streamListeners.filter(r => r !== res);
  });
});

// Pi WiFi management API (called from control panel → relayed to Pi via socket)
let piSocket = null;

app.post('/api/wifi', (req, res) => {
  if (!piSocket) return res.status(503).json({ error: 'Pi not connected' });
  piSocket.timeout(30000).emit('add-wifi', req.body, (err, result) => {
    if (err) return res.json({ success: false, error: 'Timed out' });
    res.json(result);
  });
});

app.delete('/api/wifi/:ssid', (req, res) => {
  if (!piSocket) return res.status(503).json({ error: 'Pi not connected' });
  piSocket.timeout(10000).emit('remove-wifi', req.params.ssid, (err, result) => {
    if (err) return res.json({ success: false, error: 'Timed out' });
    res.json(result);
  });
});

app.get('/api/wifi', (req, res) => {
  if (!piSocket) return res.status(503).json({ error: 'Pi not connected' });
  piSocket.timeout(10000).emit('list-wifi', null, (err, result) => {
    if (err) return res.json({ networks: [], error: 'Timed out' });
    res.json(result);
  });
});

app.get('/api/wifi/scan', (req, res) => {
  if (!piSocket) return res.status(503).json({ error: 'Pi not connected' });
  let replied = false;
  const timeout = setTimeout(() => {
    if (!replied) { replied = true; res.json({ networks: [], error: 'Scan timed out' }); }
  }, 35000);
  piSocket.timeout(30000).emit('scan-wifi', null, (err, result) => {
    clearTimeout(timeout);
    if (replied) return;
    replied = true;
    if (err) return res.json({ networks: [], error: 'Scan timed out' });
    res.json(result);
  });
});

io.on('connection', (socket) => {
  const isBroadcaster = socket.handshake.query.broadcaster === '1';
  const type = socket.handshake.query.type || 'web';

  if (!isBroadcaster) {
    state.listenerCount++;
    io.emit('listeners', state.listenerCount);
  }

  socket.emit('status', { live: state.isLive, piConnected: !!state.piStatus });

  socket.on('start-broadcast', (key) => {
    if (type !== 'control' && key !== BROADCAST_KEY) {
      socket.emit('auth-error');
      return;
    }
    socket.isBroadcaster = true;
    socket.broadcasterType = type;
    if (type === 'pi') piSocket = socket;
    state.isLive = true;
    io.emit('status', { live: true, piConnected: !!state.piStatus });
  });

  socket.on('audio', (data) => {
    if (!socket.isBroadcaster) return;
    const buf = Buffer.from(data);
    state.streamListeners.forEach(res => {
      try { res.write(buf); } catch (e) {}
    });
    socket.broadcast.emit('audio', data);
  });

  socket.on('pi-status', (info) => {
    if (!socket.isBroadcaster || socket.broadcasterType !== 'pi') return;
    state.piStatus = { ...info, lastSeen: Date.now() };
    io.emit('pi-status', state.piStatus);
  });

  socket.on('stop-broadcast', () => {
    if (!socket.isBroadcaster) return;
    state.isLive = false;
    io.emit('status', { live: false });
  });

  socket.on('disconnect', () => {
    if (socket.isBroadcaster) {
      if (socket.broadcasterType === 'pi') {
        piSocket = null;
        state.piStatus = null;
        io.emit('pi-status', null);
      }
      const hasOthers = [...io.sockets.sockets.values()].some(
        s => s !== socket && s.isBroadcaster
      );
      if (!hasOthers) {
        state.isLive = false;
        io.emit('status', { live: false });
      }
    }
    if (!isBroadcaster) {
      state.listenerCount = Math.max(0, state.listenerCount - 1);
      io.emit('listeners', state.listenerCount);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  My Stream running on http://localhost:${PORT}\n`);
});
