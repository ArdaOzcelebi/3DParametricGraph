(function () {
  const canvas = document.getElementById('graph-canvas');
  const graphList = document.getElementById('graph-list');
  const addButton = document.getElementById('add-graph');
  const resetCameraButton = document.getElementById('reset-camera');
  const toggleThemeButton = document.getElementById('toggle-theme');

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
  const MESH_OPACITY = 0.92;
  const DEFAULT_MAIN_EXAMPLE = '(cos(t), sin(t), t/6)';
  const GRAPH_COLORS = ['#c74440', '#2d70b3', '#388c46', '#fa7e19', '#6042a6', '#000000'];
  const THEME_COLORS = {
    dark: {
      canvas: '#1a1b26',
      grid: 'rgba(60, 72, 110, 0.45)',
      box: 'rgba(80, 100, 150, 0.45)',
      axisLabel: 'rgba(160, 180, 230, 0.92)'
    },
    light: {
      canvas: '#f9f9f9',
      grid: 'rgba(170, 185, 210, 0.6)',
      box: 'rgba(155, 170, 195, 0.65)',
      axisLabel: 'rgba(90, 105, 130, 0.95)'
    }
  };
  const LIGHT_DIR = (() => {
    const lx = 1, ly = 2, lz = 1;
    const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
    return { x: lx / len, y: ly / len, z: lz / len };
  })();
  let activeTheme = 'dark';

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
    e: Math.E,
    infinity: Infinity
  };
  const SAFE_KEYS = Object.keys(SAFE_SCOPE);
  const SAFE_VALUES = SAFE_KEYS.map((k) => SAFE_SCOPE[k]);
  const FUNCTION_NAMES = new Set(SAFE_KEYS.filter((k) => typeof SAFE_SCOPE[k] === 'function'));
  const IDENTIFIER_RE = /[A-Za-z_]\w*/g;
  const DISALLOWED_CHARS_RE = /[^0-9A-Za-z_+\-*/%^().,<>=!&| \t]/;

  function createDefaultGraph() {
    graphIdCounter += 1;
    const color = GRAPH_COLORS[(graphIdCounter - 1) % GRAPH_COLORS.length];
    return {
      id: `graph-${graphIdCounter}`,
      type: 'curve',
      color,
      mainExpr: DEFAULT_MAIN_EXAMPLE,
      xExpr: 'cos(t)',
      yExpr: 'sin(t)',
      zExpr: 't/6',
      tMin: '0',
      tMax: '12*pi',
      uMin: '0',
      uMax: '3',
      vMin: '0',
      vMax: '2*pi',
      wMin: '0',
      wMax: '1',
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

  function tokenizeExpression(expression) {
    const tokens = [];
    const src = String(expression || '');
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (/\s/.test(ch)) {
        continue;
      }
      const two = src.slice(i, i + 2);
      if (['<=', '>=', '==', '!=', '&&', '||', '**'].includes(two)) {
        tokens.push({ type: 'operator', value: two });
        i += 1;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        let j = i + 1;
        while (j < src.length && /[0-9.]/.test(src[j])) {
          j += 1;
        }
        tokens.push({ type: 'number', value: src.slice(i, j) });
        i = j - 1;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < src.length && /\w/.test(src[j])) {
          j += 1;
        }
        tokens.push({ type: 'identifier', value: src.slice(i, j) });
        i = j - 1;
        continue;
      }
      if (ch === '(' || ch === ')') {
        tokens.push({ type: 'paren', value: ch });
        continue;
      }
      if (ch === ',') {
        tokens.push({ type: 'comma', value: ch });
        continue;
      }
      tokens.push({ type: 'operator', value: ch });
    }
    return tokens;
  }

  function splitImplicitIdentifierToken(token) {
    if (!token || token.type !== 'identifier') {
      return [token];
    }
    const value = token.value;
    if (SAFE_KEYS.includes(value) || value === 'true' || value === 'false') {
      return [token];
    }
    const lower = value.toLowerCase();
    if (/^[tuvwxyz]{2,}$/.test(lower)) {
      return lower.split('').map((part) => ({ type: 'identifier', value: part }));
    }
    return [token];
  }

  function canEndImplicit(token) {
    return token && (token.type === 'number' || token.type === 'identifier' || (token.type === 'paren' && token.value === ')'));
  }

  function canStartImplicit(token) {
    return token && (token.type === 'number' || token.type === 'identifier' || (token.type === 'paren' && token.value === '('));
  }

  function shouldInsertImplicitMultiplication(prev, next) {
    if (!canEndImplicit(prev) || !canStartImplicit(next)) {
      return false;
    }
    if (prev.type === 'identifier' && next.type === 'paren' && next.value === '(' && FUNCTION_NAMES.has(prev.value)) {
      return false;
    }
    return true;
  }

  function insertImplicitMultiplication(expression) {
    const tokens = tokenizeExpression(expression);
    const expandedTokens = [];
    tokens.forEach((token) => {
      expandedTokens.push(...splitImplicitIdentifierToken(token));
    });
    const parts = [];
    for (let i = 0; i < expandedTokens.length; i += 1) {
      const token = expandedTokens[i];
      const next = expandedTokens[i + 1];
      parts.push(token.value);
      if (shouldInsertImplicitMultiplication(token, next)) {
        parts.push('*');
      }
    }
    return parts.join('');
  }

  function normalizeExpressionInput(expression) {
    let src = String(expression || '');
    src = src.replace(/[×⋅·]/g, '*').replace(/÷/g, '/').replace(/π/g, 'pi').replace(/∞/g, 'infinity');
    src = src.replace(/\binfty\b/gi, 'infinity');
    src = src.replace(/\bln\s*\(/gi, 'log(');
    src = src.replace(/√\s*\(/g, 'sqrt(');
    src = src.replace(/√\s*([+\-]?\s*(?:[A-Za-z_]\w*|\d+(?:\.\d+)?))/g, (_, arg) => `sqrt(${String(arg).replace(/\s+/g, '')})`);
    src = src.replace(/\bsqrt\s+([+\-]?\s*(?:[A-Za-z_]\w*|\d+(?:\.\d+)?))/gi, (_, arg) => `sqrt(${String(arg).replace(/\s+/g, '')})`);
    return insertImplicitMultiplication(src);
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
    const src = normalizeExponentSyntax(normalizeExpressionInput(expression));
    validateExpressionSource(src, variables);
    return new Function(...SAFE_KEYS, ...variables, `'use strict'; return (${src});`);
  }

  function compileEvaluator(expression, variables) {
    const fn = compile(expression, variables);
    return (...values) => fn(...SAFE_VALUES, ...values);
  }

  function parseNumber(raw) {
    const evaluate = compileEvaluator(String(raw || '0'), []);
    const value = Number(evaluate());
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

  function throwMainExpressionError(message) {
    throw new Error(message || 'Invalid expression.');
  }

  function splitTopLevel(expression) {
    const parts = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < expression.length; i += 1) {
      const ch = expression[i];
      if (ch === '(') {
        depth += 1;
        current += ch;
      } else if (ch === ')') {
        depth -= 1;
        if (depth < 0) {
          throwMainExpressionError('Invalid expression. Parentheses are unbalanced.');
        }
        current += ch;
      } else if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (depth !== 0) {
      throwMainExpressionError('Invalid expression. Parentheses are unbalanced.');
    }
    if (current.trim()) {
      parts.push(current.trim());
    }
    return parts;
  }

  function stripOuterParens(expression) {
    const trimmed = String(expression || '').trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  function expressionHasIdentifier(expression, identifier) {
    const name = String(identifier || '').trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      return false;
    }
    return new RegExp(`\\b${name}\\b`).test(String(expression || ''));
  }

  function removeAxisPrefix(expression, axis) {
    const value = String(expression || '').trim();
    const axisName = String(axis || '').trim().toLowerCase();
    if (!['x', 'y', 'z'].includes(axisName)) {
      return value;
    }
    const prefix = `${axisName}=`;
    const normalized = value.replace(/\s+/g, '');
    if (!normalized.toLowerCase().startsWith(prefix)) {
      return value;
    }
    const equalIndex = value.indexOf('=');
    if (equalIndex === -1) {
      return value;
    }
    return value.slice(equalIndex + 1).trim();
  }

  function toSurfaceExpression(rhs) {
    return String(rhs || '').replace(/\bx\b/g, 'u').replace(/\by\b/g, 'v');
  }

  function containsComparisonOperators(expression) {
    return /[<>]=?|==|!=/.test(String(expression || ''));
  }

  function parseParametricTuple(expression, strict = false) {
    const expr = normalizeExpressionInput(expression).trim();
    if (!expr) {
      return null;
    }
    const base = stripOuterParens(expr);
    let parts;
    try {
      parts = splitTopLevel(base);
    } catch (err) {
      if (strict) {
        throw err;
      }
      return null;
    }
    if (parts.length !== 3) {
      return null;
    }

    const [rawX, rawY, rawZ] = parts;
    const xExpr = removeAxisPrefix(rawX, 'x');
    const yExpr = removeAxisPrefix(rawY, 'y');
    const zExpr = removeAxisPrefix(rawZ, 'z');
    const combined = `${xExpr} ${yExpr} ${zExpr}`;
    const hasW = expressionHasIdentifier(combined, 'w');
    const hasUOrV = expressionHasIdentifier(combined, 'u') || expressionHasIdentifier(combined, 'v');
    const type = hasW ? 'solid' : (hasUOrV ? 'surface' : 'curve');

    return { xExpr, yExpr, zExpr, type };
  }

  function applyMainExpression(graph) {
    const expr = normalizeExpressionInput(graph.mainExpr).trim();
    if (expr) {
      graph.mainExpr = expr;
    }
    if (!expr) {
      if (graph.xExpr && graph.yExpr && graph.zExpr) {
        graph.mainExpr = `(${graph.xExpr}, ${graph.yExpr}, ${graph.zExpr})`;
      }
      return;
    }

    const tuple = parseParametricTuple(expr, true);
    if (tuple) {
      graph.type = tuple.type;
      graph.xExpr = tuple.xExpr;
      graph.yExpr = tuple.yExpr;
      graph.zExpr = tuple.zExpr;
      return;
    }

    const explicitMatch = expr.match(/^\s*z\s*=\s*(.+)$/i);
    const rhs = explicitMatch ? explicitMatch[1].trim() : expr;
    const looksLikeSurfaceExpr = !containsComparisonOperators(rhs) && (expressionHasIdentifier(rhs, 'x') || expressionHasIdentifier(rhs, 'y'));
    if (looksLikeSurfaceExpr) {
      graph.type = 'surface';
      graph.xExpr = 'u';
      graph.yExpr = 'v';
      graph.zExpr = toSurfaceExpression(rhs);
      return;
    }

    throwMainExpressionError('Invalid expression. Try (cos(t), sin(t), t/6), (u*v, sin(u*v), cos(u)), (u, v, w), or z=sin(x)*cos(y).');
  }

  function setTheme(theme) {
    activeTheme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = activeTheme;
    if (toggleThemeButton) {
      if (toggleThemeButton.dataset.themeToggle === 'icon') {
        toggleThemeButton.textContent = activeTheme === 'light' ? '◐' : '☀';
      } else {
        toggleThemeButton.textContent = activeTheme === 'light' ? 'Dark Mode' : 'Light Mode';
      }
    }
    try {
      localStorage.setItem('graph-theme', activeTheme);
    } catch (err) {
      // Ignore storage errors.
    }
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
    const xExpr = compileEvaluator(graph.xExpr, ['t']);
    const yExpr = compileEvaluator(graph.yExpr, ['t']);
    const zExpr = compileEvaluator(graph.zExpr, ['t']);
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
        x: finiteNumber(xExpr(t)),
        y: finiteNumber(yExpr(t)),
        z: finiteNumber(zExpr(t))
      });
    }

    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      segments.push([points[i - 1], points[i]]);
    }

    return { kind: 'segments', color: graph.color, lineWidth: 2, segments };
  }

  function hexToRgb(hex) {
    const value = String(hex || '#ffffff').replace('#', '');
    const expanded = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
      return { r: 255, g: 255, b: 255 };
    }
    const n = parseInt(expanded, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function createSurfaceDrawable(graph) {
    const xExpr = compileEvaluator(graph.xExpr, ['u', 'v']);
    const yExpr = compileEvaluator(graph.yExpr, ['u', 'v']);
    const zExpr = compileEvaluator(graph.zExpr, ['u', 'v']);
    const uMin = parseNumber(graph.uMin);
    const uMax = parseNumber(graph.uMax);
    const vMin = parseNumber(graph.vMin);
    const vMax = parseNumber(graph.vMax);

    if (!(uMax > uMin && vMax > vMin)) {
      throw new Error('u/v max must be greater than min.');
    }

    const uSegments = 36;
    const vSegments = 36;
    const rows = [];

    for (let i = 0; i <= uSegments; i += 1) {
      const row = [];
      for (let j = 0; j <= vSegments; j += 1) {
        const u = uMin + ((uMax - uMin) * i) / uSegments;
        const v = vMin + ((vMax - vMin) * j) / vSegments;
        row.push({
          x: finiteNumber(xExpr(u, v)),
          y: finiteNumber(yExpr(u, v)),
          z: finiteNumber(zExpr(u, v))
        });
      }
      rows.push(row);
    }

    const rgb = hexToRgb(graph.color);
    const quads = [];
    for (let i = 0; i < uSegments; i += 1) {
      for (let j = 0; j < vSegments; j += 1) {
        const a = rows[i][j];
        const b = rows[i + 1][j];
        const c = rows[i + 1][j + 1];
        const d = rows[i][j + 1];

        const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
        const e2x = d.x - a.x, e2y = d.y - a.y, e2z = d.z - a.z;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

        quads.push({ verts: [a, b, c, d], nx: nx / len, ny: ny / len, nz: nz / len });
      }
    }

    return { kind: 'mesh', rgb, quads };
  }

  function createSolidDrawable(graph) {
    const tuple = parseParametricTuple(graph.mainExpr);
    if (tuple && tuple.type === 'solid') {
      const xExpr = compileEvaluator(tuple.xExpr, ['u', 'v', 'w']);
      const yExpr = compileEvaluator(tuple.yExpr, ['u', 'v', 'w']);
      const zExpr = compileEvaluator(tuple.zExpr, ['u', 'v', 'w']);
      const uMin = parseNumber(graph.uMin);
      const uMax = parseNumber(graph.uMax);
      const vMin = parseNumber(graph.vMin);
      const vMax = parseNumber(graph.vMax);
      const wMin = parseNumber(graph.wMin);
      const wMax = parseNumber(graph.wMax);
      const resolution = Math.max(MIN_SOLID_RESOLUTION, Math.min(MAX_SOLID_RESOLUTION, Math.round(parseNumber(graph.resolution))));

      if (!(uMax > uMin && vMax > vMin && wMax > wMin)) {
        throw new Error('u/v/w max must be greater than min.');
      }

      const points = [];
      for (let iu = 0; iu <= resolution; iu += 1) {
        const u = uMin + ((uMax - uMin) * iu) / resolution;
        for (let iv = 0; iv <= resolution; iv += 1) {
          const v = vMin + ((vMax - vMin) * iv) / resolution;
          for (let iw = 0; iw <= resolution; iw += 1) {
            const w = wMin + ((wMax - wMin) * iw) / resolution;
            points.push({
              x: finiteNumber(xExpr(u, v, w)),
              y: finiteNumber(yExpr(u, v, w)),
              z: finiteNumber(zExpr(u, v, w))
            });
          }
        }
      }

      if (points.length === 0) {
        throw new Error('No solid points found in the current u/v/w ranges.');
      }

      graph.xExpr = tuple.xExpr;
      graph.yExpr = tuple.yExpr;
      graph.zExpr = tuple.zExpr;
      return { kind: 'points', color: graph.color, radius: Math.max(1, 14 / resolution), points };
    }

    const expr = compileEvaluator(graph.solidExpr, ['x', 'y', 'z']);
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
          const value = expr(x, y, z);
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
    // Always re-parse if mainExpr is a parametric tuple (handles type changes on re-plot)
    const tuple = parseParametricTuple(graph.mainExpr);
    if (graph.type !== 'solid' || tuple) {
      applyMainExpression(graph);
    }
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
      <div class="card-row">
        <button type="button" class="color-dot" data-action="pick-color" aria-label="Graph color" style="background:${graph.color}"></button>
        <div class="card-body">
          <input data-field="mainExpr" value="${graph.mainExpr || ''}" placeholder="${DEFAULT_MAIN_EXAMPLE} or z=sin(x)*cos(y)" aria-label="Expression" />
          <div class="hint">Curve <code>(t)</code>, surface <code>(u,v)</code>, solid <code>(u,v,w)</code>, or <code>z=f(x,y)</code>. Implicit multiplication and aliases like <code>√</code>/<code>sqrt</code>, <code>π</code>, and <code>infty</code> are supported.</div>
          <div class="card-actions">
            <button type="button" data-action="plot">Plot</button>
            <details class="advanced-options">
              <summary>Advanced</summary>
              <div class="row">
                <div class="field">
                  <label>Type</label>
                  <select data-field="type">
                    <option value="curve" ${graph.type === 'curve' ? 'selected' : ''}>Curve</option>
                    <option value="surface" ${graph.type === 'surface' ? 'selected' : ''}>Surface</option>
                    <option value="solid" ${graph.type === 'solid' ? 'selected' : ''}>Solid</option>
                  </select>
                </div>
              </div>

              <div data-type-group="curve-surface" class="row">
                ${field('xExpr', 'x expression', graph.xExpr)}
                ${field('yExpr', 'y expression', graph.yExpr)}
                ${field('zExpr', 'z expression', graph.zExpr)}
              </div>

              <div data-type-group="curve" class="row split">
                ${field('tMin', 't min', graph.tMin)}
                ${field('tMax', 't max', graph.tMax)}
              </div>

              <div data-type-group="surface" class="row split">
                ${field('uMin', 'u min', graph.uMin)}
                ${field('uMax', 'u max', graph.uMax)}
                ${field('vMin', 'v min', graph.vMin)}
                ${field('vMax', 'v max', graph.vMax)}
                ${field('wMin', 'w min', graph.wMin)}
                ${field('wMax', 'w max', graph.wMax)}
              </div>

              <div data-type-group="solid" class="row">
                <div class="field full">
                  <label>Solid expression (boolean, or &lt;= 0 form)</label>
                  <input data-field="solidExpr" value="${graph.solidExpr}" />
                </div>
                ${field('boundsMin', 'Bounds min', graph.boundsMin)}
                ${field('boundsMax', 'Bounds max', graph.boundsMax)}
                ${field('resolution', 'Resolution (8-42)', graph.resolution)}
              </div>
            </details>
          </div>
          <div class="status"></div>
        </div>
        <button type="button" data-action="remove" class="icon-button" aria-label="Remove expression">×</button>
      </div>
      <input type="color" data-field="color" value="${graph.color}" style="display:none" tabindex="-1" aria-hidden="true" />
    `;

    const typeSelect = card.querySelector('[data-field="type"]');
    const colorDot = card.querySelector('.color-dot');
    const colorInput = card.querySelector('[data-field="color"]');
    const statusEl = card.querySelector('.status');

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.classList.toggle('error', Boolean(isError));
    }

    function refreshVisibility() {
      const type = typeSelect.value;
      const tuple = parseParametricTuple(card.querySelector('[data-field="mainExpr"]').value);
      const showParametricRanges = type === 'surface' || (type === 'solid' && tuple && tuple.type === 'solid');
      card.querySelectorAll('[data-type-group]').forEach((el) => {
        const group = el.dataset.typeGroup;
        const isCurveSurfaceGroup = group === 'curve-surface' && (type === 'curve' || type === 'surface');
        const isSurfaceGroup = group === 'surface' && showParametricRanges;
        const visible = group === type || isCurveSurfaceGroup || isSurfaceGroup;
        el.style.display = visible ? 'grid' : 'none';
      });
    }

    function replot() {
      updateGraphFromForm(graph, card);
      try {
        rebuildGraph(graph);
        typeSelect.value = graph.type;
        card.querySelector('[data-field="mainExpr"]').value = graph.mainExpr;
        card.querySelector('[data-field="xExpr"]').value = graph.xExpr;
        card.querySelector('[data-field="yExpr"]').value = graph.yExpr;
        card.querySelector('[data-field="zExpr"]').value = graph.zExpr;
        colorDot.style.background = graph.color;
        colorInput.value = graph.color;
        refreshVisibility();
        setStatus(graph.status, false);
      } catch (err) {
        graph.drawable = null;
        setStatus(err.message, true);
      }
    }

    colorDot.addEventListener('click', () => colorInput.click());

    colorInput.addEventListener('input', () => {
      colorDot.style.background = colorInput.value;
    });

    typeSelect.addEventListener('change', () => {
      refreshVisibility();
      updateGraphFromForm(graph, card);
      setStatus('Type changed. Press Plot to render.', false);
    });

    card.querySelector('[data-action="plot"]').addEventListener('click', replot);
    card.querySelector('[data-field="mainExpr"]').addEventListener('input', refreshVisibility);
    card.querySelector('[data-field="mainExpr"]').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        replot();
      }
    });

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
    const tc = THEME_COLORS[activeTheme];
    const B = 5;

    // Floor grid (y = 0 plane)
    for (let i = -B; i <= B; i += 1) {
      const a = project({ x: i, y: 0, z: -B });
      const b = project({ x: i, y: 0, z: B });
      const c = project({ x: -B, y: 0, z: i });
      const d = project({ x: B, y: 0, z: i });
      ctx.strokeStyle = tc.grid;
      ctx.lineWidth = 0.75;
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      if (c && d) { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke(); }
    }

    // Bounding box
    const corners = [
      { x: -B, y: -B, z: -B }, { x: B, y: -B, z: -B },
      { x: B, y: B, z: -B }, { x: -B, y: B, z: -B },
      { x: -B, y: -B, z: B }, { x: B, y: -B, z: B },
      { x: B, y: B, z: B }, { x: -B, y: B, z: B }
    ];
    const boxEdges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    ctx.strokeStyle = tc.box;
    ctx.lineWidth = 0.8;
    boxEdges.forEach(([ai, bi]) => {
      const pa = project(corners[ai]);
      const pb = project(corners[bi]);
      if (!pa || !pb) { return; }
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    });

    // Axes (drawn on top of grid)
    const axisLines = [
      [{ x: 0, y: 0, z: 0 }, { x: B, y: 0, z: 0 }, '#e05050'],
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: B, z: 0 }, '#50c060'],
      [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: B }, '#5090e0']
    ];
    axisLines.forEach(([from, to, color]) => {
      const pf = project(from);
      const pt = project(to);
      if (!pf || !pt) { return; }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pf.x, pf.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();

      // Arrowhead
      const dx = pt.x - pf.x;
      const dy = pt.y - pf.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const arrowLen = 7;
      const arrowWid = 3;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x - ux * arrowLen - uy * arrowWid, pt.y - uy * arrowLen + ux * arrowWid);
      ctx.lineTo(pt.x - ux * arrowLen + uy * arrowWid, pt.y - uy * arrowLen - ux * arrowWid);
      ctx.closePath();
      ctx.fill();
    });

    // Axis labels
    const labels = [
      { pos: { x: B + 0.5, y: 0, z: 0 }, text: 'x' },
      { pos: { x: 0, y: B + 0.5, z: 0 }, text: 'y' },
      { pos: { x: 0, y: 0, z: B + 0.5 }, text: 'z' }
    ];
    ctx.font = 'bold 13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    labels.forEach(({ pos, text }) => {
      const pp = project(pos);
      if (!pp) { return; }
      ctx.fillStyle = tc.axisLabel;
      ctx.fillText(text, pp.x, pp.y);
    });
  }

  function drawGraphs() {
    const drawCommands = [];

    runtimeGraphs.forEach((graph) => {
      const drawable = graph.drawable;
      if (!drawable) {
        return;
      }

      if (drawable.kind === 'mesh') {
        drawable.quads.forEach((q) => {
          const projected = q.verts.map((v) => project(v));
          if (projected.some((p) => !p)) {
            return;
          }
          const depth = projected.reduce((s, p) => s + p.depth, 0) * 0.25;
          const dot = Math.abs(q.nx * LIGHT_DIR.x + q.ny * LIGHT_DIR.y + q.nz * LIGHT_DIR.z);
          const brightness = 0.35 + 0.65 * dot;
          drawCommands.push({
            kind: 'quad',
            pts: projected,
            depth,
            r: drawable.rgb.r,
            g: drawable.rgb.g,
            b: drawable.rgb.b,
            brightness
          });
        });
      } else if (drawable.kind === 'segments') {
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
      if (cmd.kind === 'quad') {
        const br = cmd.brightness;
        const r = Math.round(cmd.r * br);
        const g = Math.round(cmd.g * br);
        const b = Math.round(cmd.b * br);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${MESH_OPACITY})`;
        ctx.beginPath();
        ctx.moveTo(cmd.pts[0].x, cmd.pts[0].y);
        ctx.lineTo(cmd.pts[1].x, cmd.pts[1].y);
        ctx.lineTo(cmd.pts[2].x, cmd.pts[2].y);
        ctx.lineTo(cmd.pts[3].x, cmd.pts[3].y);
        ctx.closePath();
        ctx.fill();
        // Thin edge to remove seams between quads
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.4)`;
        ctx.lineWidth = 0.4;
        ctx.stroke();
      } else if (cmd.kind === 'line') {
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
    ctx.fillStyle = THEME_COLORS[activeTheme].canvas;
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

  if (toggleThemeButton) {
    toggleThemeButton.addEventListener('click', () => {
      setTheme(activeTheme === 'dark' ? 'light' : 'dark');
    });
  }

  const initialTheme = (() => {
    let fallback = 'dark';
    try {
      const storedTheme = localStorage.getItem('graph-theme');
      if (storedTheme === 'light' || storedTheme === 'dark') {
        return storedTheme;
      }
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
      }
    } catch (err) {
      fallback = 'dark';
    }
    return fallback;
  })();
  setTheme(initialTheme);

  resize();
  addGraph(createDefaultGraph());
  render();
})();
