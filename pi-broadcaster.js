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

function findAllUSBDevices() {
  const devices = [];
  try {
    const cards = execSync('cat /proc/asound/cards', { encoding: 'utf8' });
    for (const line of cards.split('\n')) {
      if (line.includes('USB') || line.includes('Scarlett') || line.includes('Focusrite')) {
        const match = line.match(/^\s*(\d+)\s*\[(\w+)\s*\]:\s*(.*)/);
        if (match) {
          const nextLine = cards.split('\n')[cards.split('\n').indexOf(line) + 1] || '';
          const name = nextLine.trim() || match[3].trim();
          devices.push({ id: `hw:${match[1]},0`, card: match[1], shortName: match[2], name });
        }
      }
    }
  } catch (e) {}
  if (DEVICE && devices.length === 0) devices.push({ id: DEVICE, card: '?', shortName: 'Manual', name: DEVICE });
  return devices;
}

function killAllArecord() {
  try { execSync('killall arecord 2>/dev/null || true', { timeout: 3000 }); } catch (e) {}
  try { execSync('sleep 1'); } catch (e) {}
}

function detectFormat(deviceId) {
  const plugId = deviceId.replace('hw:', 'plughw:');
  const combos = [];
  for (const dev of [deviceId, plugId]) {
    for (const fmt of ['S16_LE', 'S32_LE']) {
      for (const ch of [2, 1]) {
        combos.push({ dev, fmt, ch });
      }
    }
  }
  for (const { dev, fmt, ch } of combos) {
    killAllArecord();
    try {
      const out = execSync(`arecord -D ${dev} -f ${fmt} -c ${ch} -r 48000 -d 1 -t raw /dev/null 2>&1 || true`, { encoding: 'utf8', timeout: 5000 });
      if (out.includes('Recording raw data') || out.includes('Signed')) {
        console.log(`[detect] ${deviceId}: ${dev} ${fmt} ${ch}ch OK`);
        killAllArecord();
        return { format: fmt, channels: ch, deviceId: dev };
      }
    } catch (e) {
      const msg = (e.stderr || '') + (e.stdout || '') + (e.message || '');
      if (msg.includes('Recording raw data') || msg.includes('Signed')) {
        console.log(`[detect] ${deviceId}: ${dev} ${fmt} ${ch}ch OK (from catch)`);
        killAllArecord();
        return { format: fmt, channels: ch, deviceId: dev };
      }
    }
  }
  killAllArecord();
  console.log(`[detect] ${deviceId}: all combos failed, falling back to plughw S32_LE 2ch`);
  return { format: 'S32_LE', channels: 2, deviceId: plugId };
}

function toMono16(buf, format, channels) {
  if (format === 'S32_LE' && channels === 1) {
    const frames = Math.floor(buf.length / 4);
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, buf.readInt32LE(i * 4) >> 16)), i * 2);
    }
    return out;
  }
  if (format === 'S32_LE') {
    const frames = Math.floor(buf.length / 8);
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      const l = buf.readInt32LE(i * 8) >> 16;
      const r = buf.readInt32LE(i * 8 + 4) >> 16;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((l + r) / 2))), i * 2);
    }
    return out;
  }
  if (channels === 1) return buf;
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
      if (!line) continue;
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const device = parts.pop();
      const type = parts.pop();
      const name = parts.join(':');
      if (type === '802-11-wireless') activeNames.add(name);
    }
    const networks = [];
    for (const line of out.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const device = parts.pop();
      const type = parts.pop();
      const name = parts.join(':');
      if (type === '802-11-wireless') {
        networks.push({ ssid: name, active: activeNames.has(name) });
      }
    }
    return { networks };
  } catch (e) {
    return { networks: [], error: 'Could not list networks' };
  }
}

function getCurrentWifi() {
  try {
    const out = execSync('nmcli -t -f NAME,TYPE,DEVICE connection show --active', { encoding: 'utf8', timeout: 5000 });
    for (const line of out.trim().split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3 && parts[1] === '802-11-wireless' && parts[2]) return parts[0];
    }
  } catch (e) {}
  return null;
}

function hasInternet() {
  try {
    execSync('ping -c 1 -W 3 1.1.1.1 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch (e) {}
  try {
    execSync('ping -c 1 -W 3 8.8.8.8 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch (e) {}
  return false;
}

function rollbackWifi(previousSsid) {
  if (!previousSsid) return;
  console.log(`[pi] WiFi switch failed, rolling back to "${previousSsid}"`);
  try {
    execSync(`sudo nmcli connection up "${previousSsid}" 2>&1`, { encoding: 'utf8', timeout: 30000 });
    console.log(`[pi] Rolled back to "${previousSsid}"`);
  } catch (e) {
    console.log(`[pi] Rollback failed, trying device wifi connect`);
    try {
      execSync(`sudo nmcli device wifi connect "${previousSsid}" 2>&1`, { encoding: 'utf8', timeout: 30000 });
    } catch (e2) {
      console.log(`[pi] Rollback to "${previousSsid}" also failed`);
    }
  }
}

function addWifiNetwork(ssid, password) {
  const previousWifi = getCurrentWifi();

  // If no password, try activating a saved connection first
  if (!password) {
    try {
      const out = execSync(`sudo nmcli connection up "${ssid}" 2>&1`, { encoding: 'utf8', timeout: 30000 });
      if (out.includes('successfully activated')) {
        if (!hasInternet()) {
          console.log(`[pi] Connected to "${ssid}" but no internet, rolling back`);
          rollbackWifi(previousWifi);
          return { success: false, error: 'No internet on that network' };
        }
        return { success: true };
      }
    } catch (e) {
      const msg = e.stderr || e.stdout || e.message || '';
      if (msg.includes('key-mgmt') || msg.includes('property is missing')) {
        try { execSync(`sudo nmcli connection delete "${ssid}" 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (e2) {}
        rollbackWifi(previousWifi);
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
      if (!hasInternet()) {
        console.log(`[pi] Connected to "${ssid}" but no internet, rolling back`);
        rollbackWifi(previousWifi);
        return { success: false, error: 'No internet on that network' };
      }
      return { success: true };
    }
    rollbackWifi(previousWifi);
    return { success: false, error: 'Connection failed' };
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message || '';
    let error = msg.split('\n')[0] || 'Connection failed';
    if (msg.includes('Secrets were required') || msg.includes('No suitable device') || msg.includes('password')) {
      error = 'Wrong password';
    } else if (msg.includes('No network with SSID')) {
      error = 'Network not found';
    } else if (msg.includes('key-mgmt') || msg.includes('property is missing')) {
      try { execSync(`sudo nmcli connection delete "${ssid}" 2>/dev/null`, { encoding: 'utf8', timeout: 10000 }); } catch (e2) {}
      error = 'need-password';
    }
    rollbackWifi(previousWifi);
    return { success: false, error };
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
  const allDevices = findAllUSBDevices();
  console.log(`[pi] Found ${allDevices.length} USB audio device(s)`);
  allDevices.forEach(d => console.log(`[pi]   ${d.id} - ${d.name}`));
  console.log(`[pi] Server: ${STREAM_URL}`);
  console.log(`[pi] Capture: ${CAPTURE_RATE}Hz -> ${TARGET_RATE}Hz`);

  // Per-device state: { id, name, format, muted, volume, gain, process, buffer }
  const devices = {};
  for (const d of allDevices) {
    const detected = detectFormat(d.id);
    devices[d.id] = {
      id: d.id, captureId: detected.deviceId, name: d.name, shortName: d.shortName,
      format: detected.format, channels: detected.channels,
      muted: false, volume: 100, gain: 100,
      process: null, buffer: Buffer.alloc(0),
    };
    console.log(`[pi] ${d.id} -> ${detected.deviceId} format: ${detected.format} channels: ${detected.channels}`);
  }
  killAllArecord();

  const socket = io(STREAM_URL, {
    query: { broadcaster: '1', type: 'pi' },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
  });

  let authenticated = false;
  let statusInterval = null;
  let mixInterval = null;

  socket.on('connect', () => {
    console.log('[pi] Connected');
    socket.emit('start-broadcast', BROADCAST_KEY);
  });

  socket.on('status', (data) => {
    if (data.live) {
      console.log('[pi] LIVE');
      authenticated = true;
      startAllCaptures();
      startMixer();
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
    stopAllCaptures();
    stopMixer();
    stopStatus();
  });

  socket.on('reconnect', () => {
    console.log('[pi] Reconnected');
    socket.emit('start-broadcast', BROADCAST_KEY);
  });

  // Device control handlers
  socket.on('set-device', (data, cb) => {
    const dev = devices[data.id];
    if (!dev) { if (cb) cb({ error: 'Unknown device' }); return; }
    if (data.muted !== undefined) dev.muted = data.muted;
    if (data.volume !== undefined) dev.volume = Math.max(0, Math.min(200, data.volume));
    if (data.gain !== undefined) dev.gain = Math.max(0, Math.min(300, data.gain));
    console.log(`[pi] Device ${dev.shortName}: muted=${dev.muted} vol=${dev.volume} gain=${dev.gain}`);
    if (cb) cb({ success: true });
  });

  socket.on('list-devices', (_, cb) => {
    const list = Object.values(devices).map(d => ({
      id: d.id, name: d.name, shortName: d.shortName,
      muted: d.muted, volume: d.volume, gain: d.gain,
    }));
    if (cb) cb(list);
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

  function scanForNewDevices() {
    const current = findAllUSBDevices();
    const newDevices = current.filter(d => !devices[d.id]);
    const currentIds = new Set(current.map(d => d.id));
    const removedIds = Object.keys(devices).filter(id => !currentIds.has(id));

    // Clean up removed devices
    for (const id of removedIds) {
      console.log(`[pi] Device removed: ${id} - ${devices[id].name}`);
      if (devices[id].process) { devices[id].process.kill('SIGTERM'); }
      delete devices[id];
    }

    if (newDevices.length > 0) {
      // Must stop all captures before detection (killAllArecord)
      console.log(`[pi] ${newDevices.length} new device(s), stopping captures for detection...`);
      stopAllCaptures();
      for (const d of newDevices) {
        console.log(`[pi] New device: ${d.id} - ${d.name}`);
        const detected = detectFormat(d.id);
        devices[d.id] = {
          id: d.id, captureId: detected.deviceId, name: d.name, shortName: d.shortName,
          format: detected.format, channels: detected.channels,
          muted: false, volume: 100, gain: 100,
          process: null, buffer: Buffer.alloc(0),
        };
        console.log(`[pi] ${d.id} -> ${detected.deviceId} format: ${detected.format} channels: ${detected.channels}`);
      }
      // Restart all captures
      if (authenticated) startAllCaptures();
    }
  }

  function startStatus() {
    const send = () => {
      scanForNewDevices();
      const deviceList = Object.values(devices).map(d => ({
        id: d.id, name: d.name, shortName: d.shortName,
        muted: d.muted, volume: d.volume, gain: d.gain,
        active: !!d.process,
      }));
      socket.emit('pi-status', {
        network: getNetworkInfo(), uptime: os.uptime(),
        devices: deviceList, deviceCount: deviceList.length,
      });
    };
    send();
    statusInterval = setInterval(send, 10000);
  }

  function stopStatus() {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  }

  function startCapture(dev) {
    if (dev.process) return;
    const args = ['-D', dev.captureId, '-f', dev.format, '-c', String(dev.channels), '-r', String(CAPTURE_RATE), '-t', 'raw', '--buffer-size', '1024'];
    console.log(`[pi] arecord ${dev.shortName}: ${args.join(' ')}`);
    dev.process = spawn('arecord', args);

    dev.process.stdout.on('data', (chunk) => {
      if (!authenticated) return;
      const mono = downsample(toMono16(chunk, dev.format, dev.channels), CAPTURE_RATE, TARGET_RATE);
      dev.buffer = Buffer.concat([dev.buffer, mono]);
      // Prevent buffer from growing too large (max ~1 second of audio)
      if (dev.buffer.length > TARGET_RATE * 2) {
        dev.buffer = dev.buffer.slice(dev.buffer.length - TARGET_RATE * 2);
      }
    });

    dev.process.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('overrun')) console.log(`[arecord:${dev.shortName}] ${msg}`);
    });

    dev.process.on('close', (code) => {
      console.log(`[pi] arecord ${dev.shortName} exited (${code})`);
      dev.process = null;
      if (authenticated) setTimeout(() => startCapture(dev), 2000);
    });
  }

  function startAllCaptures() {
    Object.values(devices).forEach(d => startCapture(d));
  }

  function stopAllCaptures() {
    Object.values(devices).forEach(d => {
      if (d.process) { d.process.kill('SIGTERM'); d.process = null; }
      d.buffer = Buffer.alloc(0);
    });
  }

  function startMixer() {
    if (mixInterval) return;
    mixInterval = setInterval(() => {
      if (!authenticated) return;
      const activeDevs = Object.values(devices).filter(d => d.buffer.length > 0 && !d.muted);
      if (activeDevs.length === 0) return;

      // Find the smallest buffer size across active devices
      const minLen = Math.min(...activeDevs.map(d => d.buffer.length));
      if (minLen < 64) return; // Wait for more data

      // Use minLen aligned to 2 bytes (S16 samples)
      const chunkLen = minLen - (minLen % 2);
      const mixed = Buffer.alloc(chunkLen);

      for (let i = 0; i < chunkLen; i += 2) {
        let sum = 0;
        for (const dev of activeDevs) {
          let sample = dev.buffer.readInt16LE(i);
          sample = Math.round(sample * (dev.volume / 100) * (dev.gain / 100));
          sum += sample;
        }
        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
      }

      // Remove consumed bytes from each active device buffer
      activeDevs.forEach(d => {
        d.buffer = d.buffer.slice(chunkLen);
      });
      // Also drain muted device buffers so they don't accumulate
      Object.values(devices).forEach(d => {
        if (d.muted && d.buffer.length > 0) {
          d.buffer = d.buffer.slice(Math.min(chunkLen, d.buffer.length));
        }
      });

      socket.emit('audio', mixed);
    }, 50);
  }

  function stopMixer() {
    if (mixInterval) { clearInterval(mixInterval); mixInterval = null; }
  }

  function cleanup() {
    socket.emit('stop-broadcast');
    stopAllCaptures();
    stopMixer();
    stopStatus();
    socket.close();
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

start();
