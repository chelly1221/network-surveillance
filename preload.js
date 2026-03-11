const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = [
  'ping-result', 'failure-log', 'play-sound', 'traffic-stats',
  'internode-stats', 'discovered-nodes', 'asterix-flows', 'capture-error',
  'window-maximized', 'window-unmaximized'
];

function onEvent(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  startPinging: () => ipcRenderer.invoke('start-pinging'),
  stopPinging: () => ipcRenderer.invoke('stop-pinging'),
  browseSoundFile: () => ipcRenderer.invoke('browse-sound-file'),
  testSound: () => ipcRenderer.invoke('test-sound'),
  updateMute: (mute) => ipcRenderer.invoke('update-mute', mute),
  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // Events from main process
  onPingResult: (callback) => onEvent('ping-result', callback),
  onFailureLog: (callback) => onEvent('failure-log', callback),
  onPlaySound: (callback) => onEvent('play-sound', callback),
  onTrafficStats: (callback) => onEvent('traffic-stats', callback),
  onInterNodeStats: (callback) => onEvent('internode-stats', callback),
  onDiscoveredNodes: (callback) => onEvent('discovered-nodes', callback),
  onAsterixFlows: (callback) => onEvent('asterix-flows', callback),
  onCaptureError: (callback) => onEvent('capture-error', callback),
  onWindowMaximized: (callback) => onEvent('window-maximized', callback),
  onWindowUnmaximized: (callback) => onEvent('window-unmaximized', callback),

  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  isNpcapAvailable: () => ipcRenderer.invoke('is-npcap-available'),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),
  saveCaptureSettings: (settings) => ipcRenderer.invoke('save-capture-settings', settings),
  removeAllListeners: (channel) => {
    if (typeof channel === 'string' && EVENT_CHANNELS.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  }
});
