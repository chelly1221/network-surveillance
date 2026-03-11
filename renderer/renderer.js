// State
let settings = {};
let isRunning = false;
let failLogs = [];
let currentView = 'table';
let npcapAvailable = false;
let ipToIndex = {};

// DOM Elements
const targetTableBody = document.getElementById('targetTableBody');
const logTableBody = document.getElementById('logTableBody');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnClearLogs = document.getElementById('btnClearLogs');
const chkMute = document.getElementById('chkMute');
const alertAudio = document.getElementById('alertAudio');

// --- Initialize ---
async function init() {
  try {
    settings = await window.api.getSettings();
  } catch (e) {
    console.error('Failed to load settings:', e);
    settings = { targets: [], ping_interval: 1, mute_state: false, sound_enabled: true, sound_file: '', udp_enabled: false };
  }
  chkMute.checked = settings.mute_state || false;
  try {
    npcapAvailable = await window.api.isNpcapAvailable();
  } catch (e) {
    npcapAvailable = false;
  }
  buildIpMap();
  renderTargetTable();
  updateTargetCount();
  updateStatusBar();
  updateNpcapIndicator();
  // Fetch local IP for topology view
  try {
    const lip = await window.api.getLocalIp();
    if (lip && window.view2d) window.view2d.setLocalIp(lip);
  } catch (e) {}
}

function buildIpMap() {
  ipToIndex = {};
  const targets = settings.targets || [];
  targets.forEach((t, i) => {
    if (t.address) ipToIndex[t.address] = i;
  });
  if (window.view2d) window.view2d.setIpMap(ipToIndex);
}

function updateNpcapIndicator() {
  const el = document.getElementById('npcapStatus');
  if (!el) return;
  if (npcapAvailable) {
    el.textContent = 'PCAP';
    el.className = 'npcap-badge active';
    el.title = 'Npcap 패킷 캡처 활성';
  } else {
    el.textContent = 'PCAP';
    el.className = 'npcap-badge';
    el.title = 'Npcap 미설치 - 트래픽 시각화 비활성';
  }
}

// --- Target Table ---
function renderTargetTable() {
  targetTableBody.innerHTML = '';
  const targets = settings.targets || [];
  targets.forEach((target, index) => {
    if (!target.name || !target.address) return;
    const tr = document.createElement('tr');
    tr.id = `target-${index}`;

    if (!target.enabled) {
      tr.className = 'status-disabled';
      tr.innerHTML = `
        <td>${escapeHtml(target.name)}</td>
        <td>${escapeHtml(target.address)}</td>
        <td>비활성화 됨</td>
        <td></td>
      `;
    } else {
      tr.innerHTML = `
        <td>${escapeHtml(target.name)}</td>
        <td>${escapeHtml(target.address)}</td>
        <td></td>
        <td></td>
      `;
    }
    targetTableBody.appendChild(tr);
  });
}

function updateTargetCount() {
  const targets = settings.targets || [];
  const activeCount = targets.filter(t => t.name && t.address && t.enabled).length;
  const totalCount = targets.filter(t => t.name && t.address).length;
  const el = document.getElementById('targetCount');
  if (el) el.textContent = `${activeCount}/${totalCount}개 활성`;
}

function updateTargetRow(data) {
  const tr = document.getElementById(`target-${data.index}`);
  if (!tr) return;
  // Don't overwrite disabled targets' styling
  if (tr.classList.contains('status-disabled')) return;
  tr.className = data.status === '장애' ? 'status-failed' : '';
  if (tr.children[2]) tr.children[2].textContent = data.status;
  if (tr.children[3]) tr.children[3].textContent = data.timestamp;
}

// --- Failure Log ---
function addLogEntry(data) {
  const tr = document.createElement('tr');
  tr.className = data.status === '정상 복구' ? 'log-recovery' : 'log-error';
  tr.innerHTML = `
    <td>${escapeHtml(data.timestamp)}</td>
    <td>${escapeHtml(data.name)}</td>
    <td>${escapeHtml(data.address)}</td>
    <td>${escapeHtml(data.status)}</td>
  `;
  logTableBody.appendChild(tr);
  failLogs.push(data);

  // Keep max 100
  if (failLogs.length > 100) {
    failLogs.shift();
    if (logTableBody.firstElementChild) {
      logTableBody.removeChild(logTableBody.firstElementChild);
    }
  }

  // Auto-scroll to bottom
  const container = logTableBody.closest('.table-container');
  if (container) container.scrollTop = container.scrollHeight;
}

// --- Status Bar ---
function updateStatusBar() {
  const indicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const statusInterval = document.getElementById('statusInterval');
  const statusTime = document.getElementById('statusTime');

  if (indicator) {
    indicator.className = 'status-indicator ' + (isRunning ? 'running' : '');
  }
  if (statusText) {
    statusText.textContent = isRunning ? '감시 중' : '대기 중';
  }
  if (statusInterval) {
    statusInterval.textContent = `주기: ${settings.ping_interval || 1}초`;
  }
}

// Update clock every second
function updateClock() {
  const el = document.getElementById('statusTime');
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('ko-KR', { hour12: false });
  }
}
updateClock();
setInterval(updateClock, 1000);

// --- Controls ---
btnStart.addEventListener('click', async () => {
  if (isRunning) return;
  isRunning = true;
  btnStart.disabled = true;
  btnStop.disabled = false;
  // Re-sync settings from main process before starting
  try {
    settings = await window.api.getSettings();
  } catch (e) {
    console.error('Failed to reload settings:', e);
  }
  if (!isRunning) return;  // User clicked stop during await
  buildIpMap();
  renderTargetTable();
  updateTargetCount();
  updateStatusBar();
  if (currentView === '2d' && window.view2d) {
    window.view2d.init();
    if (settings.topology && window.view2d.setTopology) {
      window.view2d.setTopology(settings.topology);
    }
    window.view2d.setTargets(settings.targets || [], ipToIndex);
  }
  try {
    await window.api.startPinging();
    if (!isRunning) return;  // User clicked stop during await
    // Update local IP after capture starts (localIp is set during startCapture)
    const lip = await window.api.getLocalIp();
    if (lip && window.view2d) window.view2d.setLocalIp(lip);
  } catch (e) {
    console.error('Failed to start pinging:', e);
    isRunning = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    updateStatusBar();
  }
});

btnStop.addEventListener('click', async () => {
  if (!isRunning) return;
  isRunning = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
  updateStatusBar();
  // 2D view doesn't need explicit stop
  try {
    await window.api.stopPinging();
  } catch (e) {
    console.error('Failed to stop pinging:', e);
  }
});

btnClearLogs.addEventListener('click', () => {
  failLogs = [];
  logTableBody.innerHTML = '';
});

chkMute.addEventListener('change', async () => {
  const newState = chkMute.checked;
  settings.mute_state = newState;
  try {
    const result = await window.api.updateMute(newState);
    if (!result) {
      settings.mute_state = !newState;
      chkMute.checked = !newState;
    }
  } catch (e) {
    console.error('Failed to update mute state:', e);
    settings.mute_state = !newState;
    chkMute.checked = !newState;
  }
});

// --- IPC Events ---
// Remove old listeners to prevent accumulation on renderer reload
['ping-result', 'failure-log', 'play-sound', 'traffic-stats',
 'internode-stats', 'discovered-nodes', 'asterix-flows', 'capture-error',
 'window-maximized', 'window-unmaximized'].forEach(ch => window.api.removeAllListeners(ch));

window.api.onPingResult((data) => {
  updateTargetRow(data);
  if (currentView === '2d' && window.view2d && window.view2d.isActive()) {
    window.view2d.updateNodeStatus(data.index, data.status, data.timestamp);
  }
});

window.api.onFailureLog((data) => {
  addLogEntry(data);
});

window.api.onTrafficStats(() => {});

window.api.onInterNodeStats(() => {});

window.api.onDiscoveredNodes((nodes) => {
  if (currentView === '2d' && window.view2d && window.view2d.isActive()) window.view2d.handleDiscoveredNodes(nodes);
});

window.api.onAsterixFlows(() => {});

window.api.onCaptureError((msg) => {
  console.error('패킷 캡처 오류:', msg);
});

window.api.onPlaySound((soundPath) => {
  if (!soundPath) return;
  try {
    // Stop any currently playing audio first to prevent overlapping alarms
    if (!alertAudio.paused) {
      alertAudio.pause();
      alertAudio.currentTime = 0;
    }
    // Convert file path to properly encoded file:// URL
    const fileUrl = 'file:///' + pathToFileUrl(soundPath);
    alertAudio.src = fileUrl;
    alertAudio.play().catch(e => console.error('Sound play error:', e));
  } catch (e) {
    console.error('Sound error:', e);
  }
});

// --- Modals ---
function showModal(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  // Close any other open modals first
  document.querySelectorAll('.modal-overlay.show').forEach(m => {
    if (m.id !== id) m.classList.remove('show');
  });
  // If already open, don't re-initialize
  if (el.classList.contains('show')) return false;
  el.classList.add('show');
  return true;
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = document.querySelector('.modal-overlay.show');
    if (!open) return;
    // Topology modal needs special cleanup
    if (open.id === 'topoModal' && typeof closeTopoEditor === 'function') {
      closeTopoEditor();
    } else {
      hideModal(open.id);
    }
  }
});

// --- Target Settings ---
document.getElementById('menuTargets').addEventListener('click', () => {
  if (!showModal('targetModal')) return;
  const body = document.getElementById('targetSettingsBody');
  body.innerHTML = '';
  const typeOptions = [
    { value: 'pc', label: 'PC' },
    { value: 'router', label: '라우터' },
    { value: 'switch', label: '스위치' },
    { value: 'server', label: '서버' }
  ];
  for (let i = 0; i < 20; i++) {
    const target = (settings.targets && settings.targets[i]) || { name: '', address: '', enabled: true, type: 'pc' };
    const tr = document.createElement('tr');
    const typeSelHtml = typeOptions.map(o =>
      `<option value="${o.value}"${(target.type || 'pc') === o.value ? ' selected' : ''}>${o.label}</option>`
    ).join('');
    tr.innerHTML = `
      <td><input type="checkbox" class="ts-enabled" ${target.enabled !== false ? 'checked' : ''}></td>
      <td><input type="text" class="ts-name" value="${escapeAttr(target.name || '')}"></td>
      <td><input type="text" class="ts-address" value="${escapeAttr(target.address || '')}"></td>
      <td><select class="ts-type">${typeSelHtml}</select></td>
    `;
    body.appendChild(tr);
  }
});

document.getElementById('btnSaveTargets').addEventListener('click', async () => {
  const rows = document.querySelectorAll('#targetSettingsBody tr');
  const targets = [];
  rows.forEach(row => {
    const name = row.querySelector('.ts-name').value.trim();
    const address = row.querySelector('.ts-address').value.trim();
    const enabled = row.querySelector('.ts-enabled').checked;
    const type = row.querySelector('.ts-type').value || 'pc';
    if (name && address) {
      targets.push({ name, address, enabled, type });
    }
  });
  // Validate addresses
  const invalidTarget = targets.find(t => !/^[a-zA-Z0-9]+([.\-][a-zA-Z0-9]+)*$/.test(t.address));
  if (invalidTarget) {
    alert(`유효하지 않은 주소: ${invalidTarget.address}\nIP 주소 또는 호스트명을 입력하세요.`);
    return;
  }
  // Check for duplicate addresses
  const addresses = targets.map(t => t.address);
  const dupes = addresses.filter((a, i) => addresses.indexOf(a) !== i);
  if (dupes.length > 0) {
    alert(`중복된 주소가 있습니다: ${[...new Set(dupes)].join(', ')}\n중복 주소의 ping 결과가 정확하지 않을 수 있습니다.`);
  }
  try {
    const saved = await window.api.saveSettings({ targets });
    if (saved) settings = saved;
  } catch (e) {
    console.error('Failed to save targets:', e);
    alert('설정 저장 실패');
    return;
  }
  if (!isRunning) {
    buildIpMap();
    renderTargetTable();
    updateTargetCount();
    if (currentView === '2d' && window.view2d && window.view2d.isActive()) {
      window.view2d.setTargets(settings.targets || [], ipToIndex);
    }
  }
  hideModal('targetModal');
  if (isRunning) alert('감시대상 변경은 정지 후 재시작 시 반영됩니다.');
});

document.getElementById('btnCancelTargets').addEventListener('click', () => hideModal('targetModal'));

// --- Interval Settings ---
document.getElementById('menuInterval').addEventListener('click', () => {
  if (!showModal('intervalModal')) return;
  document.getElementById('inputInterval').value = settings.ping_interval || 1;
});

document.getElementById('btnSaveInterval').addEventListener('click', async () => {
  const raw = document.getElementById('inputInterval').value.trim();
  const val = parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || isNaN(val) || val < 1 || val > 3600) {
    alert('주기는 1초 이상 3600초(1시간) 이하의 정수여야 합니다.');
    return;
  }
  try {
    const saved = await window.api.saveSettings({ ping_interval: val });
    if (saved) settings = saved;
  } catch (e) {
    console.error('Failed to save interval:', e);
    alert('설정 저장 실패');
    return;
  }
  updateStatusBar();
  hideModal('intervalModal');
  if (isRunning) alert('주기 변경은 정지 후 재시작 시 반영됩니다.');
});

document.getElementById('btnCancelInterval').addEventListener('click', () => hideModal('intervalModal'));

// --- UDP Settings ---
document.getElementById('menuUdp').addEventListener('click', () => {
  if (!showModal('udpModal')) return;
  document.getElementById('chkUdpEnabled').checked = settings.udp_enabled || false;
  document.getElementById('inputUdpIp').value = settings.udp_ip || '';
  document.getElementById('inputUdpPort').value = settings.udp_port || '';
  document.getElementById('inputUdpMessage').value = settings.udp_message || '';
  document.getElementById('inputUdpNoFailure').value = settings.udp_no_failure_message || '';
});

document.getElementById('btnSaveUdp').addEventListener('click', async () => {
  const ip = document.getElementById('inputUdpIp').value.trim();
  const port = document.getElementById('inputUdpPort').value.trim();
  const udpEnabled = document.getElementById('chkUdpEnabled').checked;

  // When UDP enabled, require both IP and port
  if (udpEnabled) {
    if (!ip) {
      alert('UDP 활성화 시 IP 주소를 입력하세요.');
      return;
    }
    if (!port) {
      alert('UDP 활성화 시 포트를 입력하세요.');
      return;
    }
  }

  // Validate IP
  if (ip && !isValidIp(ip)) {
    alert('유효한 IP 주소를 입력하세요.');
    return;
  }

  // Validate port
  if (port && !/^\d+$/.test(port)) {
    alert('포트 번호는 숫자만 입력 가능합니다.');
    return;
  }
  const portNum = parseInt(port, 10);
  if (port && (isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    alert('포트 번호는 1에서 65535 사이여야 합니다.');
    return;
  }

  const udpSettings = {
    udp_enabled: udpEnabled,
    udp_ip: ip,
    udp_port: port ? String(parseInt(port, 10)) : '',
    udp_message: document.getElementById('inputUdpMessage').value,
    udp_no_failure_message: document.getElementById('inputUdpNoFailure').value
  };
  try {
    const saved = await window.api.saveSettings(udpSettings);
    if (saved) settings = saved;
  } catch (e) {
    console.error('Failed to save UDP settings:', e);
    alert('설정 저장 실패');
    return;
  }
  hideModal('udpModal');
});

document.getElementById('btnCancelUdp').addEventListener('click', () => hideModal('udpModal'));

// --- Sound Settings ---
document.getElementById('menuSound').addEventListener('click', () => {
  if (!showModal('soundModal')) return;
  document.getElementById('chkSoundEnabled').checked = settings.sound_enabled !== false;
  document.getElementById('inputSoundFile').value = settings.sound_file || '';
});

document.getElementById('btnBrowseSound').addEventListener('click', async () => {
  try {
    const filePath = await window.api.browseSoundFile();
    if (filePath) {
      document.getElementById('inputSoundFile').value = filePath;
    }
  } catch (e) {
    console.error('Failed to browse sound file:', e);
  }
});

document.getElementById('btnTestSound').addEventListener('click', async () => {
  const soundEnabled = document.getElementById('chkSoundEnabled').checked;
  if (!soundEnabled) {
    alert('경보음이 비활성화되어 있습니다.');
    return;
  }
  const soundFile = document.getElementById('inputSoundFile').value;
  if (soundFile) {
    // Play selected file directly without saving
    try {
      if (!alertAudio.paused) {
        alertAudio.pause();
        alertAudio.currentTime = 0;
      }
      const fileUrl = 'file:///' + pathToFileUrl(soundFile);
      alertAudio.src = fileUrl;
      alertAudio.play().catch(e => alert('사운드 재생 실패: ' + e.message));
    } catch (e) {
      alert('사운드 재생 실패: ' + e.message);
    }
  } else {
    // No custom file selected -- use default WAV via main process
    try {
      const result = await window.api.testSound();
      if (!result) alert('재생할 경보음 파일이 없습니다.');
    } catch (e) {
      alert('사운드 재생 실패: ' + e.message);
    }
  }
});

document.getElementById('btnSaveSound').addEventListener('click', async () => {
  const soundSettings = {
    sound_enabled: document.getElementById('chkSoundEnabled').checked,
    sound_file: document.getElementById('inputSoundFile').value
  };
  try {
    const saved = await window.api.saveSettings(soundSettings);
    if (saved) settings = saved;
  } catch (e) {
    console.error('Failed to save sound settings:', e);
    alert('설정 저장 실패');
    return;
  }
  hideModal('soundModal');
});

document.getElementById('btnCancelSound').addEventListener('click', () => hideModal('soundModal'));

// --- Capture Settings ---
document.getElementById('menuCapture').addEventListener('click', async () => {
  if (!showModal('captureModal')) return;
  const listEl = document.getElementById('captureDeviceList');
  listEl.innerHTML = '';

  // Populate network interfaces
  let interfaces = [];
  try {
    interfaces = await window.api.getNetworkInterfaces();
  } catch (e) {
    console.error('Failed to get network interfaces:', e);
  }

  // Build enabled device map from settings
  const enabledMap = {};
  const captureDevices = settings.capture_devices || [];
  for (const cd of captureDevices) {
    if (cd && cd.name) enabledMap[cd.name] = cd.enabled !== false;
  }
  // Legacy single device support
  if (captureDevices.length === 0 && settings.capture_device) {
    enabledMap[settings.capture_device] = true;
  }

  for (const iface of interfaces) {
    const item = document.createElement('label');
    item.className = 'capture-device-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.deviceName = iface.name;
    cb.checked = enabledMap[iface.name] || false;
    const info = document.createElement('div');
    info.className = 'cap-dev-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'cap-dev-name';
    nameEl.textContent = iface.description || iface.name;
    const addrsEl = document.createElement('div');
    addrsEl.className = 'cap-dev-addrs';
    addrsEl.textContent = iface.addresses.join(', ');
    info.appendChild(nameEl);
    info.appendChild(addrsEl);
    item.appendChild(cb);
    item.appendChild(info);
    listEl.appendChild(item);
  }
});

document.getElementById('btnSaveCapture').addEventListener('click', async () => {
  const checkboxes = document.querySelectorAll('#captureDeviceList input[type="checkbox"]');
  const captureDevices = [];
  checkboxes.forEach(cb => {
    captureDevices.push({ name: cb.dataset.deviceName, enabled: cb.checked });
  });
  try {
    const saved = await window.api.saveCaptureSettings({ capture_devices: captureDevices });
    if (saved) settings = saved;
  } catch (e) {
    console.error('Failed to save capture settings:', e);
    alert('설정 저장 실패');
    return;
  }
  hideModal('captureModal');
});

document.getElementById('btnCancelCapture').addEventListener('click', () => hideModal('captureModal'));

// --- Topology Editor ---
let topoEditorInited = false;
let topoResizeObs = null;

document.getElementById('menuTopo').addEventListener('click', () => {
  if (!showModal('topoModal')) return;

  // Populate target dropdown
  const sel = document.getElementById('topoPropTarget');
  sel.innerHTML = '<option value="">— 연결 안함 —</option>';
  (settings.targets || []).forEach((t, i) => {
    if (t.name && t.address) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${t.name} (${t.address})`;
      sel.appendChild(opt);
    }
  });

  // Init canvas editor (re-init each time since destroy() tears it down)
  const canvasEl = document.getElementById('topoCanvas');
  try {
    if (!topoEditorInited) {
      window.topoEditor.init(canvasEl, onTopoSelect);
      topoEditorInited = true;
    }
    window.topoEditor.load(settings.topology, settings.targets || []);
    window.topoEditor.setMode('select'); // Reset mode + toolbar
  } catch (e) {
    console.error('Failed to initialize topology editor:', e);
    hideModal('topoModal');
    return;
  }

  // Defer resize so the modal is rendered
  requestAnimationFrame(() => {
    if (!document.getElementById('topoModal').classList.contains('show')) return;
    window.topoEditor.resize();
    window.topoEditor.render();
  });

  // ResizeObserver for window resize while modal is open
  if (topoResizeObs) topoResizeObs.disconnect();
  const wrapEl = document.querySelector('.topo-canvas-wrap');
  if (wrapEl) {
    topoResizeObs = new ResizeObserver(() => {
      if (document.getElementById('topoModal').classList.contains('show') && topoEditorInited) {
        window.topoEditor.resize();
      }
    });
    topoResizeObs.observe(wrapEl);
  }

  // Clear property panel
  onTopoSelect(null);
});

// Toolbar mode buttons
document.querySelectorAll('.topo-tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode;
    if (m && topoEditorInited) {
      window.topoEditor.setMode(m);
    }
  });
});

function onTopoSelect(dev) {
  const nameInput = document.getElementById('topoPropName');
  const ipInput = document.getElementById('topoPropIp');
  const typeSel = document.getElementById('topoPropType');
  const targetSel = document.getElementById('topoPropTarget');
  const propsEl = document.getElementById('topoProps');

  if (!dev) {
    nameInput.value = '';
    ipInput.value = '';
    typeSel.value = 'pc';
    targetSel.value = '';
    nameInput.disabled = true;
    ipInput.disabled = true;
    typeSel.disabled = true;
    targetSel.disabled = true;
    propsEl.style.opacity = '0.4';
    propsEl.dataset.devId = '';
    return;
  }

  const isHub = dev.type === 'hub_center';
  nameInput.disabled = false;
  ipInput.disabled = false;
  typeSel.disabled = isHub;
  targetSel.disabled = false;
  propsEl.style.opacity = '1';

  nameInput.value = dev.name || '';
  ipInput.value = dev.ip || '';
  typeSel.value = isHub ? 'pc' : (dev.type || 'pc');
  targetSel.value = dev.target_index !== undefined && dev.target_index !== null ? dev.target_index : '';

  // Store selected device id for updates
  propsEl.dataset.devId = dev.id;
}

// Property panel live updates
document.getElementById('topoPropName').addEventListener('input', (e) => {
  const id = document.getElementById('topoProps').dataset.devId;
  if (id && topoEditorInited) window.topoEditor.updateDevice(id, { name: e.target.value });
});

document.getElementById('topoPropIp').addEventListener('input', (e) => {
  const id = document.getElementById('topoProps').dataset.devId;
  if (id && topoEditorInited) window.topoEditor.updateDevice(id, { ip: e.target.value });
});

document.getElementById('topoPropType').addEventListener('change', (e) => {
  const id = document.getElementById('topoProps').dataset.devId;
  if (id && topoEditorInited) window.topoEditor.updateDevice(id, { type: e.target.value });
});

document.getElementById('topoPropTarget').addEventListener('change', (e) => {
  const id = document.getElementById('topoProps').dataset.devId;
  if (!id || !topoEditorInited) return;
  const val = e.target.value;
  const idx = val !== '' ? parseInt(val, 10) : undefined;
  const targets = settings.targets || [];
  if (idx !== undefined && (isNaN(idx) || idx < 0 || idx >= targets.length)) return;
  const t = idx !== undefined ? targets[idx] : null;
  const updateProps = {
    target_index: idx,
    ip: t ? t.address : document.getElementById('topoPropIp').value,
    name: t ? t.name : document.getElementById('topoPropName').value
  };
  if (t && t.type) updateProps.type = t.type;
  window.topoEditor.updateDevice(id, updateProps);
  if (t) {
    document.getElementById('topoPropIp').value = t.address;
    document.getElementById('topoPropName').value = t.name;
    if (t.type) document.getElementById('topoPropType').value = t.type;
  }
});

function closeTopoEditor() {
  if (topoResizeObs) { topoResizeObs.disconnect(); topoResizeObs = null; }
  if (topoEditorInited) {
    try { window.topoEditor.destroy(); } catch (e) { console.error('Topo editor destroy error:', e); }
    topoEditorInited = false;
  }
  hideModal('topoModal');
}

document.getElementById('btnSaveTopo').addEventListener('click', async () => {
  if (!topoEditorInited) { closeTopoEditor(); return; }
  const topo = window.topoEditor.save();
  try {
    const saved = await window.api.saveSettings({ topology: topo });
    if (saved) settings = saved;
  } catch (e) {
    console.error('Failed to save topology:', e);
    alert('설정 저장 실패');
    return;
  }
  closeTopoEditor();
  // Apply to 2D view (setTopology auto-rebuilds if targets exist)
  if (currentView === '2d' && window.view2d && window.view2d.isActive()) {
    window.view2d.setTopology(topo);
    window.view2d.setTargets(settings.targets || [], ipToIndex);
  }
});

document.getElementById('btnCancelTopo').addEventListener('click', () => closeTopoEditor());

// --- 2D Topology View ---
function switchView(view) {
  currentView = view;
  const tableContainer = document.querySelector('.panel-left .table-container');
  const view2dEl = document.getElementById('view2d');

  if (view === '2d') {
    tableContainer.style.display = 'none';
    view2dEl.classList.add('active');
    if (window.view2d) {
      window.view2d.init();
      if (settings.topology && window.view2d.setTopology) {
        window.view2d.setTopology(settings.topology);
      }
      window.view2d.setTargets(settings.targets || [], ipToIndex);
    }
  } else {
    tableContainer.style.display = '';
    view2dEl.classList.remove('active');
    if (window.view2d && window.view2d.isActive()) window.view2d.dispose();
  }

  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

document.querySelectorAll('.view-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});


// --- Utility ---
function pathToFileUrl(filePath) {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  // Handle UNC paths (\\server\share -> //server/share)
  if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/');
    return '//' + parts.map(s => encodeURIComponent(s)).join('/');
  }
  const parts = normalized.split('/');
  return parts.map((s, i) => {
    if (i === 0 && /^[A-Za-z]:$/.test(s)) return s;
    return encodeURIComponent(s);
  }).join('/');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidIp(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const num = parseInt(p, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && String(num) === p;
  });
}

// --- Window Controls ---
document.getElementById('btnMinimize').addEventListener('click', () => {
  window.api.windowMinimize().catch(() => {});
});

document.getElementById('btnMaximize').addEventListener('click', () => {
  window.api.windowMaximize().catch(() => {});
});

document.getElementById('btnClose').addEventListener('click', () => {
  window.api.windowClose().catch(() => {});
});

function setMaximizeIcon(isMaximized) {
  const btnMaximize = document.getElementById('btnMaximize');
  if (!btnMaximize) return;
  if (isMaximized) {
    btnMaximize.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" stroke-width="1" width="7" height="7" x="1.5" y="3.5"/><polyline fill="none" stroke="currentColor" stroke-width="1" points="3.5,3.5 3.5,1.5 10.5,1.5 10.5,8.5 8.5,8.5"/></svg>';
    btnMaximize.title = '이전 크기로 복원';
  } else {
    btnMaximize.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" stroke-width="1" width="9" height="9" x="1.5" y="1.5"/></svg>';
    btnMaximize.title = '최대화';
  }
}

window.api.onWindowMaximized(() => setMaximizeIcon(true));
window.api.onWindowUnmaximized(() => setMaximizeIcon(false));
window.api.windowIsMaximized().then(isMax => setMaximizeIcon(isMax)).catch(() => {});

// Double-click titlebar to maximize/restore
document.getElementById('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('.titlebar-btn')) return;
  window.api.windowMaximize().catch(() => {});
});

// --- Init ---
init().catch(e => console.error('Initialization error:', e));
