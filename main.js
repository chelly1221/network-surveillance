const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const dgram = require('dgram');

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
let captureSession = null;
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
    capture_mode: 'all',
    topology: null
  };
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      settings = { ...defaults, ...data };
    } else {
      settings = defaults;
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
    settings = defaults;
  }
  return settings;
}

function saveSettings(newSettings) {
  if (newSettings) {
    settings = { ...settings, ...newSettings };
  }
  try {
    const settingsPath = getSettingsPath();
    const tmpPath = settingsPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 4), 'utf-8');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// --- Sound ---
function getSoundFilePath() {
  if (settings.sound_file && fs.existsSync(settings.sound_file)) {
    return settings.sound_file;
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
    if (!/^[a-zA-Z0-9.\-]+$/.test(address)) {
      resolve(false);
      return;
    }
    const child = execFile('ping', ['-n', '1', '-w', '4000', address], { timeout: 6000 }, (error, stdout) => {
      const idx = activeChildProcesses.indexOf(child);
      if (idx !== -1) activeChildProcesses.splice(idx, 1);
      if (error) {
        resolve(false);
      } else {
        resolve(/\bTTL[=]/i.test(stdout));
      }
    });
    activeChildProcesses.push(child);
  });
}

// --- UDP ---
function sendUdpNotification(message) {
  if (!settings.udp_enabled) return;
  try {
    const client = dgram.createSocket('udp4');
    client.on('error', (err) => {
      console.error('UDP socket error:', err);
      client.close();
    });
    const buf = Buffer.from(message || settings.udp_message);
    const port = parseInt(settings.udp_port, 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      client.close();
      return;
    }
    client.send(buf, port, settings.udp_ip, (err) => {
      client.close();
      if (err) console.error('UDP send error:', err);
    });
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

function startCapture() {
  if (!npcapAvailable) return;
  stopCapture();

  // Use user-selected device or auto-detect
  let netInfo;
  if (settings.capture_device) {
    try {
      const devices = Cap.deviceList();
      const dev = devices.find(d => d.name === settings.capture_device);
      if (dev) {
        // Find first IPv4 address on this device
        const addr = dev.addresses.find(a => a.addr && a.addr !== '127.0.0.1' && a.addr.includes('.'));
        const allAddrs = dev.addresses
          .filter(a => a.addr && a.addr !== '127.0.0.1' && a.addr.includes('.'))
          .map(a => a.addr);
        netInfo = addr ? { device: dev.name, ip: addr.addr, allIps: allAddrs } : null;
      }
    } catch (e) {
      console.error('Failed to use selected capture device:', e);
    }
  }
  if (!netInfo) {
    netInfo = detectNetworkInterface();
  }
  if (!netInfo) {
    console.log('No suitable network interface found for capture');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-error', 'No suitable network interface found for capture');
    }
    return;
  }
  localIp = netInfo.ip;
  localIps = new Set(netInfo.allIps || [netInfo.ip]);

  const targets = (settings.targets || []).filter(t => t.name && t.address && t.enabled);

  targetIpSet = new Set(targets.map(t => t.address));

  // Always capture all IPv4 traffic
  const filter = 'ip';

  try {
    const cap = new Cap();
    const buffer = Buffer.alloc(65535);
    const linkType = cap.open(netInfo.device, filter, 10 * 1024 * 1024, buffer);
    if (cap.setMinBytes) cap.setMinBytes(0);

    cap.on('packet', (nbytes, trunc) => {
      if (linkType !== 'ETHERNET') return;
      try {
        let ret = decoders.Ethernet(buffer);
        let ipv4Offset = ret.offset;
        let isIPv4 = false;
        if (ret.info.type === PROTOCOL.ETHERNET.IPV4) {
          isIPv4 = true;
        } else if (ret.info.type === 0x8100 && nbytes > ret.offset + 4) {
          // VLAN tagged frame - check inner EtherType
          const innerType = buffer.readUInt16BE(ret.offset + 2);
          if (innerType === 0x0800) {
            ipv4Offset = ret.offset + 4; // skip VLAN tag
            isIPv4 = true;
          }
        }
        if (isIPv4) {
          const ipv4 = decoders.IPV4(buffer, ipv4Offset);
          const { srcaddr, dstaddr, totallen, protocol } = ipv4.info;
          const transportOffset = ipv4.offset;

          const srcNonDevice = isNonDeviceIp(srcaddr);
          const dstNonDevice = isNonDeviceIp(dstaddr);
          // Skip if both endpoints are non-device addresses
          if (srcNonDevice && dstNonDevice) return;

          let protoName = 'other';
          if (protocol === PROTOCOL.IP.TCP) protoName = 'tcp';
          else if (protocol === PROTOCOL.IP.UDP) protoName = 'udp';
          else if (protocol === PROTOCOL.IP.ICMP) protoName = 'icmp';

          // ASTERIX detection on UDP packets
          if (protocol === PROTOCOL.IP.UDP && transportOffset + 8 <= nbytes) {
            try {
              const udpInfo = decoders.UDP(buffer, transportOffset);
              // Only parse ASTERIX for high port numbers (skip DNS, NTP, etc.)
              if (udpInfo.info.srcport >= 10000 || udpInfo.info.dstport >= 10000) {
                const payloadOff = udpInfo.offset;
                const payloadLen = Math.min(udpInfo.info.length - 8, nbytes - payloadOff);
                if (payloadLen >= 3) {
                  const cats = parseAsterixPayload(buffer, payloadOff, payloadLen);
                  if (cats.length > 0 && !srcNonDevice) {
                    // Use real src; for multicast/broadcast dst, attribute to src only
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

          // Inter-node traffic: both src and dst are monitored targets
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

          // Discovered node ↔ target traffic
          const srcIsLocal = localIps.has(srcaddr);
          const dstIsLocal = localIps.has(dstaddr);
          if (!srcIsLocal && !dstIsLocal && (srcIsTarget !== dstIsTarget)) {
            // Only register real device IPs as discovered nodes (not broadcast/multicast)
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

          // Track traffic between non-target IPs as discovered nodes
          if (!srcIsTarget && !dstIsTarget && !srcIsLocal && !dstIsLocal) {
            // Only record from source perspective to avoid double-counting
            if (!isNonDeviceIp(srcaddr)) {
              if (!discoveredStats[srcaddr]) {
                discoveredStats[srcaddr] = { connections: {} };
              }
              if (!isNonDeviceIp(dstaddr)) {
                // Register dstaddr as a discovered node if not already present
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
              // If dstaddr is broadcast/multicast, srcaddr is still registered as a node (no connection recorded)
            }
            return;
          }

          // Local PC ↔ non-target: register remote IP as discovered node (e.g. streaming, web)
          if ((srcIsLocal || dstIsLocal) && !srcIsTarget && !dstIsTarget) {
            const remoteIp = srcIsLocal ? dstaddr : srcaddr;
            if (!isNonDeviceIp(remoteIp)) {
              if (!discoveredStats[remoteIp]) {
                discoveredStats[remoteIp] = { connections: {} };
              }
              // Connect to hub (localIp)
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

          // Hub ↔ target traffic (includes discovered→target)
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

    captureSession = cap;

    // Send aggregated stats to renderer every second
    trafficTimer = setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (Object.keys(trafficStats).length > 0) {
          mainWindow.webContents.send('traffic-stats', trafficStats);
        }
        if (Object.keys(interNodeStats).length > 0) {
          mainWindow.webContents.send('internode-stats', Object.values(interNodeStats));
        }
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
          mainWindow.webContents.send('discovered-nodes', recentDiscovered);
        }

        if (Object.keys(asterixFlows).length > 0) {
          mainWindow.webContents.send('asterix-flows', Object.values(asterixFlows));
        }
      }
      trafficStats = {};
      interNodeStats = {};
      discoveredStats = {};
      asterixFlows = {};
    }, 1000);

    console.log(`Packet capture started on ${netInfo.ip} (${netInfo.device})`);
  } catch (e) {
    console.error('Failed to start capture:', e);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-error', 'Failed to start capture: ' + (e.message || String(e)));
    }
  }
}

function stopCapture() {
  if (captureSession) {
    try { captureSession.close(); } catch (e) {}
    captureSession = null;
  }
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

// --- Ping loop ---
function startPinging() {
  if (running) return;
  running = true;
  const myGeneration = ++pingGeneration;
  targetStatus = {};

  const targets = settings.targets || [];
  const interval = Math.max((settings.ping_interval || 1), 1) * 1000;
  let activeCount = 0;

  targets.forEach((target, index) => {
    if (!target.name || !target.address || !target.enabled) return;
    activeCount++;

    const doPing = async () => {
      if (myGeneration !== pingGeneration) return;
      const result = await ping(target.address);
      if (myGeneration !== pingGeneration) return;  // Guard after await
      const status = result ? '성공' : '장애';
      const now = new Date();
      const timestamp = now.toTimeString().split(' ')[0]; // HH:MM:SS

      targetStatus[index] = { status, timestamp };

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ping-result', { index, name: target.name, address: target.address, status, timestamp });
      }

      if (status === '장애' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('failure-log', { name: target.name, address: target.address, status, timestamp });
      }
    };

    // Run first ping immediately
    doPing();
    const timer = setInterval(doPing, interval);
    pingIntervalTimers.push(timer);
  });

  // Start packet capture alongside pinging
  startCapture();

  if (activeCount > 0) {
    // Alarm loop: check every 3 seconds
    alarmTimer = setInterval(() => {
      const statuses = Object.values(targetStatus);
      if (statuses.length === 0) return; // No results yet, skip
      const anyFailed = statuses.some(s => s.status === '장애');
      if (anyFailed) {
        // Play sound
        if (!settings.mute_state && settings.sound_enabled) {
          const soundPath = getSoundFilePath();
          if (soundPath && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('play-sound', soundPath);
          }
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
  running = false;
  stopCapture();
  pingIntervalTimers.forEach(t => clearInterval(t));
  pingIntervalTimers = [];
  if (alarmTimer) {
    clearInterval(alarmTimer);
    alarmTimer = null;
  }
  activeChildProcesses.forEach(child => {
    try { child.kill(); } catch (e) {}
  });
  activeChildProcesses = [];
  targetStatus = {};
}

// --- Electron App ---
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximized');
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-unmaximized');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
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

app.on('window-all-closed', () => {
  stopPinging();
  app.quit();
});

// --- IPC Handlers ---
ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle('save-settings', (event, newSettings) => {
  saveSettings(newSettings);
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
  if (soundPath && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('play-sound', soundPath);
    return true;
  }
  return false;
});

ipcMain.handle('update-mute', (event, mute) => {
  settings.mute_state = mute;
  saveSettings();
});

ipcMain.handle('get-sound-path', () => {
  return getSoundFilePath();
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
  settings.capture_device = captureSettings.capture_device || '';
  settings.capture_mode = captureSettings.capture_mode || 'all';
  saveSettings();
  return settings;
});
