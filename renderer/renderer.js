// State
let settings = {};
let isRunning = false;
let failLogs = [];
let currentView = 'table';

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
  renderTargetTable();
  updateTargetCount();
  updateStatusBar();
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
  if (currentView === '3d') render3dView();
  const hubSweep = document.getElementById('hubSweep');
  if (hubSweep) hubSweep.classList.add('active');
  await window.api.startPinging();
});

btnStop.addEventListener('click', async () => {
  if (!isRunning) return;
  isRunning = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
  updateStatusBar();
  const hubSweep = document.getElementById('hubSweep');
  if (hubSweep) hubSweep.classList.remove('active');
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
  update3dNode(data);
});

window.api.onFailureLog((data) => {
  addLogEntry(data);
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
  if (isRunning) {
    alert('프로그램이 실행 중입니다. 설정을 변경하려면 먼저 정지하세요.');
    return false;
  }
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
  renderTargetTable();
  updateTargetCount();
  if (currentView === '3d') render3dView();
  hideModal('targetModal');
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

// --- 3D Network View ---
function switchView(view) {
  currentView = view;
  const tableContainer = document.querySelector('.panel-left .table-container');
  const view3d = document.getElementById('view3d');

  if (view === '3d') {
    tableContainer.style.display = 'none';
    view3d.classList.add('active');
    render3dView();
  } else {
    tableContainer.style.display = '';
    view3d.classList.remove('active');
  }

  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

document.querySelectorAll('.view-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function calculateNodePositions(count) {
  const positions = [];
  if (count <= 10) {
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i / count) - Math.PI / 2;
      positions.push({
        x: 50 + 32 * Math.cos(angle),
        y: 50 + 35 * Math.sin(angle)
      });
    }
  } else {
    const inner = Math.min(Math.ceil(count / 2), 8);
    const outer = count - inner;
    for (let i = 0; i < inner; i++) {
      const angle = (2 * Math.PI * i / inner) - Math.PI / 2;
      positions.push({
        x: 50 + 21 * Math.cos(angle),
        y: 50 + 24 * Math.sin(angle)
      });
    }
    for (let i = 0; i < outer; i++) {
      const angle = (2 * Math.PI * i / outer) - Math.PI / 2 + (Math.PI / outer);
      positions.push({
        x: 50 + 39 * Math.cos(angle),
        y: 50 + 42 * Math.sin(angle)
      });
    }
  }
  return positions;
}

function render3dView() {
  const targets = settings.targets || [];
  const activeTargets = [];
  const targetIndices = [];
  targets.forEach((t, i) => {
    if (t.name && t.address) {
      activeTargets.push(t);
      targetIndices.push(i);
    }
  });

  const nodesContainer = document.getElementById('netNodes');
  const linesContainer = document.getElementById('netLines');
  nodesContainer.innerHTML = '';
  linesContainer.innerHTML = '';

  const positions = calculateNodePositions(activeTargets.length);

  activeTargets.forEach((target, i) => {
    const pos = positions[i];
    const idx = targetIndices[i];
    const status = target.enabled ? 'idle' : 'disabled';

    // Connection line (SVG)
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '50%');
    line.setAttribute('y1', '50%');
    line.setAttribute('x2', pos.x + '%');
    line.setAttribute('y2', pos.y + '%');
    line.setAttribute('class', 'net-line' + (target.enabled ? '' : ' status-disabled'));
    line.dataset.index = idx;
    linesContainer.appendChild(line);

    // Node element
    const node = document.createElement('div');
    node.className = 'net-node';
    node.dataset.index = idx;
    node.dataset.status = status;
    node.style.left = pos.x + '%';
    node.style.top = pos.y + '%';
    node.innerHTML = `
      <div class="node-beacon"></div>
      <div class="node-label">
        <div class="node-name">${escapeHtml(target.name)}</div>
        <div class="node-ip">${escapeHtml(target.address)}</div>
        <div class="node-status-text">${target.enabled ? '' : '비활성화'}</div>
      </div>
    `;
    nodesContainer.appendChild(node);
  });
}

function update3dNode(data) {
  const node = document.querySelector(`.net-node[data-index="${data.index}"]`);
  if (!node) return;

  const status = data.status === '장애' ? 'fail' : 'ok';
  node.dataset.status = status;

  const statusText = node.querySelector('.node-status-text');
  if (statusText) statusText.textContent = data.status;

  // Update connection line
  const line = document.querySelector(`.net-line[data-index="${data.index}"]`);
  if (line) {
    line.setAttribute('class', 'net-line status-' + status);
  }

  // Ping ripple
  const beacon = node.querySelector('.node-beacon');
  if (beacon) {
    const ripple = document.createElement('div');
    ripple.className = 'ping-ripple';
    beacon.appendChild(ripple);
    setTimeout(() => ripple.remove(), 1000);
  }
}

// --- Utility ---
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

const btnMaximize = document.getElementById('btnMaximize');

function setMaximizeIcon(isMaximized) {
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
