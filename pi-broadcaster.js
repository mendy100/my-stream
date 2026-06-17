#!/usr/bin/env node
const { spawn, execSync } = require('child_process');
const { io } = require('socket.io-client');
const os = require('os');

const STREAM_URL = process.env.STREAM_URL || 'https://live-stream-it4q.onrender.com';
const BROADCAST_KEY = process.env.BROADCAST_KEY;
const DEVICE = process.env.DEVICE || '';
const CAPTURE_RATE = parseInt(process.env.SAMPLE_RATE) || 48000;
const TARGET_RATE = 16000;

if (!BROADCAST_KEY) {
  console.error('Missing BROADCAST_KEY');
  process.exit(1);
}

function findUSBDevice() {
  if (DEVICE) return DEVICE;
  try {
    const cards = execSync('cat /proc/asound/cards', { encoding: 'utf8' });
    for (const line of cards.split('\n')) {
      if (line.includes('USB') || line.includes('Scarlett') || line.includes('Focusrite')) {
        const match = line.match(/^\s*(\d+)/);
        if (match) return `hw:${match[1]},0`;
      }
    }
  } catch (e) {}
  return 'hw:1,0';
}

function stereoToMono(buf) {
  const frames = Math.floor(buf.length / 4);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = buf.readInt16LE(i * 4);
    const r = buf.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((l + r) / 2))), i * 2);
  }
  return out;
}

function downsample(buf, from, to) {
  const ratio = Math.round(from / to);
  if (ratio <= 1) return buf;
  const samples = buf.length / 2;
  const outLen = Math.floor(samples / ratio);
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    out.writeInt16LE(buf.readInt16LE(i * ratio * 2), i * 2);
  }
  return out;
}

function getNetworkInfo() {
  const info = { type: 'unknown', ip: '', ssid: '', signal: '' };
  try {
    const route = execSync("ip route get 1.1.1.1 2>/dev/null | head -1", { encoding: 'utf8' });
    const ifMatch = route.match(/dev\s+(\S+)/);
    const iface = ifMatch ? ifMatch[1] : '';
    info.ip = (route.match(/src\s+(\S+)/) || [])[1] || '';
    if (iface.startsWith('wlan')) {
      info.type = 'wifi';
      try {
        const iw = execSync(`iwconfig ${iface} 2>/dev/null`, { encoding: 'utf8' });
        info.ssid = (iw.match(/ESSID:"([^"]*)"/) || [])[1] || '';
        info.signal = (iw.match(/Signal level=(-?\d+)/) || [])[1] || '';
      } catch (e) {}
    } else if (iface.startsWith('eth')) {
      info.type = 'ethernet';
    }
  } catch (e) {}
  return info;
}

// WiFi management via nmcli
function listWifiNetworks() {
  try {
    const out = execSync('nmcli -t -f NAME,TYPE,DEVICE connection show', { encoding: 'utf8' });
    const active = execSync('nmcli -t -f NAME,TYPE,DEVICE connection show --active', { encoding: 'utf8' });
    const activeNames = new Set();
    for (const line of active.trim().split('\n')) {
      const [name, type] = line.split(':');
      if (type === '802-11-wireless') activeNames.add(name);
    }
    const networks = [];
    for (const line of out.trim().split('\n')) {
      const [name, type] = line.split(':');
      if (type === '802-11-wireless') {
        networks.push({ ssid: name, active: activeNames.has(name) });
      }
    }
    return { networks };
  } catch (e) {
    // Fallback: try wpa_supplicant config
    try {
      const conf = execSync('cat /etc/wpa_supplicant/wpa_supplicant.conf 2>/dev/null', { encoding: 'utf8' });
      const networks = [];
      const matches = conf.matchAll(/ssid="([^"]+)"/g);
      for (const m of matches) networks.push({ ssid: m[1], active: false });
      return { networks };
    } catch (e2) {
      return { networks: [], error: 'Could not list networks' };
    }
  }
}

function addWifiNetwork(ssid, password) {
  // If no password, try activating a saved connection first
  if (!password) {
    try {
      const out = execSync(`sudo nmcli connection up "${ssid}" 2>&1`, { encoding: 'utf8', timeout: 30000 });
      if (out.includes('successfully activated')) return { success: true };
    } catch (e) {
      const msg = e.stderr || e.stdout || e.message || '';
      if (msg.includes('key-mgmt') || msg.includes('property is missing')) {
        // Broken saved profile - delete it and ask for password
        try { execSync(`sudo nmcli connection delete "${ssid}" 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (e2) {}
        return { success: false, error: 'need-password' };
      }
    }
  }
  try {
    const cmd = password
      ? `sudo nmcli device wifi connect "${ssid}" password "${password}" 2>&1`
      : `sudo nmcli device wifi connect "${ssid}" 2>&1`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    if (out.includes('successfully activated')) {
      return { success: true };
    }
    return { success: false, error: 'Connection failed' };
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message || '';
    if (msg.includes('Secrets were required') || msg.includes('No suitable device') || msg.includes('password')) {
      return { success: false, error: 'Wrong password' };
    }
    if (msg.includes('No network with SSID')) {
      return { success: false, error: 'Network not found' };
    }
    if (msg.includes('key-mgmt') || msg.includes('property is missing')) {
      try { execSync(`sudo nmcli connection delete "${ssid}" 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (e2) {}
      return { success: false, error: 'need-password' };
    }
    return { success: false, error: msg.split('\n')[0] || 'Connection failed' };
  }
}

function removeWifiNetwork(ssid) {
  try {
    execSync(`sudo nmcli connection delete "${ssid}"`, { encoding: 'utf8' });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function scanWifiNetworks() {
  try {
    execSync('sudo nmcli device wifi rescan 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
  } catch (e) {}
  try {
    const out = execSync('nmcli -t -f SSID,SIGNAL,SECURITY device wifi list', { encoding: 'utf8', timeout: 10000 });
    const seen = new Set();
    const networks = [];
    for (const line of out.trim().split('\n')) {
      const parts = line.split(':');
      if (parts.length < 3) continue;
      const security = parts.pop();
      const signal = parseInt(parts.pop()) || 0;
      const ssid = parts.join(':');
      if (!ssid || ssid === '--' || seen.has(ssid)) continue;
      seen.add(ssid);
      const isOpen = !security || security === '--' || security === '';
      networks.push({ ssid, signal, security: isOpen ? 'Open' : security, open: isOpen });
    }
    networks.sort((a, b) => b.signal - a.signal);
    return { networks };
  } catch (e) {
    return { networks: [], error: 'Scan failed: ' + e.message };
  }
}

function start() {
  const device = findUSBDevice();
  console.log(`[pi] Device: ${device}`);
  console.log(`[pi] Server: ${STREAM_URL}`);
  console.log(`[pi] Capture: ${CAPTURE_RATE}Hz -> ${TARGET_RATE}Hz`);

  const socket = io(STREAM_URL, {
    query: { broadcaster: '1', type: 'pi' },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
  });

  let authenticated = false;
  let arecord = null;
  let statusInterval = null;

  socket.on('connect', () => {
    console.log('[pi] Connected');
    socket.emit('start-broadcast', BROADCAST_KEY);
  });

  socket.on('status', (data) => {
    if (data.live) {
      console.log('[pi] LIVE');
      authenticated = true;
      startCapture();
      startStatus();
    }
  });

  socket.on('auth-error', () => {
    console.error('[pi] Invalid key!');
    process.exit(1);
  });

  socket.on('listeners', (n) => console.log(`[pi] Listeners: ${n}`));

  socket.on('disconnect', (reason) => {
    console.log(`[pi] Disconnected: ${reason}`);
    authenticated = false;
    stopCapture();
    stopStatus();
  });

  socket.on('reconnect', () => {
    console.log('[pi] Reconnected');
    socket.emit('start-broadcast', BROADCAST_KEY);
  });

  // WiFi management handlers
  socket.on('list-wifi', (_, cb) => {
    if (cb) cb(listWifiNetworks());
  });

  socket.on('add-wifi', (data, cb) => {
    const result = addWifiNetwork(data.ssid, data.password);
    if (cb) cb(result);
  });

  socket.on('remove-wifi', (ssid, cb) => {
    const result = removeWifiNetwork(ssid);
    if (cb) cb(result);
  });

  socket.on('scan-wifi', (_, cb) => {
    console.log('[pi] WiFi scan requested');
    const result = scanWifiNetworks();
    console.log('[pi] WiFi scan result:', result.networks.length, 'networks');
    if (cb) cb(result);
  });

  function startStatus() {
    const send = () => {
      socket.emit('pi-status', { network: getNetworkInfo(), uptime: os.uptime(), device });
    };
    send();
    statusInterval = setInterval(send, 5000);
  }

  function stopStatus() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  }

  function startCapture() {
    if (arecord) return;
    const args = ['-D', device, '-f', 'S16_LE', '-c', '2', '-r', String(CAPTURE_RATE), '-t', 'raw', '--buffer-size', '1024'];
    console.log(`[pi] arecord ${args.join(' ')}`);
    arecord = spawn('arecord', args);

    arecord.stdout.on('data', (chunk) => {
      if (!authenticated) return;
      socket.emit('audio', downsample(stereoToMono(chunk), CAPTURE_RATE, TARGET_RATE));
    });

    arecord.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('overrun')) console.log(`[arecord] ${msg}`);
    });

    arecord.on('close', (code) => {
      console.log(`[pi] arecord exited (${code})`);
      arecord = null;
      if (authenticated) setTimeout(startCapture, 2000);
    });
  }

  function stopCapture() {
    if (arecord) { arecord.kill('SIGTERM'); arecord = null; }
  }

  process.on('SIGINT', () => { socket.emit('stop-broadcast'); stopCapture(); stopStatus(); socket.close(); process.exit(0); });
  process.on('SIGTERM', () => { socket.emit('stop-broadcast'); stopCapture(); stopStatus(); socket.close(); process.exit(0); });
}

start();
