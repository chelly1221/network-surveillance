const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const dgram = require('dgram');

// --- Global error handlers (prevent crash on unhandled rejections) ---
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main process:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in main process:', reason);
});

// --- Packet Capture (Npcap) ---
let Cap, decoders, PROTOCOL;
let npcapAvailable = false;
try {
  const capModule = require('cap');
  Cap = capModule.Cap;
  decoders = capModule.decoders;
  PROTOCOL = decoders.PROTOCOL;
  npcapAvailable = true;
} catch (e) {
  console.log('Npcap/cap module not available. Packet capture disabled.');
}

let mainWindow;
let pingIntervalTimers = [];
let alarmTimer = null;
let running = false;
let pingGeneration = 0;
let targetStatus = {};
let settings = {};
let activeChildProcesses = [];
let captureSessions = [];
let trafficStats = {};
let interNodeStats = {};
let discoveredStats = {};
let discoveredIpTracker = {};
let asterixFlows = {};  // { "src>dst": { src, dst, cats: { 48: { bytes, count } }, totalBytes } }
let trafficTimer = null;
let localIps = new Set();
let localIp = '';
let targetIpSet = new Set();
const nonDeviceIpCache = new Map();

const KNOWN_ASTERIX_CATS = new Set([1,2,4,8,10,11,19,20,21,23,30,34,48,62,63,65,240,247]);

function isNonDeviceIp(ip) {
  if (!ip) return true;
  if (nonDeviceIpCache.has(ip)) return nonDeviceIpCache.get(ip);
  const parts = ip.split('.');
  let result;
  if (parts.length !== 4) {
    result = true;
  } else {
    const a = parseInt(parts[0], 10);
    const d = parseInt(parts[3], 10);
    // Broadcast: 255.255.255.255 or subnet broadcast x.x.x.255
    if (ip === '255.255.255.255' || d === 255) result = true;
    // Multicast: 224.0.0.0 ~ 239.255.255.255
    else if (a >= 224 && a <= 239) result = true;
    // Loopback: 127.x.x.x
    else if (a === 127) result = true;
    // Link-local: 169.254.x.x
    else if (a === 169 && parseInt(parts[1], 10) === 254) result = true;
    // 0.0.0.0
    else if (ip === '0.0.0.0') result = true;
    else result = false;
  }
  if (nonDeviceIpCache.size >= 10000) nonDeviceIpCache.clear();
  nonDeviceIpCache.set(ip, result);
  return result;
}

function parseAsterixPayload(buffer, offset, maxLen) {
  const cats = [];
  let pos = offset;
  const end = offset + maxLen;
  while (pos + 3 <= end) {
    const cat = buffer[pos];
    const len = (buffer[pos + 1] << 8) | buffer[pos + 2];
    if (len < 3 || pos + len > end || !KNOWN_ASTERIX_CATS.has(cat)) break;
    cats.push({ cat, len });
    pos += len;
  }
  // Valid only if all blocks parsed cleanly
  if (cats.length > 0 && pos === end) return cats;
  return [];
}

// --- Settings file path (portable: next to exe) ---
function getSettingsPath() {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      return path.join(portableDir, 'settings.json');
    }
    return path.join(path.dirname(process.execPath), 'settings.json');
  }
  return path.join(__dirname, 'settings.json');
}

function loadSettings() {
  const settingsPath = getSettingsPath();
  const defaults = {
    targets: [],
    ping_interval: 1,
    udp_enabled: false,
    udp_ip: '192.168.1.160',
    udp_port: '5005',
    udp_message: '2',
    udp_no_failure_message: '1',
    sound_enabled: true,
    sound_file: '',
    mute_state: false,
    capture_device: '',
    capture_devices: [],
    capture_mode: 'all',
    topology: null
  };
  try {
    if (fs.existsSync(settingsPath)) {
      let raw = fs.readFileSync(settingsPath, 'utf-8');
      // Strip UTF-8 BOM (common when edited with Windows Notepad)
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      try {
        let data = sanitizeObject(JSON.parse(raw));
        const filtered = {};
        for (const key of Object.keys(data)) {
          if (ALLOWED_SETTINGS_KEYS.has(key)) filtered[key] = data[key];
        }
        settings = { ...defaults, ...filtered };
      } catch (parseErr) {
        console.error('Settings file is malformed, backing up:', parseErr);
        try {
          fs.copyFileSync(settingsPath, settingsPath + '.backup_' + Date.now());
        } catch (backupErr) {
          console.error('Failed to backup corrupted settings:', backupErr);
        }
        settings = { ...defaults };
      }
      if (!Array.isArray(settings.targets)) settings.targets = [];
      // Normalize target entries
      settings.targets = settings.targets
        .filter(t => t && typeof t === 'object')
        .map(t => ({
          name: String(t.name || '').trim(),
          address: String(t.address || '').trim(),
          enabled: t.enabled !== false,
          type: ['pc', 'router', 'switch', 'server'].includes(t.type) ? t.type : 'pc'
        }));
      // Validate key types
      if (typeof settings.ping_interval !== 'number' || settings.ping_interval < 1 || settings.ping_interval > 3600) settings.ping_interval = defaults.ping_interval;
      if (typeof settings.udp_port !== 'string') settings.udp_port = String(settings.udp_port || defaults.udp_port);
      if (typeof settings.mute_state !== 'boolean') settings.mute_state = defaults.mute_state;
      if (typeof settings.udp_enabled !== 'boolean') settings.udp_enabled = defaults.udp_enabled;
      if (typeof settings.sound_enabled !== 'boolean') settings.sound_enabled = defaults.sound_enabled;
      if (settings.udp_ip && typeof settings.udp_ip === 'string') {
        const udpParts = settings.udp_ip.split('.');
        const validUdpIp = udpParts.length === 4 && udpParts.every(p => {
          const n = parseInt(p, 10);
          return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
        });
        if (!validUdpIp) settings.udp_ip = defaults.udp_ip;
      }
      if (!['all'].includes(settings.capture_mode)) settings.capture_mode = defaults.capture_mode;
      if (!Array.isArray(settings.capture_devices)) settings.capture_devices = defaults.capture_devices;
    } else {
      settings = { ...defaults };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
    settings = { ...defaults };
  }
  return settings;
}

const ALLOWED_SETTINGS_KEYS = new Set([
  'targets', 'ping_interval', 'udp_enabled', 'udp_ip', 'udp_port',
  'udp_message', 'udp_no_failure_message', 'sound_enabled', 'sound_file',
  'mute_state', 'capture_device', 'capture_devices', 'capture_mode', 'topology'
]);

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  const clean = {};
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = typeof obj[key] === 'object' ? sanitizeObject(obj[key]) : obj[key];
  }
  return clean;
}

function saveSettings(newSettings) {
  let filtered;
  if (newSettings) {
    filtered = {};
    for (const key of Object.keys(newSettings)) {
      if (ALLOWED_SETTINGS_KEYS.has(key)) filtered[key] = newSettings[key];
    }
  }
  const merged = filtered ? { ...settings, ...filtered } : { ...settings };
  try {
    const settingsPath = getSettingsPath();
    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 4), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
    settings = merged;  // Only update in-memory state after successful write
    return true;
  } catch (e) {
    console.error('Failed to save settings:', e);
    // Clean up orphaned tmp file
    try { fs.unlinkSync(getSettingsPath() + '.tmp'); } catch (_) {}
    return false;
  }
}

// --- Sound ---
function getSoundFilePath() {
  if (settings.sound_file) {
    const ext = path.extname(settings.sound_file).toLowerCase();
    if ((ext === '.wav' || ext === '.mp3' || ext === '.ogg') && fs.existsSync(settings.sound_file)) {
      return settings.sound_file;
    }
  }
  // Default sound in assets
  const assetSound = app.isPackaged
    ? path.join(process.resourcesPath, 'failed.wav')
    : path.join(__dirname, 'assets', 'failed.wav');
  if (fs.existsSync(assetSound)) return assetSound;
  return null;
}

// --- Ping ---
function ping(address) {
  return new Promise((resolve) => {
    if (!/^[a-zA-Z0-9]+([.\-][a-zA-Z0-9]+)*$/.test(address) || address.length > 253) {
      resolve(false);
      return;
    }
    // Safeguard: skip if too many pending processes
    if (activeChildProcesses.length > 200) {
      console.warn('Too many pending ping processes, skipping');
      resolve(false);
      return;
    }
    let resolved = false;
    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;
      const idx = activeChildProcesses.indexOf(child);
      if (idx !== -1) activeChildProcesses.splice(idx, 1);
      resolve(result);
    };
    const child = execFile('ping', ['-n', '1', '-w', '4000', address], { timeout: 5500 }, (error, stdout) => {
      if (error) {
        cleanup(false);
      } else {
        cleanup(/\bTTL[=]/i.test(stdout));
      }
    });
    child.on('error', () => cleanup(false));
    activeChildProcesses.push(child);
  });
}

// --- UDP ---
function sendUdpNotification(message) {
  if (!settings.udp_enabled) return;
  try {
    // Validate before creating socket
    const targetIp = settings.udp_ip;
    const port = parseInt(settings.udp_port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.warn('Invalid UDP port:', settings.udp_port);
      return;
    }
    if (!targetIp) {
      console.warn('UDP IP not configured');
      return;
    }
    const msg = message || settings.udp_message;
    if (!msg) return;
    const buf = Buffer.from(String(msg));

    const client = dgram.createSocket('udp4');
    let closed = false;
    let timeoutHandle = null;
    const safeClose = () => {
      if (!closed) {
        closed = true;
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        try { client.close(); } catch (e) {}
      }
    };
    client.on('error', (err) => {
      console.error(`UDP socket error sending to ${targetIp}:${port}:`, err.message);
      safeClose();
    });
    client.send(buf, port, targetIp, (err) => {
      safeClose();
      if (err) console.error('UDP send error:', err);
    });
    // Timeout safeguard: force close if send doesn't complete
    timeoutHandle = setTimeout(() => safeClose(), 3000);
  } catch (e) {
    console.error('UDP error:', e);
  }
}

// --- Packet Capture ---
function detectNetworkInterface() {
  if (!npcapAvailable) return null;
  try {
    const devices = Cap.deviceList();
    const targetIps = (settings.targets || [])
      .filter(t => t.name && t.address && t.enabled)
      .map(t => t.address);

    // Try to find a device on the same subnet as targets
    for (const dev of devices) {
      for (const addr of dev.addresses) {
        if (!addr.addr || addr.addr === '127.0.0.1' || !addr.addr.includes('.')) continue;
        if (!addr.netmask) continue;
        // Check if any target is on this subnet
        const localParts = addr.addr.split('.').map(Number);
        const maskParts = addr.netmask.split('.').map(Number);
        for (const tip of targetIps) {
          const tipParts = tip.split('.').map(Number);
          if (tipParts.length !== 4 || tipParts.some(isNaN)) continue;
          const sameSubnet = localParts.every((lp, i) => (lp & maskParts[i]) === (tipParts[i] & maskParts[i]));
          if (sameSubnet) {
            const allIps = dev.addresses
              .filter(a => a.addr && a.addr !== '127.0.0.1' && a.addr.includes('.'))
              .map(a => a.addr);
            return { device: dev.name, ip: addr.addr, allIps };
          }
        }
      }
    }
    // Fallback: first device with IPv4
    for (const dev of devices) {
      for (const addr of dev.addresses) {
        if (addr.addr && addr.addr !== '127.0.0.1' && addr.addr.includes('.')) {
          const allIps = dev.addresses
            .filter(a => a.addr && a.addr !== '127.0.0.1' && a.addr.includes('.'))
            .map(a => a.addr);
          return { device: dev.name, ip: addr.addr, allIps };
        }
      }
    }
  } catch (e) {
    console.error('Network interface detection failed:', e);
  }
  return null;
}

function getSelectedDevices() {
  // Build list of enabled device names from settings
  const captureDevices = settings.capture_devices || [];
  const enabled = captureDevices.filter(cd => cd && cd.name && cd.enabled !== false).map(cd => cd.name);
  // Legacy single device support
  if (enabled.length === 0 && settings.capture_device) {
    enabled.push(settings.capture_device);
  }
  return enabled;
}

function resolveDeviceInfos(selectedNames) {
  try {
    const devices = Cap.deviceList();
    const infos = [];
    for (const name of selectedNames) {
      const dev = devices.find(d => d.name === name);
      if (!dev) continue;
      const addr = dev.addresses.find(a => a.addr && a.addr !== '127.0.0.1' && a.addr.includes('.'));
      const allAddrs = dev.addresses
        .filter(a => a.addr && a.addr !== '127.0.0.1' && a.addr.includes('.'))
        .map(a => a.addr);
      if (addr) infos.push({ device: dev.name, ip: addr.addr, allIps: allAddrs });
    }
    return infos;
  } catch (e) {
    console.error('Failed to resolve capture devices:', e);
    return [];
  }
}

function startCapture() {
  if (!npcapAvailable) return;
  stopCapture();

  // Resolve selected devices or auto-detect
  const selectedNames = getSelectedDevices();
  let netInfos = selectedNames.length > 0 ? resolveDeviceInfos(selectedNames) : [];
  if (netInfos.length === 0) {
    const auto = detectNetworkInterface();
    if (auto) netInfos = [auto];
  }
  if (netInfos.length === 0) {
    console.log('No suitable network interface found for capture');
    safeSend('capture-error', 'No suitable network interface found for capture');
    return;
  }
  // Merge all local IPs from all devices
  localIp = netInfos[0].ip;
  localIps = new Set();
  for (const ni of netInfos) {
    for (const ip of (ni.allIps || [ni.ip])) localIps.add(ip);
  }

  const targets = (settings.targets || []).filter(t => t.name && t.address && t.enabled);
  targetIpSet = new Set(targets.map(t => t.address));

  const filter = 'ip';

  // Open capture session for each device
  for (const netInfo of netInfos) {
    try {
      const cap = new Cap();
      const buffer = Buffer.alloc(65535);
      const linkType = cap.open(netInfo.device, filter, 10 * 1024 * 1024, buffer);
      if (cap.setMinBytes) cap.setMinBytes(0);

      cap.on('packet', (nbytes, trunc) => {
        if (linkType !== 'ETHERNET') return;
        if (nbytes < 14) return;
        try {
          let ret = decoders.Ethernet(buffer);
          let ipv4Offset = ret.offset;
          let isIPv4 = false;
          if (ret.info.type === PROTOCOL.ETHERNET.IPV4) {
            isIPv4 = true;
          } else if (ret.info.type === 0x8100 && nbytes > ret.offset + 4) {
            const innerType = buffer.readUInt16BE(ret.offset + 2);
            if (innerType === 0x0800) {
              ipv4Offset = ret.offset + 4;
              if (nbytes < ipv4Offset + 20) return;
              isIPv4 = true;
            }
          }
          if (isIPv4) {
            const ipv4 = decoders.IPV4(buffer, ipv4Offset);
            const { srcaddr, dstaddr, totallen, protocol } = ipv4.info;
            const transportOffset = ipv4.offset;

            const srcNonDevice = isNonDeviceIp(srcaddr);
            const dstNonDevice = isNonDeviceIp(dstaddr);
            if (srcNonDevice && dstNonDevice) return;

            let protoName = 'other';
            if (protocol === PROTOCOL.IP.TCP) protoName = 'tcp';
            else if (protocol === PROTOCOL.IP.UDP) protoName = 'udp';
            else if (protocol === PROTOCOL.IP.ICMP) protoName = 'icmp';

            // ASTERIX detection on UDP packets
            if (protocol === PROTOCOL.IP.UDP && transportOffset + 8 <= nbytes) {
              try {
                const udpInfo = decoders.UDP(buffer, transportOffset);
                if (udpInfo.info.srcport >= 10000 || udpInfo.info.dstport >= 10000) {
                  const payloadOff = udpInfo.offset;
                  const payloadLen = Math.min(udpInfo.info.length - 8, nbytes - payloadOff);
                  if (payloadLen >= 3) {
                    const cats = parseAsterixPayload(buffer, payloadOff, payloadLen);
                    if (cats.length > 0 && !srcNonDevice) {
                      const effectiveDst = dstNonDevice ? srcaddr : dstaddr;
                      const akey = srcaddr + '>' + effectiveDst;
                      if (!asterixFlows[akey]) {
                        asterixFlows[akey] = { src: srcaddr, dst: effectiveDst, cats: {}, totalBytes: 0 };
                      }
                      const af = asterixFlows[akey];
                      af.totalBytes += totallen;
                      for (const c of cats) {
                        if (!af.cats[c.cat]) af.cats[c.cat] = { bytes: 0, count: 0 };
                        af.cats[c.cat].bytes += c.len;
                        af.cats[c.cat].count++;
                      }
                    }
                  }
                }
              } catch (e) {}
            }

            const srcIsTarget = targetIpSet.has(srcaddr);
            const dstIsTarget = targetIpSet.has(dstaddr);

            if (srcIsTarget && dstIsTarget) {
              const key = srcaddr + '>' + dstaddr;
              if (!interNodeStats[key]) {
                interNodeStats[key] = { src: srcaddr, dst: dstaddr, bytes: 0, packets: 0, protocols: {} };
              }
              const s = interNodeStats[key];
              s.bytes += totallen;
              s.packets++;
              s.protocols[protoName] = (s.protocols[protoName] || 0) + 1;
              return;
            }

            const srcIsLocal = localIps.has(srcaddr);
            const dstIsLocal = localIps.has(dstaddr);
            if (!srcIsLocal && !dstIsLocal && (srcIsTarget !== dstIsTarget)) {
              const unknownIp = srcIsTarget ? dstaddr : srcaddr;
              const targetIp = srcIsTarget ? srcaddr : dstaddr;
              if (!isNonDeviceIp(unknownIp)) {
                if (!discoveredStats[unknownIp]) {
                  discoveredStats[unknownIp] = { connections: {} };
                }
                if (!discoveredStats[unknownIp].connections[targetIp]) {
                  discoveredStats[unknownIp].connections[targetIp] = { bytes: 0, packets: 0, protocols: {} };
                }
                const dc = discoveredStats[unknownIp].connections[targetIp];
                dc.bytes += totallen;
                dc.packets++;
                dc.protocols[protoName] = (dc.protocols[protoName] || 0) + 1;
              }
            }

            if (!srcIsTarget && !dstIsTarget && !srcIsLocal && !dstIsLocal) {
              if (!isNonDeviceIp(srcaddr)) {
                if (!discoveredStats[srcaddr]) {
                  discoveredStats[srcaddr] = { connections: {} };
                }
                if (!isNonDeviceIp(dstaddr)) {
                  if (!discoveredStats[dstaddr]) {
                    discoveredStats[dstaddr] = { connections: {} };
                  }
                  if (!discoveredStats[srcaddr].connections[dstaddr]) {
                    discoveredStats[srcaddr].connections[dstaddr] = { bytes: 0, packets: 0, protocols: {} };
                  }
                  const dc = discoveredStats[srcaddr].connections[dstaddr];
                  dc.bytes += totallen;
                  dc.packets++;
                  dc.protocols[protoName] = (dc.protocols[protoName] || 0) + 1;
                }
              }
              return;
            }

            if ((srcIsLocal || dstIsLocal) && !srcIsTarget && !dstIsTarget) {
              const remoteIp = srcIsLocal ? dstaddr : srcaddr;
              if (!isNonDeviceIp(remoteIp)) {
                if (!discoveredStats[remoteIp]) {
                  discoveredStats[remoteIp] = { connections: {} };
                }
                if (!discoveredStats[remoteIp].connections[localIp]) {
                  discoveredStats[remoteIp].connections[localIp] = { bytes: 0, packets: 0, protocols: {} };
                }
                const dc = discoveredStats[remoteIp].connections[localIp];
                dc.bytes += totallen;
                dc.packets++;
                dc.protocols[protoName] = (dc.protocols[protoName] || 0) + 1;
              }
              return;
            }

            let targetIp, direction;
            if (srcIsLocal && dstIsTarget) {
              targetIp = dstaddr;
              direction = 'out';
            } else if (dstIsLocal && srcIsTarget) {
              targetIp = srcaddr;
              direction = 'in';
            } else if (srcIsTarget) {
              targetIp = srcaddr;
              direction = 'in';
            } else if (dstIsTarget) {
              targetIp = dstaddr;
              direction = 'out';
            } else {
              return;
            }

            if (!trafficStats[targetIp]) {
              trafficStats[targetIp] = {
                bytesIn: 0, bytesOut: 0,
                packetsIn: 0, packetsOut: 0,
                protocols: {}
              };
            }

            const stats = trafficStats[targetIp];
            if (direction === 'in') {
              stats.bytesIn += totallen;
              stats.packetsIn++;
            } else {
              stats.bytesOut += totallen;
              stats.packetsOut++;
            }
            stats.protocols[protoName] = (stats.protocols[protoName] || 0) + 1;
          }
        } catch (e) { /* ignore decode errors */ }
      });

      captureSessions.push(cap);
      console.log(`Packet capture started on ${netInfo.ip} (${netInfo.device})`);
    } catch (e) {
      console.error(`Failed to start capture on ${netInfo.device}:`, e);
      safeSend('capture-error', 'Failed to start capture on ' + netInfo.device + ': ' + (e.message || String(e)));
    }
  }

  if (captureSessions.length === 0) return;

  // Send aggregated stats to renderer every second
  trafficTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (Object.keys(trafficStats).length > 0) {
        safeSend('traffic-stats', trafficStats);
      }
      safeSend('internode-stats', Object.values(interNodeStats));
      // Merge current discoveredStats into persistent tracker
      const now = Date.now();
      for (const [ip, data] of Object.entries(discoveredStats)) {
        if (!discoveredIpTracker[ip]) {
          discoveredIpTracker[ip] = { connections: {}, totalBytes: 0, lastSeen: 0 };
        }
        const tracker = discoveredIpTracker[ip];
        tracker.lastSeen = now;
        for (const [peerIp, conn] of Object.entries(data.connections)) {
          if (!tracker.connections[peerIp]) {
            tracker.connections[peerIp] = { bytes: 0, packets: 0, protocols: {} };
          }
          const tc = tracker.connections[peerIp];
          tc.bytes += conn.bytes;
          tc.packets += conn.packets;
          for (const [p, c] of Object.entries(conn.protocols)) {
            tc.protocols[p] = (tc.protocols[p] || 0) + c;
          }
          tracker.totalBytes += conn.bytes;
        }
      }

      // Prune stale entries from discoveredIpTracker (older than 2 hours)
      for (const [ip, d] of Object.entries(discoveredIpTracker)) {
        if (now - d.lastSeen > 7200000) {
          delete discoveredIpTracker[ip];
        }
      }

      // Send recently-seen discovered nodes (stable for 30 seconds)
      const recentDiscovered = Object.entries(discoveredIpTracker)
        .filter(([ip, d]) => now - d.lastSeen < 3600000)
        .map(([ip, d]) => ({ ip, connections: d.connections, totalBytes: d.totalBytes }))
        .sort((a, b) => b.totalBytes - a.totalBytes)
        .slice(0, 30);
      if (recentDiscovered.length > 0) {
        safeSend('discovered-nodes', recentDiscovered);
      }

      if (Object.keys(asterixFlows).length > 0) {
        safeSend('asterix-flows', Object.values(asterixFlows));
      }
    }
    trafficStats = {};
    interNodeStats = {};
    discoveredStats = {};
    asterixFlows = {};
  }, 1000);
}

function stopCapture() {
  for (const cap of captureSessions) {
    try { cap.close(); } catch (e) {}
  }
  captureSessions = [];
  if (trafficTimer) {
    clearInterval(trafficTimer);
    trafficTimer = null;
  }
  trafficStats = {};
  interNodeStats = {};
  discoveredStats = {};
  discoveredIpTracker = {};
  asterixFlows = {};
  targetIpSet = new Set();
  localIps = new Set();
}

// --- Safe IPC send helper (prevents TOCTOU race on window destruction) ---
function safeSend(channel, ...args) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send(channel, ...args);
    }
  } catch (e) {
    console.error(`Failed to send IPC '${channel}':`, e.message);
  }
}

// --- Ping loop ---
function startPinging() {
  if (running) stopPinging();  // Clean up before restart
  running = true;
  const myGeneration = ++pingGeneration;
  targetStatus = {};

  const targets = settings.targets || [];
  const interval = Math.max((settings.ping_interval || 1), 1) * 1000;
  let activeCount = 0;

  targets.forEach((target, index) => {
    if (!target.name || !target.address || !target.enabled) return;
    activeCount++;

    let pingInProgress = false;
    const doPing = async () => {
      if (myGeneration !== pingGeneration) return;
      if (pingInProgress) return;  // Prevent overlapping pings per target
      pingInProgress = true;
      try {
        const result = await ping(target.address);
        if (myGeneration !== pingGeneration) return;
        const status = result ? '성공' : '장애';
        const now = new Date();
        const timestamp = now.toTimeString().split(' ')[0]; // HH:MM:SS

        const prevStatus = targetStatus[index] ? targetStatus[index].status : null;
        targetStatus[index] = { status, timestamp };

        safeSend('ping-result', { index, name: target.name, address: target.address, status, timestamp });

        // Event-based logging: only on state transitions
        if (prevStatus !== status) {
          if (status === '장애') {
            safeSend('failure-log', { name: target.name, address: target.address, status: '장애 발생', timestamp });
          } else if (prevStatus === '장애') {
            safeSend('failure-log', { name: target.name, address: target.address, status: '정상 복구', timestamp });
          }
        }
      } finally {
        pingInProgress = false;
      }
    };

    // Run first ping immediately
    doPing().catch(e => console.error('Ping error for', target.address, e));
    const timer = setInterval(() => {
      doPing().catch(e => console.error('Ping error for', target.address, e));
    }, interval);
    pingIntervalTimers.push(timer);
  });

  // Start packet capture alongside pinging (only if there are active targets)
  if (activeCount > 0) {
    startCapture();
  }

  if (activeCount > 0) {
    // Alarm loop: check every 3 seconds
    alarmTimer = setInterval(() => {
      const statuses = Object.values(targetStatus);
      if (statuses.length < activeCount) return; // Wait until all active targets have reported at least once
      const anyFailed = statuses.some(s => s.status === '장애');
      if (anyFailed) {
        // Play sound
        if (!settings.mute_state && settings.sound_enabled) {
          const soundPath = getSoundFilePath();
          if (soundPath) safeSend('play-sound', soundPath);
        }
        if (settings.udp_enabled) {
          sendUdpNotification(settings.udp_message);
        }
      } else {
        if (settings.udp_enabled) {
          sendUdpNotification(settings.udp_no_failure_message);
        }
      }
    }, 3000);
  }
}

function stopPinging() {
  if (!running && pingIntervalTimers.length === 0 && activeChildProcesses.length === 0 && !alarmTimer && captureSessions.length === 0) return;
  running = false;
  pingGeneration++;  // Invalidate in-flight ping callbacks
  stopCapture();
  pingIntervalTimers.forEach(t => clearInterval(t));
  pingIntervalTimers = [];
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
  const childrenToKill = activeChildProcesses;
  activeChildProcesses = [];
  childrenToKill.forEach(child => {
    try { child.kill(); } catch (e) {}
  });
  targetStatus = {};
}

// --- Electron App ---
function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('maximize', () => safeSend('window-maximized'));
  mainWindow.on('unmaximize', () => safeSend('window-unmaximized'));

  mainWindow.on('closed', () => {
    stopPinging();
    mainWindow = null;
  });
}

// --- Single instance lock ---
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  // 한글 IME 및 키보드 단축키 지원을 위한 메뉴 설정
  const menu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  loadSettings();
  createWindow();
});

app.on('before-quit', () => {
  stopPinging();
});

app.on('window-all-closed', () => {
  stopPinging();
  app.quit();
});

// --- IPC Handlers ---
ipcMain.handle('get-settings', () => {
  return settings;
});

const ADDRESS_RE = /^[a-zA-Z0-9]+([.\-][a-zA-Z0-9]+)*$/;

ipcMain.handle('save-settings', (event, newSettings) => {
  if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
    return settings;
  }
  // Defense against prototype pollution (recursive)
  newSettings = sanitizeObject(newSettings);
  // Enforce max 20 targets
  if (Array.isArray(newSettings.targets)) {
    newSettings.targets = newSettings.targets.slice(0, 20);
  }
  // Validate ping_interval if present
  if ('ping_interval' in newSettings) {
    const pi = newSettings.ping_interval;
    if (typeof pi !== 'number' || !Number.isFinite(pi) || pi < 1 || pi > 3600) {
      delete newSettings.ping_interval;
    }
  }
  // Validate target addresses
  if (Array.isArray(newSettings.targets)) {
    newSettings.targets = newSettings.targets.map(t => {
      if (!t || typeof t !== 'object') return t;
      return {
        ...t,
        name: typeof t.name === 'string' ? t.name.trim() : '',
        address: typeof t.address === 'string' ? t.address.trim() : ''
      };
    }).filter(t => {
      if (!t || typeof t !== 'object') return false;
      if (t.address && (!ADDRESS_RE.test(t.address) || t.address.length > 253)) return false;
      return true;
    });
  }
  // Validate topology size
  if ('topology' in newSettings && newSettings.topology) {
    const topo = newSettings.topology;
    if (typeof topo !== 'object' || Array.isArray(topo)) {
      delete newSettings.topology;
    } else {
      if (Array.isArray(topo.devices) && topo.devices.length > 100) {
        topo.devices = topo.devices.slice(0, 100);
      }
      if (Array.isArray(topo.connections) && topo.connections.length > 500) {
        topo.connections = topo.connections.slice(0, 500);
      }
    }
  }
  // Validate UDP IP
  if ('udp_ip' in newSettings) {
    const ip = newSettings.udp_ip;
    if (typeof ip !== 'string' || ip === '') {
      delete newSettings.udp_ip;
    } else {
      const parts = ip.split('.');
      const valid = parts.length === 4 && parts.every(p => {
        const n = parseInt(p, 10);
        return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
      });
      if (!valid) delete newSettings.udp_ip;
    }
  }
  // Validate UDP port
  if ('udp_port' in newSettings) {
    const port = parseInt(newSettings.udp_port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      delete newSettings.udp_port;
    } else {
      newSettings.udp_port = String(port);
    }
  }
  // Validate target name lengths
  if (Array.isArray(newSettings.targets)) {
    newSettings.targets = newSettings.targets.map(t => {
      if (t && typeof t === 'object' && typeof t.name === 'string' && t.name.length > 100) {
        return { ...t, name: t.name.slice(0, 100) };
      }
      return t;
    });
  }
  // Validate UDP message lengths
  if (typeof newSettings.udp_message === 'string' && newSettings.udp_message.length > 1024) {
    newSettings.udp_message = newSettings.udp_message.slice(0, 1024);
  }
  if (typeof newSettings.udp_no_failure_message === 'string' && newSettings.udp_no_failure_message.length > 1024) {
    newSettings.udp_no_failure_message = newSettings.udp_no_failure_message.slice(0, 1024);
  }
  const success = saveSettings(newSettings);
  if (!success) {
    console.error('save-settings: write to disk failed, returning current in-memory settings');
  }
  return settings;
});

ipcMain.handle('start-pinging', () => {
  startPinging();
  return true;
});

ipcMain.handle('stop-pinging', () => {
  stopPinging();
  return true;
});

ipcMain.handle('browse-sound-file', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Wave Files', extensions: ['wav'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('test-sound', () => {
  const soundPath = getSoundFilePath();
  if (soundPath) {
    safeSend('play-sound', soundPath);
    return true;
  }
  return false;
});

ipcMain.handle('update-mute', (event, mute) => {
  if (typeof mute !== 'boolean') return false;
  const success = saveSettings({ mute_state: mute });
  return success;
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.isMaximized();
  return false;
});

ipcMain.handle('is-npcap-available', () => npcapAvailable);
ipcMain.handle('get-local-ip', () => localIp);

ipcMain.handle('get-network-interfaces', () => {
  if (!npcapAvailable) return [];
  try {
    const devices = Cap.deviceList();
    return devices.map(dev => {
      const ipv4Addrs = dev.addresses
        .filter(a => a.addr && a.addr.includes('.') && a.addr !== '127.0.0.1')
        .map(a => a.addr);
      return {
        name: dev.name,
        description: dev.description || '',
        addresses: ipv4Addrs
      };
    }).filter(d => d.addresses.length > 0);
  } catch (e) {
    console.error('Failed to list network interfaces:', e);
    return [];
  }
});

ipcMain.handle('save-capture-settings', (event, captureSettings) => {
  if (!captureSettings || typeof captureSettings !== 'object') return settings;
  const updates = {};
  if (Array.isArray(captureSettings.capture_devices)) {
    updates.capture_devices = captureSettings.capture_devices
      .filter(cd => cd && typeof cd === 'object' && typeof cd.name === 'string')
      .map(cd => ({ name: cd.name, enabled: cd.enabled !== false }));
    updates.capture_device = '';  // Clear legacy field
  }
  const ok = saveSettings(updates);
  if (!ok) console.error('save-capture-settings: failed to persist');
  return settings;
});
