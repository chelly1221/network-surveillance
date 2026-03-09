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
  settings = await window.api.getSettings();
  chkMute.checked = settings.mute_state || false;
  npcapAvailable = await window.api.isNpcapAvailable();
  buildIpMap();
  renderTargetTable();
  updateTargetCount();
  updateStatusBar();
  updateNpcapIndicator();
  // Fetch local IP for 3D hub mapping
  const lip = await window.api.getLocalIp();
  if (lip && window.view3d) window.view3d.setLocalIp(lip);
}

function buildIpMap() {
  ipToIndex = {};
  const targets = settings.targets || [];
  targets.forEach((t, i) => {
    if (t.address) ipToIndex[t.address] = i;
  });
  if (window.view3d) window.view3d.setIpMap(ipToIndex);
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
  tr.className = data.status === '장애' ? 'status-failed' : '';
  tr.children[2].textContent = data.status;
  tr.children[3].textContent = data.timestamp;
}

// --- Failure Log ---
function addLogEntry(data) {
  const tr = document.createElement('tr');
  tr.className = 'log-error';
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
    if (logTableBody.firstChild) {
      logTableBody.removeChild(logTableBody.firstChild);
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
setInterval(() => {
  const el = document.getElementById('statusTime');
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('ko-KR', { hour12: false });
  }
}, 1000);

// --- Controls ---
btnStart.addEventListener('click', async () => {
  if (isRunning) return;
  isRunning = true;
  btnStart.disabled = true;
  btnStop.disabled = false;
  renderTargetTable();
  updateTargetCount();
  updateStatusBar();
  if (currentView === '3d') {
    window.view3d.init();
    if (settings.topology && window.view3d.setTopology) {
      window.view3d.setTopology(settings.topology);
    }
    window.view3d.setTargets(settings.targets || [], ipToIndex);
    window.view3d.startAmbientFlow();
  }
  await window.api.startPinging();
  // Update local IP after capture starts (localIp is set during startCapture)
  const lip = await window.api.getLocalIp();
  if (lip && window.view3d) window.view3d.setLocalIp(lip);
});

btnStop.addEventListener('click', async () => {
  if (!isRunning) return;
  isRunning = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
  updateStatusBar();
  if (window.view3d && window.view3d.isActive()) window.view3d.stopAmbientFlow();
  await window.api.stopPinging();
});

btnClearLogs.addEventListener('click', () => {
  failLogs = [];
  logTableBody.innerHTML = '';
});

chkMute.addEventListener('change', () => {
  settings.mute_state = chkMute.checked;
  window.api.updateMute(chkMute.checked);
});

// --- IPC Events ---
window.api.onPingResult((data) => {
  updateTargetRow(data);
  if (currentView === '3d' && window.view3d && window.view3d.isActive()) {
    window.view3d.updateNodeStatus(data.index, data.status, data.timestamp);
    window.view3d.emitPingParticles(data);
  }
});

window.api.onFailureLog((data) => {
  addLogEntry(data);
});

window.api.onTrafficStats((stats) => {
  if (currentView === '3d' && window.view3d && window.view3d.isActive()) window.view3d.handleTrafficStats(stats);
});

window.api.onInterNodeStats((flows) => {
  if (currentView === '3d' && window.view3d && window.view3d.isActive()) window.view3d.handleInterNodeStats(flows);
});

window.api.onDiscoveredNodes((nodes) => {
  if (currentView === '3d' && window.view3d && window.view3d.isActive()) window.view3d.handleDiscoveredNodes(nodes);
});

window.api.onAsterixFlows((flows) => {
  if (currentView === '3d' && window.view3d && window.view3d.isActive()) window.view3d.handleAsterixFlows(flows);
});

window.api.onCaptureError((msg) => {
  console.error('패킷 캡처 오류:', msg);
});

window.api.onPlaySound((soundPath) => {
  try {
    // Convert file path to file:// URL
    const fileUrl = 'file:///' + soundPath.replace(/\\/g, '/');
    alertAudio.src = fileUrl;
    alertAudio.play().catch(e => console.error('Sound play error:', e));
  } catch (e) {
    console.error('Sound error:', e);
  }
});

// --- Modals ---
function showModal(id) {
  document.getElementById(id).classList.add('show');
  return true;
}

function hideModal(id) {
  document.getElementById(id).classList.remove('show');
}

// --- Target Settings ---
document.getElementById('menuTargets').addEventListener('click', () => {
  if (!showModal('targetModal')) return;
  const body = document.getElementById('targetSettingsBody');
  body.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const target = (settings.targets && settings.targets[i]) || { name: '', address: '', enabled: true };
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="ts-enabled" ${target.enabled !== false ? 'checked' : ''}></td>
      <td><input type="text" class="ts-name" value="${escapeAttr(target.name || '')}"></td>
      <td><input type="text" class="ts-address" value="${escapeAttr(target.address || '')}"></td>
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
    if (name && address) {
      targets.push({ name, address, enabled });
    }
  });
  settings.targets = targets;
  await window.api.saveSettings({ targets });
  buildIpMap();
  renderTargetTable();
  updateTargetCount();
  if (currentView === '3d' && window.view3d.isActive()) {
    window.view3d.setTargets(settings.targets || [], ipToIndex);
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
  const val = parseInt(document.getElementById('inputInterval').value, 10);
  if (isNaN(val) || val < 1) {
    alert('주기는 1초 이상이어야 합니다.');
    return;
  }
  settings.ping_interval = val;
  await window.api.saveSettings({ ping_interval: val });
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

  // Validate IP
  if (ip && !isValidIp(ip)) {
    alert('유효한 IP 주소를 입력하세요.');
    return;
  }

  // Validate port
  const portNum = parseInt(port, 10);
  if (port && (isNaN(portNum) || portNum < 0 || portNum > 65535)) {
    alert('포트 번호는 0에서 65535 사이여야 합니다.');
    return;
  }

  const udpSettings = {
    udp_enabled: document.getElementById('chkUdpEnabled').checked,
    udp_ip: ip,
    udp_port: port,
    udp_message: document.getElementById('inputUdpMessage').value,
    udp_no_failure_message: document.getElementById('inputUdpNoFailure').value
  };
  Object.assign(settings, udpSettings);
  await window.api.saveSettings(udpSettings);
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
  const filePath = await window.api.browseSoundFile();
  if (filePath) {
    document.getElementById('inputSoundFile').value = filePath;
  }
});

document.getElementById('btnTestSound').addEventListener('click', async () => {
  const soundEnabled = document.getElementById('chkSoundEnabled').checked;
  if (!soundEnabled) {
    alert('경보음이 비활성화되어 있습니다.');
    return;
  }
  const soundFile = document.getElementById('inputSoundFile').value;
  if (!soundFile) {
    alert('경보음 파일을 선택하세요.');
    return;
  }
  // Play directly without saving
  try {
    const fileUrl = 'file:///' + soundFile.replace(/\\/g, '/');
    alertAudio.src = fileUrl;
    alertAudio.play().catch(e => alert('사운드 재생 실패: ' + e.message));
  } catch (e) {
    alert('사운드 재생 실패: ' + e.message);
  }
});

document.getElementById('btnSaveSound').addEventListener('click', async () => {
  const soundSettings = {
    sound_enabled: document.getElementById('chkSoundEnabled').checked,
    sound_file: document.getElementById('inputSoundFile').value
  };
  Object.assign(settings, soundSettings);
  await window.api.saveSettings(soundSettings);
  hideModal('soundModal');
});

document.getElementById('btnCancelSound').addEventListener('click', () => hideModal('soundModal'));

// --- Capture Settings ---
document.getElementById('menuCapture').addEventListener('click', async () => {
  if (!showModal('captureModal')) return;
  const select = document.getElementById('selectCaptureDevice');
  const infoEl = document.querySelector('#captureDeviceInfo small');

  // Reset options
  select.innerHTML = '<option value="">자동 감지</option>';

  // Populate network interfaces
  const interfaces = await window.api.getNetworkInterfaces();
  for (const iface of interfaces) {
    const opt = document.createElement('option');
    opt.value = iface.name;
    const desc = iface.description || iface.name;
    const ips = iface.addresses.join(', ');
    opt.textContent = `${desc} (${ips})`;
    select.appendChild(opt);
  }

  // Set current values
  select.value = settings.capture_device || '';

  // Show device info on change (use onchange to avoid listener accumulation)
  select.onchange = () => {
    const dev = interfaces.find(i => i.name === select.value);
    if (dev) {
      infoEl.textContent = `장치: ${dev.name}`;
    } else {
      infoEl.textContent = '서브넷이 일치하는 어댑터를 자동으로 선택합니다.';
    }
  };
  select.dispatchEvent(new Event('change'));
});

document.getElementById('btnSaveCapture').addEventListener('click', async () => {
  const captureDevice = document.getElementById('selectCaptureDevice').value;
  settings.capture_device = captureDevice;
  await window.api.saveCaptureSettings({ capture_device: captureDevice, capture_mode: 'all' });
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
  if (!topoEditorInited) {
    window.topoEditor.init(canvasEl, onTopoSelect);
    topoEditorInited = true;
  }

  window.topoEditor.load(settings.topology, settings.targets || []);
  window.topoEditor.setMode('select'); // Reset mode + toolbar

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
  const targetSel = document.getElementById('topoPropTarget');
  const propsEl = document.getElementById('topoProps');

  if (!dev) {
    nameInput.value = '';
    ipInput.value = '';
    targetSel.value = '';
    nameInput.disabled = true;
    ipInput.disabled = true;
    targetSel.disabled = true;
    propsEl.style.opacity = '0.4';
    propsEl.dataset.devId = '';
    return;
  }

  nameInput.disabled = false;
  ipInput.disabled = false;
  targetSel.disabled = false;
  propsEl.style.opacity = '1';

  nameInput.value = dev.name || '';
  ipInput.value = dev.ip || '';
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

document.getElementById('topoPropTarget').addEventListener('change', (e) => {
  const id = document.getElementById('topoProps').dataset.devId;
  if (!id || !topoEditorInited) return;
  const val = e.target.value;
  const idx = val !== '' ? parseInt(val, 10) : undefined;
  const t = idx !== undefined ? (settings.targets || [])[idx] : null;
  window.topoEditor.updateDevice(id, {
    target_index: idx,
    ip: t ? t.address : document.getElementById('topoPropIp').value,
    name: t ? t.name : document.getElementById('topoPropName').value
  });
  if (t) {
    document.getElementById('topoPropIp').value = t.address;
    document.getElementById('topoPropName').value = t.name;
  }
});

function closeTopoEditor() {
  if (topoResizeObs) { topoResizeObs.disconnect(); topoResizeObs = null; }
  if (topoEditorInited) {
    window.topoEditor.destroy();
    topoEditorInited = false;
  }
  hideModal('topoModal');
}

document.getElementById('btnSaveTopo').addEventListener('click', async () => {
  const topo = window.topoEditor.save();
  settings.topology = topo;
  await window.api.saveSettings({ topology: topo });
  closeTopoEditor();
  // Apply to 3D view
  if (currentView === '3d' && window.view3d && window.view3d.isActive() && window.view3d.setTopology) {
    window.view3d.setTopology(topo);
    window.view3d.setTargets(settings.targets || [], ipToIndex);
  }
});

document.getElementById('btnCancelTopo').addEventListener('click', () => closeTopoEditor());

// --- 3D Network View ---
function switchView(view) {
  currentView = view;
  const tableContainer = document.querySelector('.panel-left .table-container');
  const view3d = document.getElementById('view3d');

  if (view === '3d') {
    tableContainer.style.display = 'none';
    view3d.classList.add('active');
    window.view3d.init();
    if (settings.topology && window.view3d.setTopology) {
      window.view3d.setTopology(settings.topology);
    }
    window.view3d.setTargets(settings.targets || [], ipToIndex);
    if (isRunning) window.view3d.startAmbientFlow();
  } else {
    tableContainer.style.display = '';
    view3d.classList.remove('active');
    if (window.view3d && window.view3d.isActive()) window.view3d.dispose();
  }

  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

document.querySelectorAll('.view-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// (Old SVG-based 3D code removed — now using Three.js view3d.js)

// --- Utility ---
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  window.api.windowMinimize();
});

document.getElementById('btnMaximize').addEventListener('click', () => {
  window.api.windowMaximize();
});

document.getElementById('btnClose').addEventListener('click', () => {
  window.api.windowClose();
});

function setMaximizeIcon(isMaximized) {
  const btnMaximize = document.getElementById('btnMaximize');
  if (!btnMaximize) return;
  if (isMaximized) {
    btnMaximize.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" stroke-width="1" width="7" height="7" x="1.5" y="3.5"/><polyline fill="none" stroke="currentColor" stroke-width="1" points="3.5,3.5 3.5,1.5 10.5,1.5 10.5,8.5 8.5,8.5"/></svg>';
    btnMaximize.title = '이전 크기로 복원';
  } else {
    btnMaximize.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><rect fill="none" stroke="currentColor" stroke-width="1" width="9" height="9" x="1.5" y="1.5"/></svg>';
    btnMaximize.title = '최대화';
  }
}

window.api.onWindowMaximized(() => setMaximizeIcon(true));
window.api.onWindowUnmaximized(() => setMaximizeIcon(false));
window.api.windowIsMaximized().then(isMax => setMaximizeIcon(isMax));

// Double-click titlebar to maximize/restore
document.getElementById('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('.titlebar-btn')) return;
  window.api.windowMaximize();
});

// --- Init ---
init();
