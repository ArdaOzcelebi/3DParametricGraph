(function () {
  const canvas = document.getElementById('graph-canvas');
  const graphList = document.getElementById('graph-list');
  const addButton = document.getElementById('add-graph');
  const resetCameraButton = document.getElementById('reset-camera');

  const ctx = canvas.getContext('2d');
  const camera = {
    yaw: -0.7,
    pitch: -0.5,
    distance: 16,
    target: { x: 0, y: 0, z: 0 }
  };

  const renderState = {
    width: 1,
    height: 1,
    scale: 760
  };

  const runtimeGraphs = [];
  let graphIdCounter = 0;
  const POINT_SIZE_SCALE = 12;
  const MIN_DEPTH_FOR_POINT_SCALING = 6;
  const MIN_SOLID_RESOLUTION = 8;
  const MAX_SOLID_RESOLUTION = 42;
  const MAX_DEVICE_PIXEL_RATIO = 2;

  const SAFE_SCOPE = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sqrt: Math.sqrt,
    pow: Math.pow,
    abs: Math.abs,
    log: Math.log,
    exp: Math.exp,
    min: Math.min,
    max: Math.max,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    pi: Math.PI,
    e: Math.E
  };
  const SAFE_KEYS = Object.keys(SAFE_SCOPE);
  const SAFE_VALUES = SAFE_KEYS.map((k) => SAFE_SCOPE[k]);
  const IDENTIFIER_RE = /[A-Za-z_]\w*/g;
  const DISALLOWED_CHARS_RE = /[^0-9A-Za-z_+\-*/%^().,<>=!&| \t]/;

  function createDefaultGraph() {
    graphIdCounter += 1;
    return {
      id: `graph-${graphIdCounter}`,
      type: 'curve',
      color: '#37b3ff',
      xExpr: 'cos(t)',
      yExpr: 'sin(t)',
      zExpr: 't/6',
      tMin: '0',
      tMax: '12*pi',
      uMin: '0',
      uMax: '3',
      vMin: '0',
      vMax: '2*pi',
      solidExpr: 'x^2 + y^2 + z^2 - 4 <= 0',
      boundsMin: '-2.5',
      boundsMax: '2.5',
      resolution: '20',
      drawable: null,
      status: ''
    };
  }

  function normalizeExponentSyntax(expression) {
    return String(expression || '0').replace(/\^/g, '**');
  }

  function validateExpressionSource(src, variables) {
    if (DISALLOWED_CHARS_RE.test(src)) {
      throw new Error('Expression contains unsupported characters.');
    }

    const allowedNames = new Set([...SAFE_KEYS, ...variables, 'true', 'false']);
    const identifiers = src.match(IDENTIFIER_RE) || [];
    for (const id of identifiers) {
      if (!allowedNames.has(id)) {
        throw new Error(`Unsupported token in expression: ${id}`);
      }
    }
  }

  function compile(expression, variables) {
    const src = normalizeExponentSyntax(expression);
    validateExpressionSource(src, variables);
    return new Function(...SAFE_KEYS, ...variables, `'use strict'; return (${src});`);
  }

  function evaluateCompiled(fn, scope) {
    const values = Object.values(scope);
    return fn(...SAFE_VALUES, ...values);
  }

  function parseNumber(raw) {
    const fn = compile(String(raw || '0'), []);
    const value = Number(evaluateCompiled(fn, {}));
    if (!Number.isFinite(value)) {
      throw new Error('Expected a finite number.');
    }
    return value;
  }

  function finiteNumber(v) {
    const num = Number(v);
    if (!Number.isFinite(num)) {
      throw new Error('Expression produced a non-finite value.');
    }
    return num;
  }

  function rotatePoint(point) {
    const dx = point.x - camera.target.x;
    const dy = point.y - camera.target.y;
    const dz = point.z - camera.target.z;

    const cy = Math.cos(camera.yaw);
    const sy = Math.sin(camera.yaw);
    const cp = Math.cos(camera.pitch);
    const sp = Math.sin(camera.pitch);

    const x1 = cy * dx - sy * dz;
    const z1 = sy * dx + cy * dz;
    const y2 = cp * dy - sp * z1;
    const z2 = sp * dy + cp * z1;

    return { x: x1, y: y2, z: z2 };
  }

  function project(point) {
    const p = rotatePoint(point);
    const depth = p.z + camera.distance;
    if (depth <= 0.2) {
      return null;
    }
    const s = renderState.scale / depth;
    return {
      x: renderState.width * 0.5 + p.x * s,
      y: renderState.height * 0.5 - p.y * s,
      depth
    };
  }

  function colorToRGBA(hex, alpha) {
    const value = String(hex || '#ffffff').replace(/#/g, '');
    const expanded = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
      return `rgba(255, 255, 255, ${alpha})`;
    }
    const n = parseInt(expanded, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function createCurveDrawable(graph) {
    const xExpr = compile(graph.xExpr, ['t']);
    const yExpr = compile(graph.yExpr, ['t']);
    const zExpr = compile(graph.zExpr, ['t']);
    const tMin = parseNumber(graph.tMin);
    const tMax = parseNumber(graph.tMax);
    if (!(tMax > tMin)) {
      throw new Error('t max must be greater than t min.');
    }

    const steps = 500;
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = tMin + ((tMax - tMin) * i) / steps;
      points.push({
        x: finiteNumber(evaluateCompiled(xExpr, { t })),
        y: finiteNumber(evaluateCompiled(yExpr, { t })),
        z: finiteNumber(evaluateCompiled(zExpr, { t }))
      });
    }

    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      segments.push([points[i - 1], points[i]]);
    }

    return { kind: 'segments', color: graph.color, lineWidth: 2, segments };
  }

  function createSurfaceDrawable(graph) {
    const xExpr = compile(graph.xExpr, ['u', 'v']);
    const yExpr = compile(graph.yExpr, ['u', 'v']);
    const zExpr = compile(graph.zExpr, ['u', 'v']);
    const uMin = parseNumber(graph.uMin);
    const uMax = parseNumber(graph.uMax);
    const vMin = parseNumber(graph.vMin);
    const vMax = parseNumber(graph.vMax);

    if (!(uMax > uMin && vMax > vMin)) {
      throw new Error('u/v max must be greater than min.');
    }

    const uSegments = 40;
    const vSegments = 40;
    const rows = [];

    for (let i = 0; i <= uSegments; i += 1) {
      const row = [];
      for (let j = 0; j <= vSegments; j += 1) {
        const u = uMin + ((uMax - uMin) * i) / uSegments;
        const v = vMin + ((vMax - vMin) * j) / vSegments;
        row.push({
          x: finiteNumber(evaluateCompiled(xExpr, { u, v })),
          y: finiteNumber(evaluateCompiled(yExpr, { u, v })),
          z: finiteNumber(evaluateCompiled(zExpr, { u, v }))
        });
      }
      rows.push(row);
    }

    const segments = [];
    for (let i = 0; i <= uSegments; i += 1) {
      for (let j = 1; j <= vSegments; j += 1) {
        segments.push([rows[i][j - 1], rows[i][j]]);
      }
    }
    for (let i = 1; i <= uSegments; i += 1) {
      for (let j = 0; j <= vSegments; j += 1) {
        segments.push([rows[i - 1][j], rows[i][j]]);
      }
    }

    return { kind: 'segments', color: graph.color, lineWidth: 1, segments };
  }

  function createSolidDrawable(graph) {
    const expr = compile(graph.solidExpr, ['x', 'y', 'z']);
    const min = parseNumber(graph.boundsMin);
    const max = parseNumber(graph.boundsMax);
    const resolution = Math.max(MIN_SOLID_RESOLUTION, Math.min(MAX_SOLID_RESOLUTION, Math.round(parseNumber(graph.resolution))));

    if (!(max > min)) {
      throw new Error('Bounds max must be greater than bounds min.');
    }

    const span = max - min;
    const points = [];

    for (let ix = 0; ix <= resolution; ix += 1) {
      for (let iy = 0; iy <= resolution; iy += 1) {
        for (let iz = 0; iz <= resolution; iz += 1) {
          const x = min + (span * ix) / resolution;
          const y = min + (span * iy) / resolution;
          const z = min + (span * iz) / resolution;
          const value = evaluateCompiled(expr, { x, y, z });
          let inside;
          if (typeof value === 'boolean') {
            inside = value;
          } else if (typeof value === 'number' && Number.isFinite(value)) {
            inside = value <= 0;
          } else {
            throw new Error('Solid expression must return a boolean or finite number.');
          }
          if (inside) {
            points.push({ x, y, z });
          }
        }
      }
    }

    if (points.length === 0) {
      throw new Error('No solid points found in the current bounds.');
    }

    return { kind: 'points', color: graph.color, radius: Math.max(1, 16 / resolution), points };
  }

  function rebuildGraph(graph) {
    if (graph.type === 'curve') {
      graph.drawable = createCurveDrawable(graph);
    } else if (graph.type === 'surface') {
      graph.drawable = createSurfaceDrawable(graph);
    } else {
      graph.drawable = createSolidDrawable(graph);
    }
    graph.status = 'Plotted successfully.';
  }

  function updateGraphFromForm(graph, card) {
    card.querySelectorAll('[data-field]').forEach((field) => {
      graph[field.dataset.field] = field.value;
    });
  }

  function field(name, label, value, type = 'text') {
    return `
      <div class="field">
        <label>${label}</label>
        <input data-field="${name}" type="${type}" value="${value}" />
      </div>
    `;
  }

  function renderGraphCard(graph) {
    const card = document.createElement('article');
    card.className = 'graph-card';
    card.innerHTML = `
      <div class="row">
        <div class="field">
          <label>Type</label>
          <select data-field="type">
            <option value="curve" ${graph.type === 'curve' ? 'selected' : ''}>Curve</option>
            <option value="surface" ${graph.type === 'surface' ? 'selected' : ''}>Surface</option>
            <option value="solid" ${graph.type === 'solid' ? 'selected' : ''}>Solid</option>
          </select>
        </div>
        ${field('color', 'Color', graph.color, 'color')}
      </div>

      <div data-type-group="curve-surface" class="row">
        ${field('xExpr', 'x expression', graph.xExpr)}
        ${field('yExpr', 'y expression', graph.yExpr)}
        ${field('zExpr', 'z expression', graph.zExpr)}
      </div>

      <div data-type-group="curve" class="row">
        ${field('tMin', 't min', graph.tMin)}
        ${field('tMax', 't max', graph.tMax)}
      </div>

      <div data-type-group="surface" class="row">
        ${field('uMin', 'u min', graph.uMin)}
        ${field('uMax', 'u max', graph.uMax)}
        ${field('vMin', 'v min', graph.vMin)}
        ${field('vMax', 'v max', graph.vMax)}
      </div>

      <div data-type-group="solid" class="row">
        <div class="field full">
          <label>Solid expression (boolean, or <= 0 form)</label>
          <input data-field="solidExpr" value="${graph.solidExpr}" />
        </div>
        ${field('boundsMin', 'Bounds min', graph.boundsMin)}
        ${field('boundsMax', 'Bounds max', graph.boundsMax)}
        ${field('resolution', 'Resolution (8-42)', graph.resolution)}
      </div>

      <div class="card-actions">
        <button type="button" data-action="plot">Plot</button>
        <button type="button" data-action="remove" class="secondary">Remove</button>
      </div>
      <div class="status"></div>
    `;

    const typeSelect = card.querySelector('[data-field="type"]');
    const statusEl = card.querySelector('.status');

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.classList.toggle('error', Boolean(isError));
    }

    function refreshVisibility() {
      const type = typeSelect.value;
      card.querySelectorAll('[data-type-group]').forEach((el) => {
        const group = el.dataset.typeGroup;
        const visible = group === type || (group === 'curve-surface' && (type === 'curve' || type === 'surface'));
        el.style.display = visible ? 'grid' : 'none';
      });
    }

    function replot() {
      updateGraphFromForm(graph, card);
      try {
        rebuildGraph(graph);
        setStatus(graph.status, false);
      } catch (err) {
        graph.drawable = null;
        setStatus(err.message, true);
      }
    }

    typeSelect.addEventListener('change', () => {
      refreshVisibility();
      updateGraphFromForm(graph, card);
      setStatus('Type changed. Press Plot to render.', false);
    });

    card.querySelector('[data-action="plot"]').addEventListener('click', replot);

    card.querySelector('[data-action="remove"]').addEventListener('click', () => {
      const index = runtimeGraphs.findIndex((g) => g.id === graph.id);
      if (index !== -1) {
        runtimeGraphs.splice(index, 1);
      }
      card.remove();
    });

    refreshVisibility();
    if (graph.status) {
      setStatus(graph.status, false);
    }

    return card;
  }

  function addGraph(graph = createDefaultGraph()) {
    runtimeGraphs.push(graph);
    try {
      rebuildGraph(graph);
    } catch (err) {
      graph.status = err.message;
      graph.drawable = null;
    }
    graphList.appendChild(renderGraphCard(graph));
  }

  function drawAxesAndGrid() {
    const lines = [];
    for (let i = -10; i <= 10; i += 1) {
      lines.push([{ x: i, y: 0, z: -10 }, { x: i, y: 0, z: 10 }, 'rgba(60, 72, 110, 0.55)']);
      lines.push([{ x: -10, y: 0, z: i }, { x: 10, y: 0, z: i }, 'rgba(60, 72, 110, 0.55)']);
    }

    lines.push([{ x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, '#ff6f6f']);
    lines.push([{ x: 0, y: -6, z: 0 }, { x: 0, y: 6, z: 0 }, '#6fff88']);
    lines.push([{ x: 0, y: 0, z: -6 }, { x: 0, y: 0, z: 6 }, '#6fa7ff']);

    lines.forEach(([a, b, color]) => {
      const pa = project(a);
      const pb = project(b);
      if (!pa || !pb) {
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });
  }

  function drawGraphs() {
    const drawCommands = [];

    runtimeGraphs.forEach((graph) => {
      const drawable = graph.drawable;
      if (!drawable) {
        return;
      }

      if (drawable.kind === 'segments') {
        drawable.segments.forEach(([a, b]) => {
          const pa = project(a);
          const pb = project(b);
          if (!pa || !pb) {
            return;
          }
          drawCommands.push({
            kind: 'line',
            ax: pa.x,
            ay: pa.y,
            bx: pb.x,
            by: pb.y,
            depth: (pa.depth + pb.depth) * 0.5,
            color: colorToRGBA(drawable.color, 0.9),
            lineWidth: drawable.lineWidth
          });
        });
      } else if (drawable.kind === 'points') {
        drawable.points.forEach((p) => {
          const pp = project(p);
          if (!pp) {
            return;
          }
          drawCommands.push({
            kind: 'point',
            x: pp.x,
            y: pp.y,
            depth: pp.depth,
            radius: drawable.radius,
            color: colorToRGBA(drawable.color, 0.75)
          });
        });
      }
    });

    drawCommands.sort((a, b) => b.depth - a.depth);

    drawCommands.forEach((cmd) => {
      if (cmd.kind === 'line') {
        ctx.strokeStyle = cmd.color;
        ctx.lineWidth = cmd.lineWidth;
        ctx.beginPath();
        ctx.moveTo(cmd.ax, cmd.ay);
        ctx.lineTo(cmd.bx, cmd.by);
        ctx.stroke();
      } else {
        const adjustedDepth = Math.max(MIN_DEPTH_FOR_POINT_SCALING, cmd.depth);
        const size = Math.max(1, cmd.radius * (POINT_SIZE_SCALE / adjustedDepth));
        ctx.fillStyle = cmd.color;
        ctx.beginPath();
        ctx.arc(cmd.x, cmd.y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderState.width = width;
    renderState.height = height;
    canvas.width = Math.floor(width * Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO));
    canvas.height = Math.floor(height * Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO));
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  }

  function render() {
    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, renderState.width, renderState.height);
    drawAxesAndGrid();
    drawGraphs();
    requestAnimationFrame(render);
  }

  let dragStart = null;
  canvas.addEventListener('pointerdown', (event) => {
    dragStart = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragStart) {
      return;
    }
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    dragStart = { x: event.clientX, y: event.clientY };
    camera.yaw -= dx * 0.008;
    camera.pitch = Math.max(-1.45, Math.min(1.45, camera.pitch - dy * 0.008));
  });

  canvas.addEventListener('pointerup', () => {
    dragStart = null;
  });

  canvas.addEventListener('pointercancel', () => {
    dragStart = null;
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    camera.distance = Math.max(3, Math.min(60, camera.distance + event.deltaY * 0.02));
  }, { passive: false });

  addButton.addEventListener('click', () => addGraph(createDefaultGraph()));

  resetCameraButton.addEventListener('click', () => {
    camera.yaw = -0.7;
    camera.pitch = -0.5;
    camera.distance = 16;
    camera.target.x = 0;
    camera.target.y = 0;
    camera.target.z = 0;
  });

  window.addEventListener('resize', resize);

  resize();
  addGraph(createDefaultGraph());
  render();
})();
