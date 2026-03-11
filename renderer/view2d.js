// renderer/view2d.js — 2D Network Topology View (read-only monitoring)
(function () {
  'use strict';

  let canvas, ctx;
  let active = false;
  let devices = [];
  let connections = [];
  let nodeStatus = {};      // index -> { status, timestamp }
  let discoveredNodes = [];  // [{ ip, totalBytes, connections }]
  let ipMap = {};            // ip -> target index
  let targets = [];
  let localIp = '';
  let topology = null;
  let animFrame = null;
  let resizeObs = null;
  let listEl = null;

  const REF_W = 800, REF_H = 500;
  const DEV_R = 22;

  const TYPES = {
    hub_center: { name: '\uAC10\uC2DC\uC13C\uD130', fill: '#e0f7fa', stroke: '#00bcd4' },
    router:     { name: '\uB77C\uC6B0\uD130',   fill: '#fff3e0', stroke: '#e67e22' },
    switch:     { name: '\uC2A4\uC704\uCE58',   fill: '#e8f5e9', stroke: '#4caf50' },
    pc:         { name: 'PC',       fill: '#e3f2fd', stroke: '#a60739' },
    server:     { name: '\uC11C\uBC84',     fill: '#f3e5f5', stroke: '#9b59b6' }
  };

  function findDev(id) {
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].id === id) return devices[i];
    }
    return null;
  }

  // Get status color for a device based on its target_index
  function getDeviceStatusColor(dev) {
    if (dev.type === 'hub_center') return '#00bcd4';
    if (dev.target_index === undefined || dev.target_index === null) {
      return null; // no target linked
    }
    const t = targets[dev.target_index];
    if (!t || !t.enabled) return '#555'; // disabled
    const st = nodeStatus[dev.target_index];
    if (!st) return null; // no data yet
    return st.status === '\uC7A5\uC560' ? '#e74c3c' : '#2ecc71';
  }

  // ===== Init =====
  function init() {
    const container = document.getElementById('view2dContainer');
    if (!container) return;
    if (active) return;

    canvas = document.getElementById('view2dCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    listEl = document.getElementById('discoveredList');
    active = true;

    resize();

    resizeObs = new ResizeObserver(() => {
      if (active) resize();
    });
    resizeObs.observe(container);

    render();
  }

  function dispose() {
    active = false;
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    canvas = null;
    ctx = null;
    listEl = null;
  }

  function resize() {
    if (!canvas || !ctx || !canvas.parentElement) return;
    const wrap = canvas.parentElement;
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Store logical size for coordinate calculations
    canvas._logicalW = wrap.clientWidth;
    canvas._logicalH = wrap.clientHeight;
    render();
  }

  // Override scale helpers to use logical size
  function sxL(v) { return v / REF_W * (canvas._logicalW || canvas.width); }
  function syL(v) { return v / REF_H * (canvas._logicalH || canvas.height); }
  function srL() { return DEV_R * ((canvas._logicalW || canvas.width) / REF_W); }

  function setTargets(t, map) {
    targets = t || [];
    ipMap = map || {};
    rebuildFromTopology();
    scheduleRender();
  }

  function setTopology(topo) {
    topology = topo;
    rebuildFromTopology();
    scheduleRender();
  }

  function rebuildFromTopology() {
    if (topology && topology.devices && topology.devices.length > 0) {
      devices = JSON.parse(JSON.stringify(topology.devices));
      connections = JSON.parse(JSON.stringify(topology.connections || []));
    } else {
      autoGenerate();
    }
  }

  function autoGenerate() {
    devices = [{ id: 'dev_hub', type: 'hub_center', name: '\uAC10\uC2DC\uC13C\uD130', ip: '', x: REF_W / 2, y: REF_H / 2 }];
    connections = [];
    const activeTargets = [];
    (targets || []).forEach(function (t, i) {
      if (t.name && t.address) activeTargets.push({ name: t.name, address: t.address, type: t.type || 'pc', realIdx: i });
    });
    const cx = REF_W / 2, cy = REF_H / 2, radius = Math.min(REF_W, REF_H) * 0.35;
    activeTargets.forEach(function (t, i) {
      const angle = (i / Math.max(activeTargets.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const id = 'auto_' + i;
      devices.push({
        id: id, type: t.type, name: t.name, ip: t.address,
        target_index: t.realIdx,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius
      });
      connections.push({ from: 'dev_hub', to: id });
    });
  }

  // ===== Rendering =====
  function render() {
    if (!ctx || !canvas || !canvas._logicalW) return;
    const w = canvas._logicalW, h = canvas._logicalH;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f0f1f4';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(0,0,0,0.05)';
    ctx.lineWidth = 1;
    const step = 40 * w / REF_W;
    for (let gx = step; gx < w; gx += step) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }
    for (let gy = step; gy < h; gy += step) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }

    // Connections
    for (let ci = 0; ci < connections.length; ci++) drawConn(connections[ci]);

    // Devices
    for (let di = 0; di < devices.length; di++) drawDev(devices[di]);

    // Empty state
    if (devices.length <= 1 && targets.filter(t => t.name && t.address).length === 0) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.font = '14px Pretendard, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('\uAC10\uC2DC\uB300\uC0C1\uC744 \uCD94\uAC00\uD558\uBA74 \uD1A0\uD3F4\uB85C\uC9C0\uAC00 \uD45C\uC2DC\uB429\uB2C8\uB2E4', w / 2, h / 2);
    }
  }

  function drawConn(conn) {
    const from = findDev(conn.from), to = findDev(conn.to);
    if (!from || !to) return;
    const fx = sxL(from.x), fy = syL(from.y);
    const tx = sxL(to.x), ty = syL(to.y);

    // Status-based line color
    const toColor = getDeviceStatusColor(to);
    const fromColor = getDeviceStatusColor(from);
    let lineColor = 'rgba(0,0,0,0.12)';
    if (toColor === '#e74c3c' || fromColor === '#e74c3c') {
      lineColor = 'rgba(231, 76, 60, 0.35)';
    } else if (toColor === '#2ecc71' || fromColor === '#2ecc71') {
      lineColor = 'rgba(46, 204, 113, 0.3)';
    }

    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawDev(dev) {
    const cfg = TYPES[dev.type] || TYPES.pc;
    const x = sxL(dev.x), y = syL(dev.y), r = srL();

    const statusColor = getDeviceStatusColor(dev);
    const strokeColor = statusColor || cfg.stroke;
    const fillColor = statusColor ? hexWithAlpha(statusColor, 0.18) : cfg.fill;

    ctx.save();

    // Glow for status
    if (statusColor === '#e74c3c') {
      ctx.shadowColor = '#e74c3c';
      ctx.shadowBlur = 14;
    } else if (statusColor === '#2ecc71') {
      ctx.shadowColor = '#2ecc71';
      ctx.shadowBlur = 10;
    } else if (dev.type === 'hub_center') {
      ctx.shadowColor = '#00bcd4';
      ctx.shadowBlur = 12;
    }

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;

    switch (dev.type) {
      case 'hub_center':
        ctx.beginPath();
        ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.2, y);
        ctx.lineTo(x, y + r * 1.2); ctx.lineTo(x - r * 1.2, y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      case 'router':
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - r * 0.55, y); ctx.lineTo(x + r * 0.55, y);
        ctx.moveTo(x, y - r * 0.55); ctx.lineTo(x, y + r * 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      case 'switch':
        rRect(x - r * 1.1, y - r * 0.6, r * 2.2, r * 1.2, 4);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (let si = -1; si <= 1; si++) {
          ctx.moveTo(x - r * 0.7, y + si * r * 0.3);
          ctx.lineTo(x + r * 0.7, y + si * r * 0.3);
        }
        ctx.lineWidth = 1; ctx.stroke();
        break;
      case 'server':
        rRect(x - r * 0.65, y - r, r * 1.3, r * 2, 3);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (let li = -2; li <= 1; li++) {
          const ly = y + li * r * 0.4 + r * 0.1;
          ctx.moveTo(x - r * 0.4, ly); ctx.lineTo(x + r * 0.4, ly);
        }
        ctx.lineWidth = 1; ctx.stroke();
        break;
      default: // pc
        rRect(x - r * 0.9, y - r * 0.65, r * 1.8, r * 1.1, 3);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + r * 0.45); ctx.lineTo(x, y + r * 0.75);
        ctx.moveTo(x - r * 0.5, y + r * 0.75); ctx.lineTo(x + r * 0.5, y + r * 0.75);
        ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();

    // Status indicator dot
    if (statusColor) {
      ctx.beginPath();
      ctx.arc(x + r * 0.7, y - r * 0.7, 4, 0, Math.PI * 2);
      ctx.fillStyle = statusColor;
      ctx.fill();
    }

    // Labels
    const fs = Math.max(10, 11 * (canvas._logicalW) / REF_W);
    ctx.textAlign = 'center';

    // Name
    ctx.fillStyle = '#2a2f3d';
    ctx.font = '600 ' + fs.toFixed(0) + 'px Pretendard, Segoe UI, sans-serif';
    ctx.fillText(dev.name, x, y + r + fs + 2);

    // IP
    if (dev.ip) {
      ctx.fillStyle = '#6b7694';
      ctx.font = Math.max(8, 9 * (canvas._logicalW) / REF_W).toFixed(0) + 'px Consolas, monospace';
      ctx.fillText(dev.ip, x, y + r + fs + 14);
    }

    // Status text
    if (dev.target_index !== undefined && dev.target_index !== null) {
      const st = nodeStatus[dev.target_index];
      if (st) {
        const stFs = Math.max(8, 9 * (canvas._logicalW) / REF_W);
        ctx.font = '700 ' + stFs.toFixed(0) + 'px Pretendard, sans-serif';
        ctx.fillStyle = st.status === '\uC7A5\uC560' ? '#c0392b' : '#27ae60';
        ctx.fillText(st.status, x, y + r + fs + 26);
      }
    }
  }

  function rRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function hexWithAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ===== Batched Rendering =====
  function scheduleRender() {
    if (animFrame) return;
    animFrame = requestAnimationFrame(() => {
      animFrame = null;
      render();
    });
  }

  // ===== Status Updates =====
  function updateNodeStatus(index, status, timestamp) {
    nodeStatus[index] = { status, timestamp };
    scheduleRender();
  }

  // ===== Discovered Nodes =====
  function handleDiscoveredNodes(nodes) {
    if (!active) return;
    // Filter out nodes that are already registered targets
    const registeredIps = new Set();
    targets.forEach(t => { if (t.address) registeredIps.add(t.address); });
    if (localIp) registeredIps.add(localIp);

    discoveredNodes = (nodes || [])
      .filter(n => !registeredIps.has(n.ip))
      .sort((a, b) => b.totalBytes - a.totalBytes);

    renderDiscoveredList();
  }

  function renderDiscoveredList() {
    if (!listEl) return;
    const tbody = listEl.querySelector('tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (discoveredNodes.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="3" style="color: var(--text-muted); text-align: center; padding: 12px;">\uBBF8\uB4F1\uB85D \uB178\uB4DC \uC5C6\uC74C</td>';
      tbody.appendChild(tr);
      return;
    }

    for (const node of discoveredNodes) {
      const tr = document.createElement('tr');
      const connCount = node.connections ? Object.keys(node.connections).length : 0;
      tr.innerHTML = `<td>${escapeHtml(node.ip)}</td><td>${formatBytes(node.totalBytes)}</td><td>${connCount}</td>`;
      tbody.appendChild(tr);
    }
  }

  function formatBytes(b) {
    if (!b || b <= 0) return '0B';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + 'G';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + 'M';
    if (b >= 1024) return (b / 1024).toFixed(1) + 'K';
    return b + 'B';
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Passthrough handlers (no-op for traffic data in 2D mode)
  function handleTrafficStats() {}
  function handleInterNodeStats() {}
  function handleAsterixFlows() {}

  // ===== Export =====
  window.view2d = {
    init, dispose, setTargets, setTopology, updateNodeStatus,
    handleTrafficStats, handleInterNodeStats,
    handleDiscoveredNodes, handleAsterixFlows,
    setIpMap: function (m) { ipMap = m; },
    setLocalIp: function (ip) { localIp = ip; },
    isActive: function () { return active; },
    render: render
  };
})();
