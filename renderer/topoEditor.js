// renderer/topoEditor.js — 2D Network Topology Editor
(function () {
  'use strict';

  let canvas, ctx;
  let devices = [];
  let connections = [];
  let mode = 'select';
  let selectedId = null;
  let connectFromId = null;
  let dragging = false;
  let dragId = null;
  let dragOX = 0, dragOY = 0;
  let mouseX = 0, mouseY = 0;
  let onSelectCb = null;

  const REF_W = 800, REF_H = 500;
  const DEV_R = 20;

  const TYPES = {
    hub_center: { name: '감시센터', fill: '#004d5a', stroke: '#00bcd4' },
    router: { name: '라우터', fill: '#5d2700', stroke: '#e67e22' },
    switch: { name: '스위치', fill: '#1a4d1a', stroke: '#4caf50' },
    pc: { name: 'PC', fill: '#0d2d5e', stroke: '#3498db' },
    server: { name: '서버', fill: '#2a0845', stroke: '#9b59b6' }
  };

  let _uidSeq = 0;
  function uid() {
    return 'dev_' + Date.now().toString(36) + '_' + (++_uidSeq).toString(36) + Math.random().toString(36).substr(2, 4);
  }

  function sx(v) { return v / REF_W * canvas.width; }
  function sy(v) { return v / REF_H * canvas.height; }
  function ux(v) { return canvas.width ? (v / canvas.width * REF_W) : 0; }
  function uy(v) { return canvas.height ? (v / canvas.height * REF_H) : 0; }
  function sr() { return DEV_R * (canvas.width / REF_W); }

  // ===== Init =====
  function init(canvasEl, onSelect) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    onSelectCb = onSelect;
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  function resize() {
    if (!canvas || !canvas.parentElement) return;
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    render();
  }

  // ===== Load / Save =====
  function load(topology, targets) {
    if (topology && topology.devices && topology.devices.length > 0) {
      devices = JSON.parse(JSON.stringify(topology.devices));
      connections = JSON.parse(JSON.stringify(topology.connections || []));
    } else {
      autoGenerate(targets);
    }
    selectedId = null;
    connectFromId = null;
    mode = 'select';
  }

  function save() {
    return {
      devices: JSON.parse(JSON.stringify(devices)),
      connections: JSON.parse(JSON.stringify(connections)),
      canvas_width: REF_W, canvas_height: REF_H
    };
  }

  function autoGenerate(targets) {
    devices = [{ id: 'dev_hub', type: 'hub_center', name: '감시센터', ip: '', x: REF_W / 2, y: REF_H / 2 }];
    connections = [];
    const active = [];
    (targets || []).forEach(function (t, i) {
      if (t.name && t.address) active.push({ name: t.name, address: t.address, realIdx: i });
    });
    var cx = REF_W / 2, cy = REF_H / 2, radius = Math.min(REF_W, REF_H) * 0.35;
    active.forEach(function (t, i) {
      var angle = (i / Math.max(active.length, 1)) * Math.PI * 2 - Math.PI / 2;
      var id = uid();
      devices.push({
        id: id, type: 'pc', name: t.name, ip: t.address,
        target_index: t.realIdx,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius
      });
      connections.push({ from: 'dev_hub', to: id });
    });
  }

  // ===== Rendering =====
  function render() {
    if (!ctx || !canvas || !canvas.width) return;
    var w = canvas.width, h = canvas.height;

    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    var step = 40 * w / REF_W;
    for (var gx = step; gx < w; gx += step) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
    for (var gy = step; gy < h; gy += step) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

    // Connections
    for (var ci = 0; ci < connections.length; ci++) drawConn(connections[ci]);

    // Connect preview line
    if (mode === 'connect' && connectFromId) {
      var from = findDev(connectFromId);
      if (from) {
        ctx.beginPath();
        ctx.moveTo(sx(from.x), sy(from.y));
        ctx.lineTo(mouseX, mouseY);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Devices
    for (var di = 0; di < devices.length; di++) drawDev(devices[di]);

    // Mode hint
    var hint = '';
    if (mode === 'connect') hint = connectFromId ? '두 번째 장비를 클릭하세요' : '첫 번째 장비를 클릭하세요';
    else if (mode === 'delete') hint = '삭제할 장비 또는 연결선을 클릭하세요';
    else if (mode.startsWith('add_')) hint = '캔버스를 클릭하여 배치하세요';
    if (hint) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = Math.max(11, 12 * w / REF_W).toFixed(0) + 'px Pretendard, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(hint, w / 2, h - 10);
    }
  }

  function drawConn(conn) {
    var from = findDev(conn.from), to = findDev(conn.to);
    if (!from || !to) return;
    var sel = selectedId && (selectedId === conn.from || selectedId === conn.to);
    ctx.beginPath();
    ctx.moveTo(sx(from.x), sy(from.y));
    ctx.lineTo(sx(to.x), sy(to.y));
    ctx.strokeStyle = sel ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.stroke();
    // Port dots at endpoints
    var r = 3;
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
    ctx.beginPath(); ctx.arc(sx(from.x), sy(from.y), r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx(to.x), sy(to.y), r, 0, Math.PI * 2); ctx.fill();
  }

  function drawDev(dev) {
    var cfg = TYPES[dev.type] || TYPES.pc;
    var x = sx(dev.x), y = sy(dev.y), r = sr();
    var sel = dev.id === selectedId;

    ctx.save();
    if (sel) { ctx.shadowColor = cfg.stroke; ctx.shadowBlur = 18; }

    ctx.fillStyle = cfg.fill;
    ctx.strokeStyle = cfg.stroke;
    ctx.lineWidth = sel ? 2.5 : 1.5;

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
        ctx.stroke();
        // Arrow tips
        var ar = r * 0.2;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
          var tx = x + d[0] * r * 0.55, ty = y + d[1] * r * 0.55;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - d[0] * ar + d[1] * ar * 0.6, ty - d[1] * ar - d[0] * ar * 0.6);
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - d[0] * ar - d[1] * ar * 0.6, ty - d[1] * ar + d[0] * ar * 0.6);
          ctx.stroke();
        });
        break;
      case 'switch':
        rRect(x - r * 1.1, y - r * 0.6, r * 2.2, r * 1.2, 4);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (var si = -1; si <= 1; si++) { ctx.moveTo(x - r * 0.7, y + si * r * 0.3); ctx.lineTo(x + r * 0.7, y + si * r * 0.3); }
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      case 'server':
        rRect(x - r * 0.65, y - r, r * 1.3, r * 2, 3);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        for (var li = -2; li <= 1; li++) { var ly = y + li * r * 0.4 + r * 0.1; ctx.moveTo(x - r * 0.4, ly); ctx.lineTo(x + r * 0.4, ly); }
        ctx.lineWidth = 1;
        ctx.stroke();
        break;
      default: // pc
        rRect(x - r * 0.9, y - r * 0.65, r * 1.8, r * 1.1, 3);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y + r * 0.45); ctx.lineTo(x, y + r * 0.75);
        ctx.moveTo(x - r * 0.5, y + r * 0.75); ctx.lineTo(x + r * 0.5, y + r * 0.75);
        ctx.stroke();
    }
    ctx.restore();

    // Labels
    var fs = Math.max(10, 11 * canvas.width / REF_W);
    ctx.textAlign = 'center';
    ctx.fillStyle = sel ? '#ffffff' : '#c8cdd8';
    ctx.font = (sel ? 'bold ' : '') + fs.toFixed(0) + 'px Pretendard, Segoe UI, sans-serif';
    ctx.fillText(dev.name, x, y + r + fs + 2);
    if (dev.ip) {
      ctx.fillStyle = '#7a849a';
      ctx.font = Math.max(8, 9 * canvas.width / REF_W).toFixed(0) + 'px Consolas, monospace';
      ctx.fillText(dev.ip, x, y + r + fs + 14);
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

  // ===== Hit Testing =====
  function findDev(id) {
    for (var i = 0; i < devices.length; i++) { if (devices[i].id === id) return devices[i]; }
    return null;
  }

  function hitDevice(mx, my) {
    var r = sr() * 1.3;
    for (var i = devices.length - 1; i >= 0; i--) {
      var d = devices[i];
      var dx = mx - sx(d.x), dy = my - sy(d.y);
      if (dx * dx + dy * dy < r * r) return d;
    }
    return null;
  }

  function hitConnection(mx, my) {
    for (var i = 0; i < connections.length; i++) {
      var c = connections[i];
      var from = findDev(c.from), to = findDev(c.to);
      if (!from || !to) continue;
      if (ptLineDist(mx, my, sx(from.x), sy(from.y), sx(to.x), sy(to.y)) < 10) return c;
    }
    return null;
  }

  function ptLineDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    var t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  // ===== Mouse Handlers =====
  function getPos(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onDown(e) {
    if (!canvas) return;
    var p = getPos(e);
    mouseX = p.x; mouseY = p.y;

    // Add mode
    if (mode.startsWith('add_')) {
      var type = mode.replace('add_', '');
      var cfg = TYPES[type];
      var dev = { id: uid(), type: type, name: cfg ? cfg.name : type, ip: '', x: ux(p.x), y: uy(p.y) };
      devices.push(dev);
      selectedId = dev.id;
      mode = 'select';
      updateToolbar();
      if (onSelectCb) onSelectCb(dev);
      render();
      return;
    }

    // Connect mode
    if (mode === 'connect') {
      var hit = hitDevice(p.x, p.y);
      if (hit) {
        if (!connectFromId) {
          connectFromId = hit.id;
          selectedId = hit.id;
          if (onSelectCb) onSelectCb(hit);
        } else if (hit.id === connectFromId) {
          // Clicked same device — cancel connection attempt
          connectFromId = null;
        } else {
          var exists = connections.some(function (c) {
            return (c.from === connectFromId && c.to === hit.id) || (c.from === hit.id && c.to === connectFromId);
          });
          if (!exists) connections.push({ from: connectFromId, to: hit.id });
          connectFromId = null;
        }
      } else {
        connectFromId = null;
      }
      render();
      return;
    }

    // Delete mode
    if (mode === 'delete') {
      var hitDev = hitDevice(p.x, p.y);
      if (hitDev && hitDev.type !== 'hub_center') {
        devices = devices.filter(function (d) { return d.id !== hitDev.id; });
        connections = connections.filter(function (c) { return c.from !== hitDev.id && c.to !== hitDev.id; });
        if (selectedId === hitDev.id) { selectedId = null; if (onSelectCb) onSelectCb(null); }
        render();
        return;
      }
      var hitConn = hitConnection(p.x, p.y);
      if (hitConn) {
        connections = connections.filter(function (c) { return c !== hitConn; });
        render();
        return;
      }
      return;
    }

    // Select mode
    var sel = hitDevice(p.x, p.y);
    if (sel) {
      selectedId = sel.id;
      dragging = true;
      dragId = sel.id;
      dragOX = p.x - sx(sel.x);
      dragOY = p.y - sy(sel.y);
      canvas.setPointerCapture(e.pointerId);
      if (onSelectCb) onSelectCb(sel);
    } else {
      selectedId = null;
      if (onSelectCb) onSelectCb(null);
    }
    render();
  }

  function onMove(e) {
    if (!canvas) return;
    var p = getPos(e);
    mouseX = p.x; mouseY = p.y;
    if (dragging && dragId) {
      var dev = findDev(dragId);
      if (dev) {
        dev.x = Math.max(DEV_R, Math.min(REF_W - DEV_R, ux(p.x - dragOX)));
        dev.y = Math.max(DEV_R, Math.min(REF_H - DEV_R, uy(p.y - dragOY)));
      }
      render();
      return;
    }
    if (mode === 'connect' && connectFromId) render();
  }

  function onUp(e) {
    if (!canvas) return;
    if (dragging && dragId) {
      if (onSelectCb) {
        var dev = findDev(dragId);
        if (dev) onSelectCb(dev);
      }
      if (e && e.pointerId !== undefined) {
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    }
    dragging = false;
    dragId = null;
  }

  function updateToolbar() {
    document.querySelectorAll('.topo-tool-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  // ===== API =====
  function setMode(m) {
    mode = m;
    connectFromId = null;
    if (canvas) canvas.style.cursor = m === 'select' ? 'default' : 'crosshair';
    updateToolbar();
    if (canvas) render();
  }

  function updateDevice(id, props) {
    var dev = findDev(id);
    if (!dev) return;
    if (props.name !== undefined) dev.name = props.name;
    if (props.ip !== undefined) dev.ip = props.ip;
    if (props.target_index !== undefined) dev.target_index = props.target_index;
    render();
  }

  function destroy() {
    if (canvas) {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    }
    canvas = null; ctx = null;
    devices = []; connections = [];
    onSelectCb = null;
    selectedId = null;
    connectFromId = null;
    dragging = false;
    dragId = null;
  }

  window.topoEditor = {
    init: init, resize: resize, load: load, save: save, render: render,
    setMode: setMode, updateDevice: updateDevice, destroy: destroy
  };
})();
