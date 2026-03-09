const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  startPinging: () => ipcRenderer.invoke('start-pinging'),
  stopPinging: () => ipcRenderer.invoke('stop-pinging'),
  browseSoundFile: () => ipcRenderer.invoke('browse-sound-file'),
  testSound: () => ipcRenderer.invoke('test-sound'),
  updateMute: (mute) => ipcRenderer.invoke('update-mute', mute),
  getSoundPath: () => ipcRenderer.invoke('get-sound-path'),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Events from main process
  onPingResult: (callback) => ipcRenderer.on('ping-result', (_, data) => callback(data)),
  onFailureLog: (callback) => ipcRenderer.on('failure-log', (_, data) => callback(data)),
  onPlaySound: (callback) => ipcRenderer.on('play-sound', (_, path) => callback(path)),
  onTrafficStats: (callback) => ipcRenderer.on('traffic-stats', (_, data) => callback(data)),
  onInterNodeStats: (callback) => ipcRenderer.on('internode-stats', (_, data) => callback(data)),
  onDiscoveredNodes: (callback) => ipcRenderer.on('discovered-nodes', (_, data) => callback(data)),
  onAsterixFlows: (callback) => ipcRenderer.on('asterix-flows', (_, data) => callback(data)),
  onCaptureError: (callback) => ipcRenderer.on('capture-error', (_, msg) => callback(msg)),
  onWindowMaximized: (callback) => ipcRenderer.on('window-maximized', () => callback()),
  onWindowUnmaximized: (callback) => ipcRenderer.on('window-unmaximized', () => callback()),

  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  isNpcapAvailable: () => ipcRenderer.invoke('is-npcap-available'),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
  saveCaptureSettings: (settings) => ipcRenderer.invoke('save-capture-settings', settings),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
