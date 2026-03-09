// renderer/view3d.js — Three.js 3D Network Visualization
(function () {
  'use strict';

  // ===== Simple Orbit Controls =====
  class OrbitControls {
    constructor(camera, domElement) {
      this.camera = camera;
      this.domElement = domElement;
      this.target = new THREE.Vector3();
      this.spherical = new THREE.Spherical();
      this.rotateSpeed = 0.005;
      this.zoomSpeed = 0.08;
      this.dampingFactor = 0.12;
      this.autoRotate = true;
      this.autoRotateSpeed = 0.3;
      this.minDistance = 15;
      this.maxDistance = 120;
      this.maxPolarAngle = Math.PI * 0.85;
      this.minPolarAngle = 0.1;

      this._dragging = false;
      this._prevX = 0;
      this._prevY = 0;
      this._velTheta = 0;
      this._velPhi = 0;
      this._lastInteraction = 0;
      this._autoRotateDelay = 3000; // ms delay before auto-rotate resumes

      const offset = camera.position.clone().sub(this.target);
      this.spherical.setFromVector3(offset);

      // Store bound handlers for cleanup
      this._onPointerDown = (e) => {
        this._dragging = true;
        this._prevX = e.clientX;
        this._prevY = e.clientY;
        domElement.setPointerCapture(e.pointerId);
      };
      this._onPointerMove = (e) => {
        if (!this._dragging) return;
        const dx = e.clientX - this._prevX;
        const dy = e.clientY - this._prevY;
        this._prevX = e.clientX;
        this._prevY = e.clientY;
        this.spherical.theta -= dx * this.rotateSpeed;
        this.spherical.phi -= dy * this.rotateSpeed;
        this.spherical.phi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this.spherical.phi));
        this._velTheta = -dx * this.rotateSpeed;
        this._velPhi = -dy * this.rotateSpeed;
        this._lastInteraction = Date.now();
      };
      this._onPointerUp = () => {
        this._dragging = false;
        this._lastInteraction = Date.now();
      };
      this._onWheel = (e) => {
        e.preventDefault();
        this.spherical.radius *= (1 + Math.sign(e.deltaY) * this.zoomSpeed);
        this.spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.spherical.radius));
        this._lastInteraction = Date.now();
      };

      domElement.addEventListener('pointerdown', this._onPointerDown);
      domElement.addEventListener('pointermove', this._onPointerMove);
      domElement.addEventListener('pointerup', this._onPointerUp);
      domElement.addEventListener('pointercancel', this._onPointerUp);
      domElement.addEventListener('wheel', this._onWheel, { passive: false });
    }
    update(dt) {
      if (!this._dragging) {
        const idleTime = Date.now() - this._lastInteraction;
        if (this.autoRotate && idleTime > this._autoRotateDelay) {
          const factor = Math.min((idleTime - this._autoRotateDelay) / 1000, 1);
          this.spherical.theta -= this.autoRotateSpeed * Math.PI / 180 * (dt || 0.016) * factor;
        }
        this.spherical.theta += this._velTheta;
        this.spherical.phi += this._velPhi;
        this._velTheta *= (1 - this.dampingFactor);
        this._velPhi *= (1 - this.dampingFactor);
        if (Math.abs(this._velTheta) < 0.00001) this._velTheta = 0;
        if (Math.abs(this._velPhi) < 0.00001) this._velPhi = 0;
      }
      this.spherical.phi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this.spherical.phi));
      _tmpVec.setFromSpherical(this.spherical);
      this.camera.position.copy(this.target).add(_tmpVec);
      this.camera.lookAt(this.target);
    }
    dispose() {
      this.domElement.removeEventListener('pointerdown', this._onPointerDown);
      this.domElement.removeEventListener('pointermove', this._onPointerMove);
      this.domElement.removeEventListener('pointerup', this._onPointerUp);
      this.domElement.removeEventListener('pointercancel', this._onPointerUp);
      this.domElement.removeEventListener('wheel', this._onWheel);
    }
  }

  // ===== Pre-allocated temp vectors (avoid GC pressure) =====
  const _tmpVec = new THREE.Vector3();
  const _tmpVec2 = new THREE.Vector3();
  const _tmpVec3 = new THREE.Vector3();
  const _screenVec = new THREE.Vector3();
  const _hubPos = new THREE.Vector3(0, 0, 0);

  // ===== State =====
  let scene, camera, webgl, controls;
  let container, labelOverlay;
  let clock, animId = null;
  let active = false;
  let resizeObserver = null;

  let hubGroup;
  const tgtNodes = {};       // index -> { group, sphere, glow, ring, line, labels{name,ip,status,bw}, pos, status }
  const discNodes = {};      // ip -> { group, sphere, label, pos, lastSeen, lines:{peerIp:Line} }
  const discPosCache = {};   // ip -> Vector3 (persists across remove/readd)
  const interLines = {};     // "src>dst" -> Line
  const asterixObjs = {};    // "src>dst" -> { line, label }
  let asterixLastSeen = {};

  // Particles (Points-based for performance: 1 draw call instead of 600)
  const particles = [];
  const MAX_P = 300;
  let pGeo, pPts, pMat;

  let ipMap = {};
  let localIp = '';
  let targets = [];
  let topology = null;
  const infraNodes = {};    // deviceId -> { group, label, pos, _geo, _mat }
  const topoLines = {};     // "from>to" -> { line, _geo, _mat }
  let ambientTimer = null;
  let hasRealData = false;
  let emptyStateEl = null;

  // Track all scene objects for proper disposal
  let sceneObjects = [];

  // Constants
  const TGT_R = 25;
  const DISC_R = 40;

  const C_HUB = 0x00e5ff;
  const C_OK = 0x00ff88;
  const C_FAIL = 0xff2244;
  const C_IDLE = 0x4fc3f7;
  const C_DISABLED = 0x424242;
  const C_DISC = 0xffab40;

  const PROTO_C = {
    tcp: new THREE.Color(0x00b0ff),
    udp: new THREE.Color(0x00e676),
    icmp: new THREE.Color(0xd500f9),
    other: new THREE.Color(0x78909c)
  };
  const AST_C = {
    48: 0x00e5ff, 34: 0xffab00, 62: 0xea80fc, 240: 0xb2ff59,
    1: 0x26c6da, 21: 0xff8a65, 10: 0x69f0ae, _default: 0xb0bec5
  };
  const AST_NAMES = {
    48: '레이더', 34: '상태', 62: '항적', 240: '영상',
    1: '레이더(L)', 21: 'ADS-B', 10: '지상감시'
  };

  // ===== Init =====
  function init() {
    container = document.getElementById('view3dContainer');
    if (!container || active) return;
    container.innerHTML = '';
    sceneObjects = [];

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060a12);
    scene.fog = new THREE.FogExp2(0x060a12, 0.004);

    const w = container.clientWidth || 400;
    const h = container.clientHeight || 300;
    camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 500);
    camera.position.set(0, 30, 55);

    webgl = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    webgl.setSize(w, h);
    webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    webgl.toneMapping = THREE.ACESFilmicToneMapping;
    webgl.toneMappingExposure = 1.2;
    container.appendChild(webgl.domElement);

    controls = new OrbitControls(camera, webgl.domElement);

    labelOverlay = document.createElement('div');
    labelOverlay.className = 'v3d-overlay';
    container.appendChild(labelOverlay);

    // Scanline overlay
    const scanline = document.createElement('div');
    scanline.className = 'v3d-scanline';
    container.appendChild(scanline);

    // Lights
    const ambient = new THREE.AmbientLight(0x334466, 0.8);
    scene.add(ambient);
    const pl = new THREE.PointLight(0x00e5ff, 3, 100);
    pl.position.set(0, 10, 0);
    scene.add(pl);
    const hemi = new THREE.HemisphereLight(0x4466aa, 0x112233, 0.5);
    scene.add(hemi);
    // Secondary fill light for outer nodes
    const fill = new THREE.PointLight(0x6688cc, 1.2, 150);
    fill.position.set(-30, 25, -30);
    scene.add(fill);
    // Back fill for depth
    const backFill = new THREE.PointLight(0x00e5ff, 0.6, 120);
    backFill.position.set(30, 15, 30);
    scene.add(backFill);

    buildGrid();
    buildHub();
    buildStars();
    buildParticleSystem();

    // Empty state indicator
    emptyStateEl = document.createElement('div');
    emptyStateEl.className = 'v3d-empty-state';
    emptyStateEl.textContent = '감시대상을 추가하세요';
    emptyStateEl.style.display = 'none';
    container.appendChild(emptyStateEl);

    clock = new THREE.Clock();

    // Store ResizeObserver for cleanup
    resizeObserver = new ResizeObserver(() => onResize());
    resizeObserver.observe(container);

    active = true;
    animate();
  }

  // ===== Environment =====
  function buildGrid() {
    const mat = new THREE.LineBasicMaterial({ color: 0x1a2a3e, transparent: true, opacity: 0.5 });
    for (let r = 10; r <= 50; r += 10) {
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, -0.5, Math.sin(a) * r));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      sceneObjects.push({ geo, obj: line });
    }
    const cm = new THREE.LineBasicMaterial({ color: 0x1a2a3e, transparent: true, opacity: 0.3 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(Math.cos(a) * 50, -0.5, Math.sin(a) * 50),
        new THREE.Vector3(-Math.cos(a) * 50, -0.5, -Math.sin(a) * 50)
      ]);
      const line = new THREE.Line(geo, cm);
      scene.add(line);
      sceneObjects.push({ geo, obj: line });
    }
    sceneObjects.push({ mat }, { mat: cm });
  }

  function buildHub() {
    hubGroup = new THREE.Group();

    // Core sphere
    const coreGeo = new THREE.SphereGeometry(2, 32, 32);
    const coreMat = new THREE.MeshPhongMaterial({
      color: C_HUB, emissive: C_HUB, emissiveIntensity: 0.6, shininess: 100, transparent: true, opacity: 0.95
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    hubGroup.add(core);
    sceneObjects.push({ geo: coreGeo, mat: coreMat });

    // Glow sphere
    const glowGeo = new THREE.SphereGeometry(3.2, 24, 24);
    const glowMat = new THREE.MeshBasicMaterial({ color: C_HUB, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false });
    hubGroup.add(new THREE.Mesh(glowGeo, glowMat));
    sceneObjects.push({ geo: glowGeo, mat: glowMat });

    // Energy field (outer pulsing sphere)
    const fieldGeo = new THREE.SphereGeometry(4.5, 16, 16);
    const fieldMat = new THREE.MeshBasicMaterial({
      color: 0x00e5ff, transparent: true, opacity: 0.06,
      blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true
    });
    const field = new THREE.Mesh(fieldGeo, fieldMat);
    hubGroup.add(field);
    hubGroup.userData.field = field;
    sceneObjects.push({ geo: fieldGeo, mat: fieldMat });

    // Ring 1
    const ring1Geo = new THREE.TorusGeometry(3.5, 0.06, 8, 64);
    const ring1Mat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring1 = new THREE.Mesh(ring1Geo, ring1Mat);
    ring1.rotation.x = Math.PI / 2;
    hubGroup.add(ring1);
    hubGroup.userData.ring1 = ring1;
    sceneObjects.push({ geo: ring1Geo, mat: ring1Mat });

    // Ring 2
    const ring2Geo = new THREE.TorusGeometry(4.2, 0.04, 8, 64);
    const ring2Mat = new THREE.MeshBasicMaterial({ color: C_HUB, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
    ring2.rotation.x = Math.PI / 3;
    ring2.rotation.y = Math.PI / 4;
    hubGroup.add(ring2);
    hubGroup.userData.ring2 = ring2;
    sceneObjects.push({ geo: ring2Geo, mat: ring2Mat });

    // Ring 3 (new — slow outer orbit)
    const ring3Geo = new THREE.TorusGeometry(5.0, 0.025, 8, 64);
    const ring3Mat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring3 = new THREE.Mesh(ring3Geo, ring3Mat);
    ring3.rotation.x = Math.PI / 5;
    ring3.rotation.z = Math.PI / 6;
    hubGroup.add(ring3);
    hubGroup.userData.ring3 = ring3;
    sceneObjects.push({ geo: ring3Geo, mat: ring3Mat });

    hubGroup.userData.label = makeLabel('감시센터', '#00e5ff', 'v3d-label hub');
    scene.add(hubGroup);
  }

  function buildStars() {
    const n = 800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 300;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 200;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 300;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x667788, size: 0.6, transparent: true, opacity: 0.7, sizeAttenuation: true
    });
    const pts = new THREE.Points(geo, mat);
    scene.add(pts);
    sceneObjects.push({ geo, mat, obj: pts });
  }

  // ===== Particle System (Points-based: 1 draw call) =====
  // Trail system: each particle spawns TRAIL_LEN sub-points
  const TRAIL_LEN = 4;
  const MAX_DRAW = MAX_P * TRAIL_LEN;

  function buildParticleSystem() {
    pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DRAW * 3), 3));
    pGeo.setAttribute('customColor', new THREE.BufferAttribute(new Float32Array(MAX_DRAW * 3), 3));
    pGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAX_DRAW), 1));
    pGeo.setAttribute('opacity', new THREE.BufferAttribute(new Float32Array(MAX_DRAW), 1));
    pGeo.setDrawRange(0, 0);

    pMat = new THREE.ShaderMaterial({
      vertexShader: [
        'attribute float size;',
        'attribute float opacity;',
        'attribute vec3 customColor;',
        'varying float vOpacity;',
        'varying vec3 vColor;',
        'void main() {',
        '  vColor = customColor;',
        '  vOpacity = opacity;',
        '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = size * (300.0 / -mvPosition.z);',
        '  gl_Position = projectionMatrix * mvPosition;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying float vOpacity;',
        'varying vec3 vColor;',
        'void main() {',
        '  float d = length(gl_PointCoord - vec2(0.5));',
        '  if (d > 0.5) discard;',
        '  float core = smoothstep(0.5, 0.0, d);',
        '  float glow = exp(-d * d * 8.0) * 0.6;',
        '  float alpha = (core + glow) * vOpacity;',
        '  vec3 brightened = vColor + core * 0.4;',
        '  gl_FragColor = vec4(brightened, alpha);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    pPts = new THREE.Points(pGeo, pMat);
    pPts.frustumCulled = false;
    scene.add(pPts);
  }

  function emitParticle(from, to, color, speed, delay, size) {
    if (particles.length >= MAX_P) return;
    const col = color instanceof THREE.Color ? color : new THREE.Color(color);
    particles.push({
      from: from.clone(), to: to.clone(),
      color: col, speed: speed || 0.5,
      delay: delay || 0, age: 0,
      progress: 0, size: size || 1
    });
  }

  function tickParticles(dt) {
    const dtMs = dt * 1000;
    // Update and remove dead particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dtMs;
      if (p.age >= p.delay) {
        p.progress += p.speed * dt;
        if (p.progress >= 1) { particles.splice(i, 1); }
      }
    }
    // Write visible particles + trail sub-points to typed arrays
    const posArr = pGeo.attributes.position.array;
    const colArr = pGeo.attributes.customColor.array;
    const sizeArr = pGeo.attributes.size.array;
    const opaArr = pGeo.attributes.opacity.array;
    let count = 0;
    const trailStep = 0.04; // how far back each trail point is
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p.age < p.delay) continue;
      if (count + TRAIL_LEN > MAX_DRAW) break;

      _tmpVec2.subVectors(p.to, p.from);
      const len = _tmpVec2.length();
      if (len > 0) _tmpVec2.divideScalar(len);
      _tmpVec3.set(-_tmpVec2.z, 0, _tmpVec2.x);
      if (_tmpVec3.lengthSq() < 0.001) _tmpVec3.set(1, 0, 0);
      _tmpVec3.normalize();

      // Draw head + trail points
      for (let tr = 0; tr < TRAIL_LEN; tr++) {
        const t = Math.max(0, p.progress - tr * trailStep);
        const wobble = Math.sin(t * Math.PI * 3 + p.age * 0.003) * 0.6;
        const idx3 = count * 3;
        posArr[idx3] = p.from.x + (p.to.x - p.from.x) * t + _tmpVec3.x * wobble;
        posArr[idx3 + 1] = p.from.y + (p.to.y - p.from.y) * t + Math.sin(t * Math.PI) * 1.5;
        posArr[idx3 + 2] = p.from.z + (p.to.z - p.from.z) * t + _tmpVec3.z * wobble;
        const fade = Math.sin(t * Math.PI);
        const trailFade = 1 - tr / TRAIL_LEN; // head=1, tail=0
        colArr[idx3] = p.color.r;
        colArr[idx3 + 1] = p.color.g;
        colArr[idx3 + 2] = p.color.b;
        sizeArr[count] = (tr === 0 ? 8.0 : 5.0 * trailFade) * p.size;
        opaArr[count] = (0.7 + fade * 0.3) * trailFade;
        count++;
      }
    }
    pGeo.setDrawRange(0, count);
    if (count > 0) {
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.customColor.needsUpdate = true;
      pGeo.attributes.size.needsUpdate = true;
      pGeo.attributes.opacity.needsUpdate = true;
    }
  }

  // ===== Topology 2D→3D Mapping =====
  const TOPO_REF_W = 800, TOPO_REF_H = 500;
  const TOPO_SCALE = 0.1;

  function topoTo3D(x, y) {
    return new THREE.Vector3(
      (x - TOPO_REF_W / 2) * TOPO_SCALE,
      0,
      (y - TOPO_REF_H / 2) * TOPO_SCALE
    );
  }

  function setTopology(topo) {
    topology = topo;
    // Clean up old infra nodes and topo lines
    for (const k of Object.keys(infraNodes)) removeInfraNode(k);
    for (const k of Object.keys(topoLines)) removeTopoLine(k);
  }

  const INFRA_COLORS = {
    hub_center: 0x00bcd4,
    router: 0xe67e22,
    switch: 0x4caf50,
    pc: 0x3498db,
    server: 0x9b59b6
  };

  function buildInfraNodes() {
    if (!topology || !topology.devices) return;
    for (const dev of topology.devices) {
      if (dev.type === 'hub_center') continue; // Hub is already built
      if (dev.target_index !== undefined && dev.target_index !== null) continue; // Target devices handled by createTarget
      createInfraNode(dev);
    }
  }

  function createInfraNode(dev) {
    if (infraNodes[dev.id]) return;
    const pos = topoTo3D(dev.x, dev.y);
    const color = INFRA_COLORS[dev.type] || 0x607d8b;

    const g = new THREE.Group();
    g.position.copy(pos);

    const sphereGeo = new THREE.SphereGeometry(1.0, 16, 16);
    const sphereMat = new THREE.MeshPhongMaterial({
      color, emissive: color, emissiveIntensity: 0.5,
      shininess: 80, transparent: true, opacity: 0.9
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    g.add(sphere);

    const glowGeo = new THREE.SphereGeometry(1.6, 10, 10);
    const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
    g.add(new THREE.Mesh(glowGeo, glowMat));

    scene.add(g);
    const label = makeLabel(dev.name || dev.type, '#' + new THREE.Color(color).getHexString(), 'v3d-label name');
    const ipLabel = dev.ip ? makeLabel(dev.ip, '#556', 'v3d-label ip') : null;

    infraNodes[dev.id] = {
      group: g, label, ipLabel, pos,
      _geo: [sphereGeo, glowGeo],
      _mat: [sphereMat, glowMat]
    };
  }

  function removeInfraNode(id) {
    const n = infraNodes[id];
    if (!n) return;
    scene.remove(n.group);
    if (n.label) n.label.remove();
    if (n.ipLabel) n.ipLabel.remove();
    if (n._geo) n._geo.forEach(g => g && g.dispose());
    if (n._mat) n._mat.forEach(m => m && m.dispose());
    delete infraNodes[id];
  }

  function buildTopoLines() {
    if (!topology || !topology.connections) return;
    for (const conn of topology.connections) {
      const key = conn.from + '>' + conn.to;
      if (topoLines[key]) continue;
      const p1 = resolveTopoPos(conn.from);
      const p2 = resolveTopoPos(conn.to);
      if (!p1 || !p2) continue;

      const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const mat = new THREE.LineBasicMaterial({
        color: 0x2a5a6a, transparent: true, opacity: 0.5
      });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      topoLines[key] = { line, _geo: geo, _mat: mat };
    }
  }

  function removeTopoLine(key) {
    const tl = topoLines[key];
    if (!tl) return;
    scene.remove(tl.line);
    if (tl._geo) tl._geo.dispose();
    if (tl._mat) tl._mat.dispose();
    delete topoLines[key];
  }

  function resolveTopoPos(devId) {
    if (devId === 'dev_hub') return _hubPos;
    if (infraNodes[devId]) return infraNodes[devId].pos;
    // Check if it's a target device or hub_center by type
    if (topology && topology.devices) {
      const dev = topology.devices.find(d => d.id === devId);
      if (dev && dev.type === 'hub_center') return _hubPos;
      if (dev && dev.target_index !== undefined && dev.target_index !== null) {
        const n = tgtNodes[dev.target_index];
        if (n) return n.pos;
      }
      // Fallback: convert from 2D coords
      if (dev) return topoTo3D(dev.x, dev.y);
    }
    return null;
  }

  // ===== Target Nodes =====
  function setTargets(tList, iMap) {
    targets = tList;
    ipMap = iMap;
    // Remove old
    for (const k of Object.keys(tgtNodes)) removeTarget(k);
    // Remove old infra nodes and topo lines (will rebuild)
    for (const k of Object.keys(infraNodes)) removeInfraNode(k);
    for (const k of Object.keys(topoLines)) removeTopoLine(k);

    // Create new target nodes
    const activeList = [];
    tList.forEach((t, i) => { if (t.name && t.address) activeList.push({ ...t, idx: i }); });

    if (topology && topology.devices && topology.devices.length > 0) {
      // Use topology positions for target nodes
      const topoDevMap = {};
      for (const dev of topology.devices) {
        if (dev.target_index !== undefined && dev.target_index !== null) {
          topoDevMap[dev.target_index] = dev;
        }
      }
      // Pre-compute fallback positions for targets without topology mapping
      const fallbackPositions = fibonacci3D(activeList.length, TGT_R);
      activeList.forEach((t, i) => {
        const topoDev = topoDevMap[t.idx];
        const pos = topoDev ? topoTo3D(topoDev.x, topoDev.y) : fallbackPositions[i];
        createTarget(t.idx, t, pos, !!topology);
      });
      // Build infrastructure nodes and topology connection lines
      buildInfraNodes();
      buildTopoLines();
    } else {
      // Default fibonacci layout
      const positions = fibonacci3D(activeList.length, TGT_R);
      activeList.forEach((t, i) => createTarget(t.idx, t, positions[i], false));
    }

    // Show/hide empty state
    if (emptyStateEl) {
      emptyStateEl.style.display = activeList.length === 0 ? '' : 'none';
    }
  }

  function fibonacci3D(count, radius) {
    const pts = [];
    if (count === 0) return pts;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / Math.max(count - 1, 1)) * 2;
      const rAtY = Math.sqrt(1 - y * y);
      const theta = golden * i;
      pts.push(new THREE.Vector3(
        Math.cos(theta) * rAtY * radius,
        y * radius * 0.35,
        Math.sin(theta) * rAtY * radius
      ));
    }
    return pts;
  }

  function createTarget(idx, t, pos, skipHubLine) {
    const g = new THREE.Group();
    g.position.copy(pos);
    const c = t.enabled ? C_IDLE : C_DISABLED;

    // Main sphere
    const sphereGeo = new THREE.SphereGeometry(1.2, 20, 20);
    const sphereMat = new THREE.MeshPhongMaterial({
      color: c, emissive: c, emissiveIntensity: 0.5, shininess: 80,
      transparent: true, opacity: t.enabled ? 0.95 : 0.4
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    g.add(sphere);

    // Glow sphere
    const glowGeo = new THREE.SphereGeometry(2.2, 12, 12);
    const glowMat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: t.enabled ? 0.15 : 0.03, blending: THREE.AdditiveBlending, depthWrite: false });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    g.add(glow);

    // Orbital ring for each node
    const ringGeo = new THREE.TorusGeometry(2.0, 0.02, 8, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: t.enabled ? C_IDLE : C_DISABLED, transparent: true,
      opacity: t.enabled ? 0.35 : 0.05,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2 + (Math.random() - 0.5) * 0.4;
    ring.rotation.y = Math.random() * Math.PI;
    g.add(ring);

    // Warning ring (for fail state, initially invisible)
    const warnGeo = new THREE.TorusGeometry(2.5, 0.05, 8, 32);
    const warnMat = new THREE.MeshBasicMaterial({
      color: C_FAIL, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    const warnRing = new THREE.Mesh(warnGeo, warnMat);
    warnRing.rotation.x = Math.PI / 2;
    g.add(warnRing);

    // Connection line to hub (skip when topology provides its own lines)
    let line = null, lMat = null, lGeo = null;
    if (!skipHubLine) {
      lGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pos]);
      lMat = new THREE.LineBasicMaterial({
        color: t.enabled ? 0x2a5a6a : C_DISABLED,
        transparent: true, opacity: t.enabled ? 0.45 : 0.12
      });
      line = new THREE.Line(lGeo, lMat);
      scene.add(line);
    }

    // Labels
    const labels = {
      name: makeLabel(t.name, t.enabled ? '#e0e8f0' : '#555', 'v3d-label name'),
      ip: makeLabel(t.address, '#7899aa', 'v3d-label ip'),
      status: makeLabel('', '#aaa', 'v3d-label status'),
      bw: null
    };

    scene.add(g);
    tgtNodes[idx] = {
      group: g, sphere, glow, ring, warnRing, line, lMat, labels, pos,
      status: t.enabled ? 'idle' : 'disabled',
      _geo: [sphereGeo, glowGeo, ringGeo, warnGeo, lGeo].filter(Boolean),
      _mat: [sphereMat, glowMat, ringMat, warnMat, lMat].filter(Boolean)
    };
  }

  function removeTarget(idx) {
    const n = tgtNodes[idx];
    if (!n) return;
    scene.remove(n.group);
    if (n.line) scene.remove(n.line);
    // Dispose geometry and materials
    if (n._geo) n._geo.forEach(g => g && g.dispose());
    if (n._mat) n._mat.forEach(m => m && m.dispose());
    Object.values(n.labels).forEach(l => l && l.remove());
    delete tgtNodes[idx];
  }

  function updateNodeStatus(idx, status, timestamp) {
    const n = tgtNodes[idx];
    if (!n) return;
    n.status = status === '장애' ? 'fail' : 'ok';
    const c = n.status === 'fail' ? C_FAIL : C_OK;
    n.sphere.material.color.setHex(c);
    n.sphere.material.emissive.setHex(c);
    n.sphere.material.emissiveIntensity = n.status === 'fail' ? 0.8 : 0.5;
    n.glow.material.color.setHex(c);
    n.glow.material.opacity = n.status === 'fail' ? 0.3 : 0.15;
    if (n.lMat) {
      n.lMat.color.setHex(n.status === 'fail' ? 0xff3355 : 0x00cc88);
      n.lMat.opacity = 0.7;
    }
    // Orbital ring color follows status
    n.ring.material.color.setHex(c);
    n.ring.material.opacity = n.status === 'fail' ? 0.5 : 0.35;
    if (n.labels.status) {
      n.labels.status.textContent = status;
      n.labels.status.style.color = n.status === 'fail' ? '#ff4466' : '#00ff88';
    }
    // Update topology connection lines to reflect failure/ok status
    if (topology && topology.devices && topology.connections) {
      const dev = topology.devices.find(d => d.target_index === idx);
      if (dev) {
        for (const conn of topology.connections) {
          if (conn.from === dev.id || conn.to === dev.id) {
            const key = conn.from + '>' + conn.to;
            if (topoLines[key]) {
              topoLines[key]._mat.color.setHex(n.status === 'fail' ? 0xff3355 : 0x2a5a6a);
              topoLines[key]._mat.opacity = n.status === 'fail' ? 0.8 : 0.5;
            }
          }
        }
      }
    }
  }

  // ===== Discovered Nodes =====
  function handleDiscoveredNodes(nodes) {
    if (!active) return;
    hasRealData = true;
    const now = Date.now();
    const seen = new Set();

    for (const d of nodes) {
      seen.add(d.ip);
      // Skip low-traffic noise (< 2KB total)
      if (d.totalBytes < 2048 && !discNodes[d.ip]) continue;
      if (discNodes[d.ip]) {
        discNodes[d.ip].lastSeen = now;
      }
      const pos = getDiscPos(d);
      ensureDiscNode(d.ip, pos, d.totalBytes);

      // Emit particles for connections
      for (const [peer, conn] of Object.entries(d.connections)) {
        const fromPos = pos;
        const toPos = resolvePos(peer);
        if (!toPos) continue;
        const mainP = Object.keys(conn.protocols || {}).sort((a, b) => (conn.protocols[b] || 0) - (conn.protocols[a] || 0))[0] || 'other';
        const col = PROTO_C[mainP] || PROTO_C.other;
        const intensity = Math.min(conn.bytes / 20000, 1);
        const cnt = Math.ceil(1 + intensity * 2);
        for (let j = 0; j < Math.min(cnt, 3); j++) {
          emitParticle(fromPos, toPos, col, 0.3 + intensity * 0.4 + Math.random() * 0.2, j * 300 + Math.random() * 100);
        }
        ensureDiscLine(d.ip, peer, fromPos, toPos);
      }
    }

    // Fade out old nodes (1 hour timeout)
    for (const [ip, dn] of Object.entries(discNodes)) {
      if (now - dn.lastSeen > 3600000) {
        removeDiscNode(ip);
      }
    }
  }

  function getDiscPos(d) {
    if (discPosCache[d.ip]) return discPosCache[d.ip];
    // Find primary peer (prefer targets)
    let bestPeer = null, bestScore = 0;
    for (const [p, c] of Object.entries(d.connections)) {
      const isT = ipMap[p] !== undefined;
      const score = (isT ? 2 : 1) * (c.bytes || 1);
      if (score > bestScore) { bestScore = score; bestPeer = p; }
    }
    const anchor = bestPeer ? resolvePos(bestPeer) : null;
    const hash = hashIp(d.ip);
    let pos;
    if (anchor && anchor.lengthSq() > 0.01) {
      // Anchor is a real node position — spread outward from it
      const dir = anchor.clone().normalize();
      const spreadAngle = ((hash % 60) - 30) * Math.PI / 180;
      const cos = Math.cos(spreadAngle), sin = Math.sin(spreadAngle);
      const dx = dir.x * cos - dir.z * sin;
      const dz = dir.x * sin + dir.z * cos;
      const push = 10 + (hash % 6);
      pos = new THREE.Vector3(
        anchor.x + dx * push,
        anchor.y + (hash % 5 - 2) * 1.5,
        anchor.z + dz * push
      );
    } else {
      // Anchor is hub center (0,0,0) or no anchor — radial spread around hub
      const a = (hash % 360) * Math.PI / 180;
      const r = DISC_R + (hash % 10) - 5;
      pos = new THREE.Vector3(Math.cos(a) * r, (hash % 7 - 3) * 2, Math.sin(a) * r);
    }
    // Simple collision avoidance: push away from existing cached positions
    for (const [otherIp, otherPos] of Object.entries(discPosCache)) {
      const dx = pos.x - otherPos.x;
      const dz = pos.z - otherPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 5 && dist > 0) {
        const push = (5 - dist) / dist;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }
    discPosCache[d.ip] = pos;
    return pos;
  }

  function ensureDiscNode(ip, pos, totalBytes) {
    if (discNodes[ip]) {
      // Update bandwidth label
      const dn = discNodes[ip];
      if (dn.label && totalBytes > 0) {
        dn.label.textContent = ip + ' ' + fmtBW(totalBytes);
      }
      return;
    }
    const g = new THREE.Group();
    g.position.copy(pos);
    const sphereGeo = new THREE.SphereGeometry(0.7, 12, 12);
    const sphereMat = new THREE.MeshPhongMaterial({
      color: C_DISC, emissive: C_DISC, emissiveIntensity: 0.45, transparent: true, opacity: 0.8
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    g.add(sphere);
    const glowGeo = new THREE.SphereGeometry(1.2, 8, 8);
    const glowMat = new THREE.MeshBasicMaterial({ color: C_DISC, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false });
    g.add(new THREE.Mesh(glowGeo, glowMat));
    scene.add(g);
    const label = makeLabel(ip, '#ffab40', 'v3d-label disc');
    discNodes[ip] = {
      group: g, sphere, label, pos, lastSeen: Date.now(), lines: {},
      _geo: [sphereGeo, glowGeo], _mat: [sphereMat, glowMat]
    };
  }

  function removeDiscNode(ip) {
    const dn = discNodes[ip];
    if (!dn) return;
    scene.remove(dn.group);
    if (dn.label) dn.label.remove();
    for (const l of Object.values(dn.lines)) {
      scene.remove(l);
      if (l.geometry) l.geometry.dispose();
      if (l.material) l.material.dispose();
    }
    if (dn._geo) dn._geo.forEach(g => g && g.dispose());
    if (dn._mat) dn._mat.forEach(m => m && m.dispose());
    delete discNodes[ip];
    // Keep discPosCache[ip] for stability
  }

  function ensureDiscLine(ip, peer, fromPos, toPos) {
    const dn = discNodes[ip];
    if (!dn || dn.lines[peer]) return;
    const geo = new THREE.BufferGeometry().setFromPoints([fromPos, toPos]);
    const mat = new THREE.LineDashedMaterial({
      color: 0x996600, transparent: true, opacity: 0.35,
      dashSize: 1, gapSize: 0.5
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    scene.add(line);
    dn.lines[peer] = line;
  }

  // ===== Inter-Node Lines =====
  function handleInterNodeStats(flows) {
    if (!active) return;
    hasRealData = true;
    const seen = new Set();
    for (const f of flows) {
      const key = f.src + '>' + f.dst;
      seen.add(key);
      const p1 = resolvePos(f.src);
      const p2 = resolvePos(f.dst);
      if (!p1 || !p2) continue;

      if (!interLines[key]) {
        const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
        const mat = new THREE.LineDashedMaterial({
          color: 0xffab40, transparent: true, opacity: 0.55,
          dashSize: 1.5, gapSize: 0.8
        });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        scene.add(line);
        interLines[key] = line;
      }

      // Particles
      const mainP = Object.keys(f.protocols || {}).sort((a, b) => (f.protocols[b] || 0) - (f.protocols[a] || 0))[0] || 'other';
      const col = PROTO_C[mainP] || PROTO_C.other;
      const intensity = Math.min(f.bytes / 30000, 1);
      const cnt = Math.ceil(1 + intensity * 3);
      for (let j = 0; j < Math.min(cnt, 4); j++) {
        emitParticle(p1, p2, col, 0.3 + intensity * 0.5 + Math.random() * 0.2, j * 250 + Math.random() * 80);
      }
    }
    // Remove stale — with proper disposal
    for (const k of Object.keys(interLines)) {
      if (!seen.has(k)) {
        const line = interLines[k];
        scene.remove(line);
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
        delete interLines[k];
      }
    }
  }

  // ===== ASTERIX Flows =====
  function handleAsterixFlows(flows) {
    if (!active) return;
    hasRealData = true;
    const now = Date.now();
    const seen = new Set();

    for (const f of flows) {
      const key = f.src + '>' + f.dst;
      seen.add(key);
      asterixLastSeen[key] = now;

      const p1 = resolvePos(f.src);
      const p2 = resolvePos(f.dst);
      if (!p1 || !p2) continue;

      // Primary CAT
      const primaryCat = Object.keys(f.cats).sort((a, b) => (f.cats[b].bytes || 0) - (f.cats[a].bytes || 0))[0];
      const catNum = primaryCat ? parseInt(primaryCat) : 0;
      const catColor = AST_C[catNum] || AST_C._default;

      if (!asterixObjs[key]) {
        const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
        const mat = new THREE.LineBasicMaterial({ color: catColor, transparent: true, opacity: 0.7, linewidth: 2 });
        const line = new THREE.Line(geo, mat);
        scene.add(line);
        const catNames = Object.keys(f.cats).map(c => AST_NAMES[parseInt(c)] || ('CAT' + c));
        const label = makeLabel(catNames.join(' '), '#' + new THREE.Color(catColor).getHexString(), 'v3d-label asterix');
        asterixObjs[key] = { line, label, color: catColor };
      } else {
        asterixObjs[key].line.material.color.setHex(catColor);
      }

      // Particles
      const intensity = Math.min(f.totalBytes / 20000, 1);
      for (const [catStr, catData] of Object.entries(f.cats)) {
        const cc = new THREE.Color(AST_C[parseInt(catStr)] || AST_C._default);
        const share = catData.bytes / (f.totalBytes || 1);
        const cnt = Math.ceil((1 + intensity * 4) * share);
        for (let j = 0; j < Math.min(cnt, 5); j++) {
          emitParticle(p1, p2, cc, 0.35 + intensity * 0.5 + Math.random() * 0.2, j * 200 + Math.random() * 80, 1.3);
        }
      }
    }

    // Remove stale — with proper disposal
    for (const [k, t] of Object.entries(asterixLastSeen)) {
      if (now - t > 12000) {
        if (asterixObjs[k]) {
          const obj = asterixObjs[k];
          scene.remove(obj.line);
          if (obj.line.geometry) obj.line.geometry.dispose();
          if (obj.line.material) obj.line.material.dispose();
          if (obj.label) obj.label.remove();
          delete asterixObjs[k];
        }
        delete asterixLastSeen[k];
      }
    }
  }

  // ===== Traffic Stats =====
  function handleTrafficStats(stats) {
    if (!active) return;
    hasRealData = true;
    for (const [ip, data] of Object.entries(stats)) {
      const idx = ipMap[ip];
      if (idx === undefined) continue;
      const n = tgtNodes[idx];
      if (!n) continue;

      // Line glow
      const total = data.bytesIn + data.bytesOut;
      const intensity = Math.min(total / 50000, 1);
      if (n.lMat) n.lMat.opacity = 0.3 + intensity * 0.5;

      // Particles per protocol
      for (const [proto, count] of Object.entries(data.protocols || {})) {
        const col = PROTO_C[proto] || PROTO_C.other;
        const pIntensity = Math.min(total / 50000, 1);
        // Inbound
        const inCount = Math.ceil((1 + pIntensity * 3) * (data.packetsIn / Math.max(data.packetsIn + data.packetsOut, 1)));
        for (let j = 0; j < Math.min(inCount, 4); j++) {
          emitParticle(n.pos, _hubPos, col, 0.3 + pIntensity * 0.5 + Math.random() * 0.2, j * 250 + Math.random() * 100);
        }
        // Outbound
        const outCount = Math.ceil((1 + pIntensity * 3) * (data.packetsOut / Math.max(data.packetsIn + data.packetsOut, 1)));
        for (let j = 0; j < Math.min(outCount, 4); j++) {
          emitParticle(_hubPos, n.pos, col, 0.25 + pIntensity * 0.4 + Math.random() * 0.2, j * 250 + Math.random() * 100);
        }
      }
    }
  }

  // ===== Ping Particles =====
  function emitPingParticles(data) {
    if (!active) return;
    const idx = data.index;
    const n = tgtNodes[idx];
    if (!n) return;
    const ok = data.status !== '장애';
    const col = new THREE.Color(ok ? 0x2ecc71 : 0xe74c3c);
    const cnt = ok ? 2 : 4;
    for (let i = 0; i < cnt; i++) {
      emitParticle(n.pos, _hubPos, col, 0.4 + Math.random() * 0.3, i * 100);
    }
  }

  // ===== Ambient Flow =====
  const _ambientOrigin = new THREE.Vector3();
  const _ambientColor = new THREE.Color(0x00b0ff).multiplyScalar(0.6);

  function startAmbientFlow() {
    stopAmbientFlow();
    ambientTimer = setInterval(() => {
      if (!active || hasRealData) return;
      for (const [idx, n] of Object.entries(tgtNodes)) {
        if (n.status === 'disabled') continue;
        if (Math.random() < 0.3) {
          emitParticle(_ambientOrigin, n.pos, _ambientColor, 0.2 + Math.random() * 0.2, Math.random() * 300);
        }
      }
    }, 800);
  }

  function stopAmbientFlow() {
    if (ambientTimer) { clearInterval(ambientTimer); ambientTimer = null; }
    particles.length = 0;
    if (pGeo) pGeo.setDrawRange(0, 0);
    hasRealData = false;
  }

  // ===== Resolve Position =====
  function resolvePos(ip) {
    // Local IP = hub center
    if (localIp && ip === localIp) return _hubPos;
    const idx = ipMap[ip];
    if (idx !== undefined && tgtNodes[idx]) return tgtNodes[idx].pos;
    if (discPosCache[ip]) return discPosCache[ip];
    if (discNodes[ip]) return discNodes[ip].pos;
    // Generate and cache a position
    const hash = hashIp(ip);
    const a = (hash % 360) * Math.PI / 180;
    const pos = new THREE.Vector3(Math.cos(a) * DISC_R, (hash % 7 - 3) * 2, Math.sin(a) * DISC_R);
    discPosCache[ip] = pos;
    return pos;
  }

  // ===== Labels =====
  function makeLabel(text, color, cls) {
    const el = document.createElement('div');
    el.className = cls || 'v3d-label';
    el.textContent = text;
    if (color) el.style.color = color;
    if (labelOverlay) labelOverlay.appendChild(el);
    return el;
  }

  function updateLabels() {
    if (!container) return;
    // Hub
    if (hubGroup && hubGroup.userData.label) {
      projectLabel(new THREE.Vector3(0, 0, 0), hubGroup.userData.label, 0, -28);
    }
    // Targets
    for (const n of Object.values(tgtNodes)) {
      const sp = toScreen(n.pos);
      if (!sp) continue;
      const vis = sp.z > 0 && sp.z < 1;
      const dist = camera.position.distanceTo(n.pos);
      const depthFade = Math.max(0.2, Math.min(1, 1 - (dist - 35) / 65));
      setLabelPos(n.labels.name, sp.x, sp.y - 20, vis, depthFade);
      setLabelPos(n.labels.ip, sp.x, sp.y - 8, vis, depthFade * 0.7);
      setLabelPos(n.labels.status, sp.x, sp.y + 6, vis, depthFade);
    }
    // Discovered
    for (const dn of Object.values(discNodes)) {
      const sp = toScreen(dn.pos);
      if (!sp) continue;
      const vis = sp.z > 0 && sp.z < 1;
      const dist = camera.position.distanceTo(dn.pos);
      const depthFade = Math.max(0.15, Math.min(0.9, 1 - (dist - 40) / 60));
      setLabelPos(dn.label, sp.x, sp.y - 14, vis, depthFade);
    }
    // Infrastructure nodes (topology)
    for (const inf of Object.values(infraNodes)) {
      const sp = toScreen(inf.pos);
      if (!sp) continue;
      const vis = sp.z > 0 && sp.z < 1;
      const dist = camera.position.distanceTo(inf.pos);
      const depthFade = Math.max(0.2, Math.min(1, 1 - (dist - 35) / 65));
      setLabelPos(inf.label, sp.x, sp.y - 20, vis, depthFade);
      if (inf.ipLabel) setLabelPos(inf.ipLabel, sp.x, sp.y - 8, vis, depthFade * 0.7);
    }
    // ASTERIX labels at midpoint
    for (const [key, obj] of Object.entries(asterixObjs)) {
      if (!obj.label) continue;
      const parts = key.split('>');
      const p1 = resolvePos(parts[0]);
      const p2 = resolvePos(parts[1]);
      if (p1 && p2) {
        _tmpVec.copy(p1).add(p2).multiplyScalar(0.5);
        _tmpVec.y += 1.5;
        const sp = toScreen(_tmpVec);
        if (sp) {
          const dist = camera.position.distanceTo(_tmpVec);
          const depthFade = Math.max(0.2, Math.min(1, 1 - (dist - 35) / 65));
          setLabelPos(obj.label, sp.x, sp.y, sp.z > 0 && sp.z < 1, depthFade);
        }
      }
    }
  }

  function toScreen(pos) {
    if (!camera || !container) return null;
    _screenVec.copy(pos).project(camera);
    return {
      x: (_screenVec.x * 0.5 + 0.5) * container.clientWidth,
      y: (-_screenVec.y * 0.5 + 0.5) * container.clientHeight,
      z: _screenVec.z
    };
  }

  function setLabelPos(el, x, y, visible, opacity) {
    if (!el) return;
    el.style.transform = 'translate(-50%,-50%) translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    el.style.display = visible ? '' : 'none';
    if (opacity !== undefined) el.style.opacity = opacity;
  }

  function projectLabel(pos, el, ox, oy) {
    const sp = toScreen(pos);
    if (sp && el) setLabelPos(el, sp.x + (ox || 0), sp.y + (oy || 0), sp.z > 0 && sp.z < 1);
  }

  // ===== Animation =====
  function animate() {
    if (!active) return;
    animId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.getElapsedTime();
    const now = Date.now();

    controls.update(dt);

    // Hub animations
    if (hubGroup) {
      const r1 = hubGroup.userData.ring1;
      const r2 = hubGroup.userData.ring2;
      const r3 = hubGroup.userData.ring3;
      const field = hubGroup.userData.field;
      if (r1) r1.rotation.z += 0.5 * dt;
      if (r2) { r2.rotation.z -= 0.3 * dt; r2.rotation.x += 0.08 * dt; }
      if (r3) { r3.rotation.z += 0.15 * dt; r3.rotation.y -= 0.1 * dt; }
      if (field) {
        field.rotation.y += 0.2 * dt;
        field.rotation.x += 0.05 * dt;
        field.material.opacity = 0.05 + 0.04 * Math.sin(elapsed * 1.5);
      }
    }

    // Target node animations
    for (const n of Object.values(tgtNodes)) {
      // Orbital ring rotation
      if (n.ring) n.ring.rotation.z += 0.4 * dt;

      if (n.status === 'fail') {
        // Fail pulse — glow
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4);
        n.glow.material.opacity = 0.15 + pulse * 0.35;
        n.glow.scale.setScalar(1 + pulse * 0.4);
        // Warning ring pulse
        if (n.warnRing) {
          const wp = 0.5 + 0.5 * Math.sin(elapsed * 3);
          n.warnRing.material.opacity = 0.25 + wp * 0.35;
          n.warnRing.scale.setScalar(1 + wp * 0.2);
          n.warnRing.rotation.z += 1.5 * dt;
        }
        // Sphere throb
        const throb = 1 + 0.08 * Math.sin(elapsed * 6);
        n.sphere.scale.setScalar(throb);
      } else {
        // Reset warning ring when OK
        if (n.warnRing) n.warnRing.material.opacity = 0;
        n.sphere.scale.setScalar(1);
      }
    }

    // Discovered node fade
    for (const dn of Object.values(discNodes)) {
      const age = now - dn.lastSeen;
      const fadeOpacity = age > 3300000 ? Math.max(0, 1 - (age - 3300000) / 300000) : 1;
      dn.sphere.material.opacity = 0.7 * fadeOpacity;
    }

    tickParticles(dt);
    updateLabels();
    webgl.render(scene, camera);
  }

  function onResize() {
    if (!container || !camera || !webgl) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    webgl.setSize(w, h);
  }

  // ===== Dispose =====
  function dispose() {
    active = false;
    topology = null;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    stopAmbientFlow();

    // Clean up Three.js objects
    for (const k of Object.keys(tgtNodes)) removeTarget(k);
    for (const ip of Object.keys(discNodes)) removeDiscNode(ip);
    for (const k of Object.keys(infraNodes)) removeInfraNode(k);
    for (const k of Object.keys(topoLines)) removeTopoLine(k);
    for (const k of Object.keys(interLines)) {
      const line = interLines[k];
      scene.remove(line);
      if (line.geometry) line.geometry.dispose();
      if (line.material) line.material.dispose();
      delete interLines[k];
    }
    for (const k of Object.keys(asterixObjs)) {
      const obj = asterixObjs[k];
      scene.remove(obj.line);
      if (obj.line.geometry) obj.line.geometry.dispose();
      if (obj.line.material) obj.line.material.dispose();
      if (obj.label) obj.label.remove();
      delete asterixObjs[k];
    }
    asterixLastSeen = {};

    particles.length = 0;
    if (pPts && scene) scene.remove(pPts);
    if (pGeo) { pGeo.dispose(); pGeo = null; }
    if (pMat) { pMat.dispose(); pMat = null; }
    pPts = null;

    // Dispose scene-level objects (grid, hub, stars, lights)
    for (const item of sceneObjects) {
      if (item.geo) item.geo.dispose();
      if (item.mat) item.mat.dispose();
      if (item.obj && scene) scene.remove(item.obj);
    }
    sceneObjects = [];

    // Dispose OrbitControls event listeners
    if (controls) controls.dispose();

    // Disconnect ResizeObserver
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }

    if (webgl) { webgl.dispose(); }
    if (container) container.innerHTML = '';
    scene = null; camera = null; webgl = null; controls = null;
    hubGroup = null; labelOverlay = null; emptyStateEl = null;
  }

  // ===== Utility =====
  function hashIp(ip) {
    let h = 0;
    for (let i = 0; i < ip.length; i++) h = ((h << 5) - h + ip.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function fmtBW(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + 'G';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + 'M';
    if (b >= 1024) return (b / 1024).toFixed(1) + 'K';
    return b + 'B';
  }

  // ===== Export =====
  window.view3d = {
    init, dispose, setTargets, setTopology, updateNodeStatus,
    handleTrafficStats, handleInterNodeStats,
    handleDiscoveredNodes, handleAsterixFlows,
    emitPingParticles, startAmbientFlow, stopAmbientFlow,
    setIpMap: function (m) { ipMap = m; },
    setLocalIp: function (ip) { localIp = ip; },
    isActive: function () { return active; }
  };
})();
