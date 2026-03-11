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

  // Traffic flow state
  let interNodeData = [];   // [{ src, dst, bytes, packets }]
  let animRunning = false;
  let pathCache = {};
  let adjList = null;

  const REF_W = 800, REF_H = 500;
  const DEV_R = 14;

  const TYPES = {
    hub_center: { name: '\uB124\uD2B8\uC6CC\uD06C \uAC10\uC2DCPC', fill: '#e0f7fa', stroke: '#00bcd4' },
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
    animRunning = false;
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    canvas = null;
    ctx = null;
    listEl = null;
    interNodeData = [];
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
  function srL(dev) {
    var s = dev ? (dev.size || 1.0) : 1.0;
    return DEV_R * s * ((canvas._logicalW || canvas.width) / REF_W);
  }

  function setTargets(t, map) {
    targets = t || [];
    ipMap = map || {};
    nodeStatus = {};
    rebuildFromTopology();
    scheduleRender();
  }

  function setTopology(topo) {
    topology = topo;
    rebuildFromTopology();
    scheduleRender();
  }

  function rebuildFromTopology() {
    pathCache = {};
    adjList = null;
    if (topology && topology.devices && topology.devices.length > 0) {
      devices = JSON.parse(JSON.stringify(topology.devices));
      connections = JSON.parse(JSON.stringify(topology.connections || []));
    } else {
      autoGenerate();
    }
  }

  function autoGenerate() {
    devices = [{ id: 'dev_hub', type: 'hub_center', name: '\uB124\uD2B8\uC6CC\uD06C \uAC10\uC2DCPC', ip: '', x: REF_W / 2, y: REF_H / 2 }];
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
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Connections
    for (let ci = 0; ci < connections.length; ci++) drawConn(connections[ci]);

    // Traffic flow particles
    renderTrafficFlows();

    // Devices (drawn on top of flow lines)
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
    const x = sxL(dev.x), y = syL(dev.y), r = srL(dev);

    const statusColor = getDeviceStatusColor(dev);
    const strokeColor = statusColor || cfg.stroke;
    const fillColor = statusColor ? hexWithAlpha(statusColor, 0.18) : cfg.fill;

    // Draw opaque white background to prevent shadow glow bleed from other devices
    ctx.fillStyle = '#ffffff';
    drawDevShape(dev.type, x, y, r);
    ctx.fill();

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
    const devSize = dev.size || 1.0;
    const fs = Math.max(9, 10 * devSize * (canvas._logicalW) / REF_W);
    ctx.textAlign = 'center';

    // Name
    ctx.fillStyle = '#2a2f3d';
    ctx.font = '600 ' + fs.toFixed(0) + 'px Pretendard, Segoe UI, sans-serif';
    ctx.fillText(dev.name, x, y + r + fs + 2);

    // IP
    if (dev.ip) {
      ctx.fillStyle = '#6b7694';
      ctx.font = Math.max(7, 8 * devSize * (canvas._logicalW) / REF_W).toFixed(0) + 'px Consolas, monospace';
      ctx.fillText(dev.ip, x, y + r + fs + 12);
    }

    // Status text (only for enabled targets)
    if (dev.target_index !== undefined && dev.target_index !== null) {
      const t = targets[dev.target_index];
      if (t && t.enabled) {
        const st = nodeStatus[dev.target_index];
        if (st) {
          const stFs = Math.max(7, 8 * devSize * (canvas._logicalW) / REF_W);
          ctx.font = '700 ' + stFs.toFixed(0) + 'px Pretendard, sans-serif';
          ctx.fillStyle = st.status === '\uC7A5\uC560' ? '#c0392b' : '#27ae60';
          ctx.fillText(st.status, x, y + r + fs + 26);
        }
      }
    }
  }

  // Trace device shape path (for white background fill)
  function drawDevShape(type, x, y, r) {
    switch (type) {
      case 'hub_center':
        ctx.beginPath();
        ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.2, y);
        ctx.lineTo(x, y + r * 1.2); ctx.lineTo(x - r * 1.2, y);
        ctx.closePath();
        break;
      case 'router':
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        break;
      case 'switch':
        rRect(x - r * 1.1, y - r * 0.6, r * 2.2, r * 1.2, 4);
        break;
      case 'server':
        rRect(x - r * 0.65, y - r, r * 1.3, r * 2, 3);
        break;
      default: // pc
        rRect(x - r * 0.9, y - r * 0.65, r * 1.8, r * 1.1, 3);
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
    if (animRunning) return; // animation loop handles rendering
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
    ensureAnimation();
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

  // ===== Traffic Flow Animation =====

  function handleInterNodeStats(data) {
    interNodeData = data || [];
    ensureAnimation();
  }

  function hasActiveFlows() {
    if (interNodeData.length > 0) return true;
    for (let i = 0; i < discoveredNodes.length; i++) {
      if (discoveredNodes[i].connections && Object.keys(discoveredNodes[i].connections).length > 0) return true;
    }
    return false;
  }

  function ensureAnimation() {
    if (hasActiveFlows() && !animRunning && active) {
      animRunning = true;
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      animFrame = requestAnimationFrame(animTick);
    }
  }

  function animTick(now) {
    if (!animRunning || !active || !ctx) {
      animRunning = false;
      animFrame = null;
      return;
    }
    render();
    if (hasActiveFlows()) {
      animFrame = requestAnimationFrame(animTick);
    } else {
      animRunning = false;
      animFrame = null;
    }
  }

  // ===== Graph Shortest Path (BFS) =====

  function buildAdjListIfNeeded() {
    if (adjList) return;
    adjList = {};
    for (let i = 0; i < devices.length; i++) adjList[devices[i].id] = [];
    for (let i = 0; i < connections.length; i++) {
      const c = connections[i];
      if (adjList[c.from]) adjList[c.from].push(c.to);
      if (adjList[c.to]) adjList[c.to].push(c.from);
    }
  }

  function findPath(fromId, toId) {
    if (fromId === toId) return null;
    const key = fromId + '|' + toId;
    if (key in pathCache) return pathCache[key];
    buildAdjListIfNeeded();

    const visited = {};
    visited[fromId] = true;
    const queue = [[fromId]];
    while (queue.length > 0) {
      const path = queue.shift();
      const node = path[path.length - 1];
      if (node === toId) {
        pathCache[key] = path;
        return path;
      }
      const neighbors = adjList[node];
      if (!neighbors) continue;
      for (let i = 0; i < neighbors.length; i++) {
        if (!visited[neighbors[i]]) {
          visited[neighbors[i]] = true;
          queue.push(path.concat(neighbors[i]));
        }
      }
    }
    pathCache[key] = null;
    return null;
  }

  // ===== Traffic Flow Rendering =====

  function renderTrafficFlows() {
    if (!hasActiveFlows()) return;
    const t = performance.now() / 1000;

    // Build IP -> device map
    const ipToDev = {};
    for (let i = 0; i < devices.length; i++) {
      if (devices[i].ip) ipToDev[devices[i].ip] = devices[i];
    }
    // Map localIp to hub_center
    const hubDev = devices.find(function (d) { return d.type === 'hub_center'; });
    if (localIp && hubDev) ipToDev[localIp] = hubDev;

    // 1. Inter-node flows (registered device ↔ registered device)
    for (let i = 0; i < interNodeData.length; i++) {
      const flow = interNodeData[i];
      const srcDev = ipToDev[flow.src];
      const dstDev = ipToDev[flow.dst];
      if (!srcDev || !dstDev) continue;
      // Skip flows involving hub_center
      if (srcDev.type === 'hub_center' || dstDev.type === 'hub_center') continue;

      const path = findPath(srcDev.id, dstDev.id);
      if (!path || path.length < 2) continue;

      var count = Math.max(1, Math.min(5, Math.ceil(Math.log2(flow.bytes / 500 + 1))));
      var speed = 0.4;

      for (let p = 0; p < count; p++) {
        var phase = ((t * speed + p / count) % 1 + 1) % 1;
        drawPathParticle(path, phase, 'rgba(52, 152, 219, 0.85)', Math.min(4, 2 + flow.bytes / 30000));
      }
    }

    // 2. Discovered node flows (external → registered device)
    for (let i = 0; i < discoveredNodes.length; i++) {
      const node = discoveredNodes[i];
      if (!node.connections) continue;
      const entries = Object.entries(node.connections);
      for (let j = 0; j < entries.length; j++) {
        const targetIp = entries[j][0];
        const conn = entries[j][1];
        const targetDev = ipToDev[targetIp];
        if (!targetDev || targetDev.type === 'hub_center') continue;

        var dCount = Math.max(1, Math.min(3, Math.ceil(Math.log2(conn.bytes / 2000 + 1))));
        var dSpeed = 0.5;
        var angle = simpleHash(node.ip) % 628 / 100; // 0 ~ 6.28 radians

        for (let p = 0; p < dCount; p++) {
          var dPhase = ((t * dSpeed + p / dCount) % 1 + 1) % 1;
          drawExternalParticle(targetDev, dPhase, angle, 'rgba(156, 39, 176, 0.75)');
        }
      }
    }
  }

  function drawPathParticle(pathIds, phase, color, size) {
    const segments = pathIds.length - 1;
    const pos = phase * segments;
    const segIdx = Math.min(Math.floor(pos), segments - 1);
    const segT = pos - segIdx;

    const from = findDev(pathIds[segIdx]);
    const to = findDev(pathIds[segIdx + 1]);
    if (!from || !to) return;

    const x = sxL(from.x + (to.x - from.x) * segT);
    const y = syL(from.y + (to.y - from.y) * segT);
    const r = Math.max(2, size);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawExternalParticle(dev, phase, angle, color) {
    const tx = sxL(dev.x), ty = syL(dev.y);
    const dist = srL(dev) * 5;
    // Outer start point
    const ox = tx + Math.cos(angle) * dist;
    const oy = ty + Math.sin(angle) * dist;

    // phase 0 = outer, phase 1 = at device
    const x = ox + (tx - ox) * phase;
    const y = oy + (ty - oy) * phase;

    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function simpleHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  // Passthrough handlers (no-op for unused traffic data)
  function handleTrafficStats() {}
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
