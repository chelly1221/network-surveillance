const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const dgram = require('dgram');

let mainWindow;
let pingIntervalTimers = [];
let alarmTimer = null;
let running = false;
let targetStatus = {};
let settings = {};
let activeChildProcesses = [];

// --- Settings file path (portable: next to exe) ---
function getSettingsPath() {
  if (app.isPackaged) {
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
    mute_state: false
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
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 4), 'utf-8');
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
    const child = execFile('ping', ['-n', '1', '-w', '4000', address], { timeout: 6000 }, (error, stdout) => {
      const idx = activeChildProcesses.indexOf(child);
      if (idx !== -1) activeChildProcesses.splice(idx, 1);
      if (error) {
        resolve(false);
      } else {
        resolve(stdout.includes('TTL'));
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
    if (isNaN(port) || port < 0 || port > 65535) return;
    client.send(buf, port, settings.udp_ip, (err) => {
      client.close();
      if (err) console.error('UDP send error:', err);
    });
  } catch (e) {
    console.error('UDP error:', e);
  }
}

// --- Ping loop ---
function startPinging() {
  if (running) return;
  running = true;
  targetStatus = {};

  const targets = settings.targets || [];
  const interval = Math.max((settings.ping_interval || 1), 1) * 1000;
  let activeCount = 0;

  targets.forEach((target, index) => {
    if (!target.name || !target.address || !target.enabled) return;
    activeCount++;

    const doPing = async () => {
      if (!running) return;
      const result = await ping(target.address);
      if (!running) return;  // Guard after await
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

  if (activeCount > 0) {
    // Alarm loop: check every 3 seconds
    alarmTimer = setInterval(() => {
      const anyFailed = Object.values(targetStatus).some(s => s.status === '장애');
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
