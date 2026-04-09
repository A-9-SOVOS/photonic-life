// PHOTONIC CELLULAR AUTOMATON — WDM + Alias Rewriting System
//
// Alias system design (performance-first):
//   An alias is a pattern pair (A → B), each an NxM grid of cells.
//   Each cell in a pattern has: r,g,b channel flags (0/1) and a color
//   bucket (0=any, 1=red, 2=green, 3=blue, 4=yellow, 5=cyan, 6=magenta, 7=white).
//
//   Scan strategy — dirty-region incremental:
//     After each step, only cells that CHANGED state are added to a dirty set.
//     We only check alias windows whose top-left corner is within range of a
//     dirty cell (range = pattern dimensions). This means on a stable grid,
//     alias scanning costs ~0. On an active grid it scales with activity, not
//     with total cell count.
//
//   Matching:
//     Each alias has a precomputed fingerprint (Uint32 hash of the A pattern).
//     We compute the same hash for each candidate window. Hash mismatch = skip.
//     Hash match = full pixel-exact verify. Substitution writes pattern B.
//
//   Color matching:
//     Each pattern cell specifies which channels must be alive (r/g/b flags)
//     and optionally a color bucket tolerance. Dead cells in the pattern match
//     only dead grid cells. This is exact — no fuzzy matching.

'use strict';

const canvas = document.getElementById('gridCanvas');
const ctx    = canvas.getContext('2d');

const cfg = {
  cellSize:   6,
  speed:      20,
  isPlaying:  false,
  brushCh:    [true, false, false],
  brushPhase: 0,
  bloom:      true,
};

const SURVIVE_COHERENCE = 0.42;
const BIRTH_COHERENCE   = 0.52;
const ENTRAINMENT       = 0.07;
const TWO_PI            = Math.PI * 2;
const THREE_PI          = Math.PI * 3;

let cols, rows, generation = 0;

// ── Flat typed-array grids ────────────────────────────────────────────────────
// Layout: i = (x * rows + y) * 3 + channel
let amp, phase, nextAmp, nextPhase, cohCache;

function allocGrids() {
  const n = cols * rows * 3;
  amp       = new Uint8Array(n);
  phase     = new Float32Array(n);
  nextAmp   = new Uint8Array(n);
  nextPhase = new Float32Array(n);
  cohCache  = new Float32Array(n);
}

function idx(x, y, c) { return (x * rows + y) * 3 + c; }

// ── Dirty-cell tracking ───────────────────────────────────────────────────────
// We track which (x,y) cells changed this step so alias scanning is incremental.
// Using a flat Uint8Array as a boolean set — O(1) insert/lookup, O(cols*rows) clear.
let dirtyFlags;   // Uint8Array[cols*rows], 1 = dirty this step
let dirtyList;    // Int32Array — flat list of dirty cell linear indices (x*rows+y)
let dirtyCount = 0;

function allocDirty() {
  dirtyFlags = new Uint8Array(cols * rows);
  dirtyList  = new Int32Array(cols * rows);
}

function markDirty(x, y) {
  const li = x * rows + y;
  if (dirtyFlags[li] === 0) {
    dirtyFlags[li] = 1;
    dirtyList[dirtyCount++] = li;
  }
}

function clearDirty() {
  for (let i = 0; i < dirtyCount; i++) dirtyFlags[dirtyList[i]] = 0;
  dirtyCount = 0;
}

// ── Simulation step ───────────────────────────────────────────────────────────
const NB_DX = [-1,-1,-1, 0, 0, 1, 1, 1];
const NB_DY = [-1, 0, 1,-1, 1,-1, 0, 1];

function step() {
  clearDirty();

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      const base = (x * rows + y) * 3;
      let cellChanged = false;

      for (let c = 0; c < 3; c++) {
        const i = base + c;
        let sx = 0, sy = 0, n = 0;

        for (let k = 0; k < 8; k++) {
          const nx = (x + NB_DX[k] + cols) % cols;
          const ny = (y + NB_DY[k] + rows) % rows;
          const ni = (nx * rows + ny) * 3 + c;
          if (amp[ni] === 1) {
            const p = phase[ni];
            sx += Math.cos(p);
            sy += Math.sin(p);
            n++;
          }
        }

        if (n === 0) {
          if (amp[i] !== 0) cellChanged = true;
          nextAmp[i]   = 0;
          nextPhase[i] = phase[i];
          cohCache[i]  = 0;
          continue;
        }

        const R    = Math.sqrt(sx * sx + sy * sy) / n;
        const mean = Math.atan2(sy, sx);
        cohCache[i] = R;

        let newAmp = amp[i]; // default: unchanged (overwritten below in all live branches)
        if (amp[i] === 1) {
          if ((n === 2 || n === 3) && R >= SURVIVE_COHERENCE) {
            const delta = mean - phase[i];
            const d = ((delta + THREE_PI) % TWO_PI) - Math.PI;
            nextAmp[i]   = 1;
            nextPhase[i] = (phase[i] + d * ENTRAINMENT + TWO_PI) % TWO_PI;
            newAmp = 1;
          } else {
            nextAmp[i]   = 0;
            nextPhase[i] = phase[i];
            newAmp = 0;
          }
        } else {
          if (n === 3 && R >= BIRTH_COHERENCE) {
            nextAmp[i]   = 1;
            nextPhase[i] = mean < 0 ? mean + TWO_PI : mean;
            newAmp = 1;
          } else {
            nextAmp[i]   = 0;
            nextPhase[i] = phase[i];
            newAmp = 0;
          }
        }
        if (newAmp !== amp[i]) cellChanged = true;
      }

      if (cellChanged) markDirty(x, y);
    }
  }

  // Swap buffers
  const ta = amp;   amp   = nextAmp;   nextAmp   = ta;
  const tp = phase; phase = nextPhase; nextPhase = tp;

  // Apply aliases on changed regions.
  // Pass 1: all aliases fire on post-physics grid.
  // Then loop chain-only aliases until exhausted (Markov-style).
  if (aliases.length > 0 && dirtyCount > 0) {
    applyAliases(false);
    const hasChain = aliases.some(a => a.enabled && a.chain);
    if (hasChain) {
      let limit = 64; // safety cap — prevents infinite loops from badly designed rules
      while (dirtyCount > 0 && limit-- > 0) {
        if (!applyAliases(true)) break;
      }
    }
  }

  generation++;
  if (generation % 10 === 0) updateStats();
  render();
}


// ── Alias system ──────────────────────────────────────────────────────────────
//
// Alias data structure:
//   {
//     id:    number,
//     name:  string,
//     w, h:  pattern dimensions (1–8)
//     patA:  Uint8Array[w*h*3]  — channel amps for pattern A (0=dead,1=alive,2=wildcard)
//     patB:  Uint8Array[w*h*3]  — channel amps for pattern B (0=dead,1=alive)
//     phaseB: Float32Array[w*h*3] — phases to write for pattern B
//     hash:  number             — fast fingerprint of patA for pre-filter
//     enabled: bool
//   }
//
// Pattern cell encoding (per channel): 0=must be dead, 1=must be alive, 2=wildcard
//
// Hash: sum of (cellIndex * 7 + channelIndex * 3 + value * 31) mod 2^32
// Cheap to compute, good enough as a pre-filter before full verify.

let aliases = [];
let nextAliasId = 1;

function windowMatches(wx, wy, alias) {
  const { w, h, patA } = alias;
  let i = 0;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const gx = (wx + dx + cols) % cols;
      const gy = (wy + dy + rows) % rows;
      const gbase = (gx * rows + gy) * 3;
      for (let c = 0; c < 3; c++) {
        const expected = patA[i++];
        if (expected === 2) continue; // * wildcard — skip entirely
        if (expected === 3) {
          // ? shape — this channel must be alive; checked once per cell below
          continue;
        }
        if (amp[gbase + c] !== expected) return false;
      }
      // For ? cells: at least one channel must be alive
      // patA stores r=3,g=3,b=3 for shape wildcard — detect by checking the triplet
      const pi = i - 3; // rewind to start of this cell's channels
      if (patA[pi] === 3) { // shape wildcard cell
        if (amp[gbase] === 0 && amp[gbase+1] === 0 && amp[gbase+2] === 0) return false;
      }
    }
  }
  return true;
}

let windowFlags;
let windowList;
let windowCount = 0;

function allocWindowScan() {
  windowFlags = new Uint8Array(cols * rows);
  windowList  = new Int32Array(cols * rows);
}

function applyWindow(wx, wy, alias) {
  const { w, h, patB, phaseB } = alias;
  let i = 0;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const gx = (wx + dx + cols) % cols;
      const gy = (wy + dy + rows) % rows;
      for (let c = 0; c < 3; c++) {
        const gi = (gx * rows + gy) * 3 + c;
        amp[gi]      = patB[i];
        phase[gi]    = phaseB[i];
        cohCache[gi] = 0;
        i++;
      }
      // Mark written cells dirty so chain passes can detect them
      markDirty(gx, gy);
    }
  }
}

// applyAliases(chainOnly):
//   chainOnly=false → run all enabled aliases (first pass, post-physics)
//   chainOnly=true  → run only chain-enabled aliases (subsequent passes)
//   returns true if any alias fired
function applyAliases(chainOnly) {
  let anyFired = false;

  for (const alias of aliases) {
    if (!alias.enabled) continue;
    if (chainOnly && !alias.chain) continue;
    const { w, h } = alias;

    windowCount = 0;
    for (let di = 0; di < dirtyCount; di++) {
      const li  = dirtyList[di];
      const dcx = (li / rows) | 0;
      const dcy = li % rows;
      for (let wx = dcx - w + 1; wx <= dcx; wx++) {
        for (let wy = dcy - h + 1; wy <= dcy; wy++) {
          const nwx = (wx + cols) % cols;
          const nwy = (wy + rows) % rows;
          const wli = nwx * rows + nwy;
          if (windowFlags[wli] === 0 && windowCount < windowList.length) {
            windowFlags[wli] = 1;
            windowList[windowCount++] = wli;
          }
        }
      }
    }

    for (let wi = 0; wi < windowCount; wi++) {
      const wli = windowList[wi];
      windowFlags[wli] = 0;
      const wx = (wli / rows) | 0;
      const wy = wli % rows;
      if (!windowMatches(wx, wy, alias)) continue;
      applyWindow(wx, wy, alias);
      anyFired = true;
    }
  }

  return anyFired;
}

function addAlias(alias) {
  alias.id    = nextAliasId++;
  alias.chain = alias.chain ?? false;
  aliases.push(alias);
  renderAliasList();
}

function removeAlias(id) {
  aliases = aliases.filter(a => a.id !== id);
  renderAliasList();
}

function toggleAlias(id) {
  const a = aliases.find(a => a.id === id);
  if (a) { a.enabled = !a.enabled; renderAliasList(); }
}


// ── Alias editor UI ───────────────────────────────────────────────────────────
// Color palette: click a swatch to select it, then click/drag cells to paint.
// Right-click a cell = reset to dead.

const ALIAS_CHANNEL_STATES = [
  { r:0,g:0,b:0, color:'#111', label:'·'  },  // 0: dead       — must be fully dead
  { r:1,g:0,b:0, color:'#f44', label:'R'  },  // 1: red
  { r:0,g:1,b:0, color:'#4f4', label:'G'  },  // 2: green
  { r:0,g:0,b:1, color:'#44f', label:'B'  },  // 3: blue
  { r:1,g:1,b:0, color:'#ff4', label:'RG' },  // 4: yellow
  { r:1,g:0,b:1, color:'#f4f', label:'RB' },  // 5: magenta
  { r:0,g:1,b:1, color:'#4ff', label:'GB' },  // 6: cyan
  { r:1,g:1,b:1, color:'#fff', label:'W'  },  // 7: white
  { r:3,g:3,b:3, color:'#888', label:'?'  },  // 8: shape      — must be alive (any color) (A only)
  { r:2,g:2,b:2, color:'#333', label:'*'  },  // 9: wildcard   — truly anything (A only)
];
const A_STATES = 10;
const B_STATES = 8;

let editorW = 4, editorH = 4;  // must match the select default below
let editorA, editorB;
let selectedStateA = 1; // currently selected palette color for A editor
let selectedStateB = 1; // currently selected palette color for B editor

function makeEditorGrid(w, h) { return new Uint8Array(w * h); }

function buildPalette(containerId, isA) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  const count = isA ? A_STATES : B_STATES;
  for (let s = 0; s < count; s++) {
    const st  = ALIAS_CHANNEL_STATES[s];
    const sw  = document.createElement('div');
    sw.className = 'pal-swatch' + (s === (isA ? selectedStateA : selectedStateB) ? ' selected' : '');
    sw.style.background = st.color;
    sw.title = st.label;
    sw.dataset.state = s;
    sw.addEventListener('click', () => {
      if (isA) selectedStateA = s; else selectedStateB = s;
      wrap.querySelectorAll('.pal-swatch').forEach(el =>
        el.classList.toggle('selected', +el.dataset.state === s)
      );
    });
    wrap.appendChild(sw);
  }
}

function buildEditorCanvas(containerId, isA) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = '';
  const cellPx = 26;
  const cvs = document.createElement('canvas');
  cvs.width  = editorW * cellPx;
  cvs.height = editorH * cellPx;
  // Pin CSS size = intrinsic size so getBoundingClientRect is always 1:1
  cvs.style.width  = cvs.width  + 'px';
  cvs.style.height = cvs.height + 'px';
  cvs.style.cursor = 'crosshair';
  cvs.style.display = 'block';
  wrap.appendChild(cvs);

  const c   = cvs.getContext('2d');
  const data = isA ? editorA : editorB;

  function draw() {
    for (let x = 0; x < editorW; x++) {
      for (let y = 0; y < editorH; y++) {
        const s = ALIAS_CHANNEL_STATES[data[y * editorW + x]];
        c.fillStyle = s.color;
        c.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
        c.strokeStyle = '#1a1a2a';
        c.strokeRect(x * cellPx + 0.5, y * cellPx + 0.5, cellPx - 1, cellPx - 1);
        c.fillStyle = (s.color === '#111' || s.color === '#555') ? '#444' : '#0008';
        c.font = 'bold 9px monospace';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(s.label, x * cellPx + cellPx / 2, y * cellPx + cellPx / 2);
      }
    }
  }

  draw();

  function paintCell(e) {
    e.preventDefault();
    const rect   = cvs.getBoundingClientRect();
    // Scale from CSS pixels back to canvas intrinsic pixels
    const scaleX = cvs.width  / rect.width;
    const scaleY = cvs.height / rect.height;
    const cx = Math.floor((e.clientX - rect.left) * scaleX / cellPx);
    const cy = Math.floor((e.clientY - rect.top)  * scaleY / cellPx);
    if (cx < 0 || cx >= editorW || cy < 0 || cy >= editorH) return;
    if (e.buttons === 2 || e.type === 'contextmenu') {
      data[cy * editorW + cx] = 0;
    } else {
      data[cy * editorW + cx] = isA ? selectedStateA : selectedStateB;
    }
    draw();
  }

  let editorPainting = false;
  cvs.addEventListener('mousedown',   e => { editorPainting = true;  paintCell(e); });
  cvs.addEventListener('mousemove',   e => { if (editorPainting) paintCell(e); });
  cvs.addEventListener('mouseup',     () => editorPainting = false);
  cvs.addEventListener('mouseleave',  () => editorPainting = false);
  cvs.addEventListener('contextmenu', e => paintCell(e));
}

function rebuildEditors() {
  editorA = makeEditorGrid(editorW, editorH);
  editorB = makeEditorGrid(editorW, editorH);
  buildPalette('aliasPalA', true);
  buildPalette('aliasPalB', false);
  buildEditorCanvas('aliasEditorA', true);
  buildEditorCanvas('aliasEditorB', false);
}

function editorToPattern(data, w, h) {
  const pat   = new Uint8Array(w * h * 3);
  const phases = new Float32Array(w * h * 3);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ALIAS_CHANNEL_STATES[data[y * w + x]];
      pat[i]   = s.r; pat[i+1] = s.g; pat[i+2] = s.b;
      // Default phase for born cells: 0 (in-phase, maximally constructive)
      phases[i] = 0; phases[i+1] = 0; phases[i+2] = 0;
      i += 3;
    }
  }
  return { pat, phases };
}

let editingId = null; // null = creating new, number = editing existing

function loadAliasForEdit(id) {
  const a = aliases.find(a => a.id === id);
  if (!a) return;
  editingId = id;

  // Set size pickers
  editorW = a.w; editorH = a.h;
  document.getElementById('aliasSizeW').value = a.w;
  document.getElementById('aliasSizeH').value = a.h;

  // Rebuild editors at correct size, then populate from stored patterns
  editorA = makeEditorGrid(a.w, a.h);
  editorB = makeEditorGrid(a.w, a.h);

  // Convert patA/patB back to editor state indices
  let i = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const r = a.patA[i], g = a.patA[i+1], b = a.patA[i+2];
      editorA[y * a.w + x] = patToStateIndex(r, g, b);
      const rb = a.patB[i], gb = a.patB[i+1], bb = a.patB[i+2];
      editorB[y * a.w + x] = patToStateIndex(rb, gb, bb);
      i += 3;
    }
  }

  buildPalette('aliasPalA', true);
  buildPalette('aliasPalB', false);
  buildEditorCanvas('aliasEditorA', true);
  buildEditorCanvas('aliasEditorB', false);

  document.getElementById('aliasName').value = a.name;
  document.getElementById('aliasAddBtn').textContent = '✓ Save';
  document.getElementById('aliasCancelEdit').style.display = 'inline-block';

  // Scroll to top of panel so editor is visible
  document.getElementById('aliasPanel').scrollTop = 0;
}

function patToStateIndex(r, g, b) {
  // Reverse lookup into ALIAS_CHANNEL_STATES
  for (let s = 0; s < ALIAS_CHANNEL_STATES.length; s++) {
    const st = ALIAS_CHANNEL_STATES[s];
    if (st.r === r && st.g === g && st.b === b) return s;
  }
  return 0; // fallback to dead
}

function cancelEdit() {
  editingId = null;
  document.getElementById('aliasName').value = '';
  document.getElementById('aliasAddBtn').textContent = '+ Add';
  document.getElementById('aliasCancelEdit').style.display = 'none';
  rebuildEditors();
}

function commitAlias() {
  const nameEl = document.getElementById('aliasName');
  const name   = nameEl.value.trim() || ('Alias ' + nextAliasId);
  const { pat: patA }                     = editorToPattern(editorA, editorW, editorH);
  const { pat: patB, phases: phaseB }     = editorToPattern(editorB, editorW, editorH);

  if (editingId !== null) {
    // Update existing alias in-place
    const a = aliases.find(a => a.id === editingId);
    if (a) {
      a.name = name; a.w = editorW; a.h = editorH;
      a.patA = patA; a.patB = patB; a.phaseB = phaseB;
    }
    cancelEdit();
    renderAliasList();
  } else {
    addAlias({ name, w: editorW, h: editorH, patA, patB, phaseB, enabled: true });
    nameEl.value = '';
    rebuildEditors();
  }
}

// ── Alias export / import ─────────────────────────────────────────────────────
// Serialise to plain JSON — Uint8Arrays become regular arrays for portability.

function exportAliases() {
  const data = aliases.map(a => ({
    name:    a.name,
    w:       a.w,
    h:       a.h,
    enabled: a.enabled,
    chain:   a.chain,
    patA:    Array.from(a.patA),
    patB:    Array.from(a.patB),
    phaseB:  Array.from(a.phaseB),
  }));
  const json = JSON.stringify({ version: 1, aliases: data }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'photonic-aliases.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importAliases(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      const list   = parsed.aliases ?? parsed; // support bare array too
      if (!Array.isArray(list)) throw new Error('Expected array');
      for (const a of list) {
        if (!a.patA || !a.patB || !a.w || !a.h) continue;
        addAlias({
          name:    a.name   || ('Alias ' + nextAliasId),
          w:       a.w,
          h:       a.h,
          enabled: a.enabled !== false,
          chain:   a.chain === true,
          patA:    new Uint8Array(a.patA),
          patB:    new Uint8Array(a.patB),
          phaseB:  new Float32Array(a.phaseB),
        });
      }
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function renderAliasList() {
  const list = document.getElementById('aliasList');
  list.innerHTML = '';
  if (aliases.length === 0) {
    list.innerHTML = '<div style="color:#333;font-size:10px;padding:4px 0">No aliases defined</div>';
    return;
  }
  for (const a of aliases) {
    const row = document.createElement('div');
    row.className = 'alias-row' + (a.enabled ? '' : ' disabled');
    row.innerHTML =
      `<span class="alias-name">${a.name}</span>` +
      `<span class="alias-size">${a.w}×${a.h}</span>` +
      `<button class="alias-chain ${a.chain ? 'chain-on' : ''}" data-id="${a.id}" title="Chain: fires on other alias outputs">⛓</button>` +
      `<button class="alias-edit"   data-id="${a.id}">✎</button>` +
      `<button class="alias-toggle" data-id="${a.id}">${a.enabled ? '●' : '○'}</button>` +
      `<button class="alias-del"    data-id="${a.id}">✕</button>`;
    list.appendChild(row);
  }
  list.querySelectorAll('.alias-chain').forEach(b =>
    b.addEventListener('click', () => {
      const a = aliases.find(a => a.id === +b.dataset.id);
      if (a) { a.chain = !a.chain; renderAliasList(); }
    })
  );
  list.querySelectorAll('.alias-edit').forEach(b =>
    b.addEventListener('click', () => loadAliasForEdit(+b.dataset.id))
  );
  list.querySelectorAll('.alias-toggle').forEach(b =>
    b.addEventListener('click', () => toggleAlias(+b.dataset.id))
  );
  list.querySelectorAll('.alias-del').forEach(b =>
    b.addEventListener('click', () => removeAlias(+b.dataset.id))
  );
}

// Size pickers
function initSizePickers() {
  const wSel = document.getElementById('aliasSizeW');
  const hSel = document.getElementById('aliasSizeH');
  [wSel, hSel].forEach(sel => {
    sel.innerHTML = '';
    for (let v = 1; v <= 8; v++) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (v === 4) o.selected = true;
      sel.appendChild(o);
    }
  });
  wSel.onchange = () => { editorW = +wSel.value; rebuildEditors(); };
  hSel.onchange = () => { editorH = +hSel.value; rebuildEditors(); };
}


// ── Rendering ─────────────────────────────────────────────────────────────────
let imageData = null;
let pixels    = null;

function ensureImageData() {
  if (!imageData || imageData.width !== canvas.width || imageData.height !== canvas.height) {
    imageData = ctx.createImageData(canvas.width, canvas.height);
    pixels    = imageData.data;
  }
}

function render() {
  const cs = cfg.cellSize;

  if (!cfg.bloom) {
    ensureImageData();
    pixels.fill(0);

    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const base = (x * rows + y) * 3;
        let R = 0, G = 0, B = 0;
        if (amp[base]     === 1) { R += 255 * (0.3 + 0.7 * cohCache[base]);     }
        if (amp[base + 1] === 1) { G += 255 * (0.3 + 0.7 * cohCache[base + 1]); }
        if (amp[base + 2] === 1) { B += 255 * (0.3 + 0.7 * cohCache[base + 2]); }
        if (R === 0 && G === 0 && B === 0) continue;

        const pr = R > 255 ? 255 : R | 0;
        const pg = G > 255 ? 255 : G | 0;
        const pb = B > 255 ? 255 : B | 0;
        const px0 = x * cs, py0 = y * cs;

        for (let py = py0; py < py0 + cs && py < canvas.height; py++) {
          let pi = (py * canvas.width + px0) * 4;
          for (let px = px0; px < px0 + cs && px < canvas.width; px++) {
            pixels[pi]     = pixels[pi]     + pr > 255 ? 255 : pixels[pi]     + pr;
            pixels[pi + 1] = pixels[pi + 1] + pg > 255 ? 255 : pixels[pi + 1] + pg;
            pixels[pi + 2] = pixels[pi + 2] + pb > 255 ? 255 : pixels[pi + 2] + pb;
            pixels[pi + 3] = 255;
            pi += 4;
          }
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);

  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.shadowBlur = cs * 2.2;

    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) {
        const base = (x * rows + y) * 3;
        let R = 0, G = 0, B = 0;
        if (amp[base]     === 1) { R += 255 * (0.3 + 0.7 * cohCache[base]);     }
        if (amp[base + 1] === 1) { G += 255 * (0.3 + 0.7 * cohCache[base + 1]); }
        if (amp[base + 2] === 1) { B += 255 * (0.3 + 0.7 * cohCache[base + 2]); }
        if (R === 0 && G === 0 && B === 0) continue;

        const pr = R > 255 ? 255 : R | 0;
        const pg = G > 255 ? 255 : G | 0;
        const pb = B > 255 ? 255 : B | 0;
        ctx.shadowColor = `rgb(${pr},${pg},${pb})`;
        ctx.fillStyle   = `rgb(${pr},${pg},${pb})`;
        ctx.fillRect(x * cs, y * cs, cs, cs);
      }
    }
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const elGen    = document.getElementById('generation');
const elActive = document.getElementById('activeCells');
const elChR    = document.getElementById('chR');
const elChG    = document.getElementById('chG');
const elChB    = document.getElementById('chB');
const elCohR   = document.getElementById('cohR');
const elCohG   = document.getElementById('cohG');
const elCohB   = document.getElementById('cohB');
const elWdmR   = document.getElementById('wdmR');
const elWdmG   = document.getElementById('wdmG');
const elWdmB   = document.getElementById('wdmB');

function updateStats() {
  let a0=0,a1=0,a2=0, sx0=0,sy0=0,sx1=0,sy1=0,sx2=0,sy2=0;
  const total = cols * rows;
  for (let i = 0; i < total; i++) {
    const b = i * 3;
    if (amp[b]   ===1){a0++;const p=phase[b];   sx0+=Math.cos(p);sy0+=Math.sin(p);}
    if (amp[b+1] ===1){a1++;const p=phase[b+1]; sx1+=Math.cos(p);sy1+=Math.sin(p);}
    if (amp[b+2] ===1){a2++;const p=phase[b+2]; sx2+=Math.cos(p);sy2+=Math.sin(p);}
  }
  elGen.textContent    = generation;
  elActive.textContent = a0+a1+a2;
  elChR.textContent    = a0;
  elChG.textContent    = a1;
  elChB.textContent    = a2;
  elCohR.textContent   = a0>0?(Math.sqrt(sx0*sx0+sy0*sy0)/a0).toFixed(3):'—';
  elCohG.textContent   = a1>0?(Math.sqrt(sx1*sx1+sy1*sy1)/a1).toFixed(3):'—';
  elCohB.textContent   = a2>0?(Math.sqrt(sx2*sx2+sy2*sy2)/a2).toFixed(3):'—';
  const mx = Math.max(1,a0,a1,a2);
  elWdmR.style.height = (a0/mx*100)+'%';
  elWdmG.style.height = (a1/mx*100)+'%';
  elWdmB.style.height = (a2/mx*100)+'%';
}

// ── Seed / Clear ──────────────────────────────────────────────────────────────
function randomize() {
  generation = 0;
  amp.fill(0); phase.fill(0); nextAmp.fill(0); nextPhase.fill(0); cohCache.fill(0);
  clearDirty();

  const clusterCount = Math.floor((cols * rows) / 180);
  for (let i = 0; i < clusterCount; i++) {
    const cx = Math.floor(Math.random() * cols);
    const cy = Math.floor(Math.random() * rows);
    const ph = Math.random() * TWO_PI;
    const size = 2 + Math.floor(Math.random() * 4);
    const numCh = Math.ceil(Math.random() * 3);
    const channels = [0,1,2].sort(() => Math.random()-0.5).slice(0, numCh);
    for (let dx = -size; dx <= size; dx++) {
      for (let dy = -size; dy <= size; dy++) {
        if (Math.random() < 0.45) {
          const nx = (cx+dx+cols)%cols, ny = (cy+dy+rows)%rows;
          for (const c of channels) {
            const i = idx(nx,ny,c);
            amp[i]   = 1;
            phase[i] = (ph+(Math.random()-0.5)*0.4+TWO_PI)%TWO_PI;
          }
        }
      }
    }
  }
  updateStats(); render();
}

function clearGrid() {
  generation = 0;
  amp.fill(0); phase.fill(0); nextAmp.fill(0); nextPhase.fill(0); cohCache.fill(0);
  clearDirty();
  updateStats(); render();
}

// ── Painting ──────────────────────────────────────────────────────────────────
let painting = false;
let erasing  = false;

function getCellCoords(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
  return [
    Math.floor((clientX - rect.left) * scaleX / cfg.cellSize),
    Math.floor((clientY - rect.top)  * scaleY / cfg.cellSize),
  ];
}

function paintAt(clientX, clientY) {
  const [cx, cy] = getCellCoords(clientX, clientY);
  const r = cfg.brushSize - 1;
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    const nx = (cx+dx+cols)%cols, ny = (cy+dy+rows)%rows;
    if (erasing) {
      // Erase all channels
      for (let c = 0; c < 3; c++) amp[idx(nx,ny,c)] = 0;
    } else {
      for (let c = 0; c < 3; c++) {
        if (!cfg.brushCh[c]) continue;
        const i = idx(nx,ny,c);
        amp[i]   = 1;
        phase[i] = (cfg.brushPhase + (Math.random()-0.5)*0.3 + TWO_PI) % TWO_PI;
      }
    }
  }
  render();
}

canvas.addEventListener('mousedown', e => {
  if (e.button === 2) { erasing = true; painting = true; paintAt(e.clientX, e.clientY); }
  else                { erasing = false; painting = true; paintAt(e.clientX, e.clientY); }
});
canvas.addEventListener('mousemove',  e => { if (painting) paintAt(e.clientX, e.clientY); });
canvas.addEventListener('mouseup',    () => { painting = false; erasing = false; });
canvas.addEventListener('mouseleave', () => { painting = false; erasing = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('touchstart', e => { e.preventDefault(); erasing = false; painting = true;  paintAt(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (painting) paintAt(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
canvas.addEventListener('touchend',   () => { painting = false; erasing = false; });

// ── Controls ──────────────────────────────────────────────────────────────────
document.getElementById('playButton').onclick = () => {
  cfg.isPlaying = !cfg.isPlaying;
  document.getElementById('playButton').textContent = cfg.isPlaying ? '⏸ Pause' : '▶ Play';
  if (cfg.isPlaying) loop();
};
document.getElementById('stepButton').onclick   = ()=>{cfg.isPlaying=false;document.getElementById('playButton').textContent='▶ Play';step();};
document.getElementById('randomButton').onclick  = randomize;
document.getElementById('clearButton').onclick   = clearGrid;
document.getElementById('speedSlider').oninput   = e=>{cfg.speed=+e.target.value;document.getElementById('speedValue').textContent=cfg.speed+' FPS';};
document.getElementById('sizeSlider').oninput    = e=>{cfg.cellSize=+e.target.value;document.getElementById('sizeValue').textContent=cfg.cellSize+'px';resize();allocGrids();allocDirty();allocWindowScan();randomize();};
document.getElementById('bloomToggle').onchange  = e=>{cfg.bloom=e.target.checked;render();};
document.getElementById('brushSizeSlider').oninput=e=>{cfg.brushSize=+e.target.value;document.getElementById('brushSizeValue').textContent=(cfg.brushSize*2-1)+'px';};
['R','G','B'].forEach((ch,i)=>{
  const btn=document.getElementById('ch'+ch+'Btn');
  btn.classList.toggle('active',cfg.brushCh[i]);
  btn.onclick=()=>{cfg.brushCh[i]=!cfg.brushCh[i];btn.classList.toggle('active',cfg.brushCh[i]);};
});
document.getElementById('phaseSlider').oninput=e=>{cfg.brushPhase=(+e.target.value/360)*TWO_PI;document.getElementById('phaseValue').textContent=e.target.value+'°';};

// Alias panel toggle
function setAliasPanel(open) {
  document.getElementById('aliasPanel').classList.toggle('open', open);
  document.getElementById('aliasToggleBtn').classList.toggle('active', open);
}
document.getElementById('aliasToggleBtn').onclick  = () => setAliasPanel(!document.getElementById('aliasPanel').classList.contains('open'));
document.getElementById('aliasPanelClose').onclick = () => setAliasPanel(false);

document.getElementById('aliasAddBtn').onclick    = commitAlias;
document.getElementById('aliasCancelEdit').onclick = cancelEdit;
document.getElementById('aliasExportBtn').onclick = exportAliases;
document.getElementById('aliasImportBtn').onclick = () => document.getElementById('aliasImportFile').click();
document.getElementById('aliasImportFile').onchange = e => {
  if (e.target.files[0]) importAliases(e.target.files[0]);
  e.target.value = ''; // reset so same file can be re-imported
};

// ── Resize ────────────────────────────────────────────────────────────────────
function resize() {
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  || 800;
  canvas.height = wrap.clientHeight || 600;
  cols = Math.floor(canvas.width  / cfg.cellSize);
  rows = Math.floor(canvas.height / cfg.cellSize);
}

// ── Loop ──────────────────────────────────────────────────────────────────────
let lastTime=0, accum=0;
function loop(ts=0) {
  if (!cfg.isPlaying) return;
  // Cap elapsed to 200ms — prevents spiral-of-death after tab wake
  const elapsed = Math.min(ts - lastTime, 200);
  lastTime = ts;
  accum += elapsed;
  const interval = 1000 / cfg.speed;
  while (accum >= interval) { step(); accum -= interval; }
  requestAnimationFrame(loop);
}

// ── Init ──────────────────────────────────────────────────────────────────────
cfg.brushSize = 1;

window.addEventListener('resize', ()=>{resize();allocGrids();allocDirty();allocWindowScan();randomize();});

resize();
allocGrids();
allocDirty();
allocWindowScan();
initSizePickers();
rebuildEditors();
renderAliasList();
randomize();
