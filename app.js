/**
 * SFR Territory Map — Milestone 1 Step 2
 *
 * Loads franchises + ZIP centroids + orphans, renders all 20K ZIPs on a Leaflet
 * canvas, provides a control panel to toggle franchises, and highlights orphan
 * ZIPs (surrounded by contiguous territory they're not in) in bright red.
 *
 * Data files (data/):
 *   - franchises.json       — 139 franchises w/ colors + their ZIP lists
 *   - zip_centroids.json    — { "27231": [lat, lon], ... } for the 20,019 assigned ZIPs
 *   - orphans.json          — pre-computed KNN-based orphan list
 *
 * Polygon boundaries (dissolved franchise outlines + per-ZIP polygons) come in
 * Step 3 when we have ZCTA polygon data. For now we use centroid circles — same
 * territorial information, much lighter.
 */

// ----- Config -----
const ZIP_DOT_RADIUS = 3.5;        // base circle radius in screen px
const ZIP_DOT_OPACITY = 0.72;
const ORPHAN_RADIUS = 7;
const ORPHAN_COLOR = '#ff1a1a';
const ORPHAN_HALO_COLOR = '#ffffff';
const INITIAL_CENTER = [37.5, -96]; // continental US center
const INITIAL_ZOOM = 4;

// ----- Map bootstrap -----
const canvasRenderer = L.canvas({ padding: 0.5 });
const map = L.map('map', {
  center: INITIAL_CENTER,
  zoom: INITIAL_ZOOM,
  zoomControl: true,
  preferCanvas: true,
  renderer: canvasRenderer,
});

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

// ----- State -----
const state = {
  franchises: {},       // keyed by numeric id (string form)
  centroids: {},        // "zip" -> [lat, lon]
  orphans: [],          // array of orphan objects
  myFranchiseIds: new Set(),
  layers: {},           // franchiseId -> L.LayerGroup of zip circles
  orphanLayer: null,    // L.LayerGroup of orphan markers
  visible: new Set(),   // franchiseIds currently shown
  orphansVisible: true,
  orphansOnly: false,
};

// ----- Loading UI -----
const loadBar = document.getElementById('load-bar');
const loadStatus = document.getElementById('load-status');
function setLoad(pct, msg) {
  loadBar.style.width = pct + '%';
  if (msg) loadStatus.textContent = msg;
}
function hideLoader() {
  const el = document.getElementById('loading');
  el.style.transition = 'opacity 200ms';
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 220);
}

async function loadJSON(path, label, pctStart, pctEnd) {
  setLoad(pctStart, `Loading ${label}…`);
  const res = await fetch(path, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const data = await res.json();
  setLoad(pctEnd, `${label} loaded`);
  return data;
}

// ----- Boot -----
(async function init() {
  try {
    const [franchisesDoc, centroidsDoc, orphansDoc] = await Promise.all([
      loadJSON('data/franchises.json', 'franchises', 5, 35),
      loadJSON('data/zip_centroids.json', 'ZIP centroids', 35, 70),
      loadJSON('data/orphans.json', 'orphans', 70, 85),
    ]);

    state.franchises = franchisesDoc.franchises;
    state.centroids = centroidsDoc;
    state.orphans = orphansDoc.orphans;
    state.myFranchiseIds = new Set(franchisesDoc.my_franchises);

    setLoad(88, 'Building layers…');
    await new Promise(r => setTimeout(r, 20)); // let UI breathe
    buildLayers();

    setLoad(95, 'Building control panel…');
    await new Promise(r => setTimeout(r, 20));
    buildPanel();
    setHeaderStats(franchisesDoc.counts, orphansDoc.counts);

    setLoad(100, 'Ready');
    setTimeout(hideLoader, 150);

    // default view: Cam's 3 franchises only
    applyQuickFilter('mine');
  } catch (err) {
    console.error(err);
    loadStatus.textContent = 'Load failed: ' + err.message;
  }
})();

// ----- Build one canvas layer per franchise -----
function buildLayers() {
  const zipToFr = {};
  for (const [fid, data] of Object.entries(state.franchises)) {
    for (const z of data.zips) zipToFr[z] = fid;
    state.layers[fid] = L.layerGroup();
  }

  // Add a circle per assigned ZIP to its franchise's layer
  let placed = 0;
  for (const [zip, ll] of Object.entries(state.centroids)) {
    const fid = zipToFr[zip];
    if (!fid) continue;
    const fr = state.franchises[fid];
    const marker = L.circleMarker(ll, {
      radius: ZIP_DOT_RADIUS,
      color: '#1f2937',
      weight: 0.3,
      fillColor: fr.color,
      fillOpacity: ZIP_DOT_OPACITY,
      renderer: canvasRenderer,
    });
    marker.bindPopup(`<b>ZIP ${zip}</b><br><span style="color:${fr.color}; font-weight:600;">${escapeHtml(fr.name)}</span>`);
    state.layers[fid].addLayer(marker);
    placed++;
  }
  console.log(`[sfr-territory-map] placed ${placed} ZIP circles across ${Object.keys(state.layers).length} franchises`);

  // Orphan layer — bright red circles with white halo, rendered on top
  const orphanLayer = L.layerGroup();
  for (const o of state.orphans) {
    const halo = L.circleMarker([o.lat, o.lon], {
      radius: ORPHAN_RADIUS + 2,
      color: ORPHAN_HALO_COLOR,
      weight: 2,
      fillColor: ORPHAN_COLOR,
      fillOpacity: 0.0,
      renderer: canvasRenderer,
    });
    const ring = L.circleMarker([o.lat, o.lon], {
      radius: ORPHAN_RADIUS,
      color: ORPHAN_COLOR,
      weight: 2.5,
      fillColor: ORPHAN_COLOR,
      fillOpacity: 0.35,
      renderer: canvasRenderer,
    });
    const cur = o.current_franchise_name || '<em>unassigned</em>';
    ring.bindPopup(
      `<b style="color:${ORPHAN_COLOR}">ORPHAN ZIP ${o.zip}</b><br>` +
      `Surrounded by <b>${escapeHtml(o.surrounded_by_name)}</b> territory ` +
      `(${o.neighbor_vote}/${o.k} nearest neighbors)<br>` +
      `Currently: ${cur}`
    );
    orphanLayer.addLayer(halo);
    orphanLayer.addLayer(ring);
  }
  state.orphanLayer = orphanLayer;
  orphanLayer.addTo(map);
  console.log(`[sfr-territory-map] placed ${state.orphans.length} orphan markers`);
}

// ----- Build the right-side control panel -----
function buildPanel() {
  const list = document.getElementById('franchise-list');
  const franchisesByName = Object.values(state.franchises).sort((a, b) => {
    // Mine first, then by zip count desc, then by name
    const am = state.myFranchiseIds.has(a.id) ? 0 : 1;
    const bm = state.myFranchiseIds.has(b.id) ? 0 : 1;
    if (am !== bm) return am - bm;
    if (b.zip_count !== a.zip_count) return b.zip_count - a.zip_count;
    return a.name.localeCompare(b.name);
  });

  // orphan count by franchise
  const orphansBySurround = {};
  for (const o of state.orphans) {
    orphansBySurround[o.surrounded_by_id] = (orphansBySurround[o.surrounded_by_id] || 0) + 1;
  }

  const frag = document.createDocumentFragment();
  for (const fr of franchisesByName) {
    if (fr.zip_count === 0) continue;  // skip empty franchises
    const row = document.createElement('label');
    row.className = 'f-row' + (state.myFranchiseIds.has(fr.id) ? ' mine' : '');
    row.dataset.fid = fr.id;
    row.dataset.name = fr.name.toLowerCase();
    row.dataset.zips = fr.zips.join(',');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.addEventListener('change', () => toggleFranchise(fr.id, cb.checked));

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = fr.color;

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = fr.name;
    const orphanCount = orphansBySurround[fr.id] || 0;
    if (orphanCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'orphan-badge';
      badge.textContent = ` ${orphanCount} orphans`;
      name.appendChild(badge);
    }

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = fr.zip_count.toLocaleString();

    const zoom = document.createElement('button');
    zoom.className = 'zoom-btn';
    zoom.textContent = 'Zoom';
    zoom.type = 'button';
    zoom.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      zoomToFranchise(fr.id);
    });

    row.appendChild(cb);
    row.appendChild(sw);
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(zoom);
    frag.appendChild(row);
  }
  list.appendChild(frag);

  document.getElementById('panel-count').textContent =
    `(${franchisesByName.filter(f => f.zip_count > 0).length} w/ ZIPs)`;

  // Bulk filter buttons
  document.getElementById('btn-all').addEventListener('click', () => applyQuickFilter('all'));
  document.getElementById('btn-none').addEventListener('click', () => applyQuickFilter('none'));
  document.getElementById('btn-mine').addEventListener('click', () => applyQuickFilter('mine'));
  document.getElementById('btn-orphans-only').addEventListener('click', () => applyQuickFilter('orphans'));

  // Search box
  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const isZipQuery = /^\d{2,5}$/.test(q);
    list.querySelectorAll('.f-row').forEach(row => {
      if (!q) { row.style.display = ''; return; }
      if (isZipQuery) {
        row.style.display = row.dataset.zips.includes(q) ? '' : 'none';
      } else {
        row.style.display = row.dataset.name.includes(q) ? '' : 'none';
      }
    });
  });
}

function setActiveQuickBtn(id) {
  ['btn-all', 'btn-none', 'btn-mine', 'btn-orphans-only']
    .forEach(b => document.getElementById(b).classList.remove('active'));
  if (id) document.getElementById(id).classList.add('active');
}

function applyQuickFilter(kind) {
  const list = document.getElementById('franchise-list');
  const rows = list.querySelectorAll('.f-row');

  if (kind === 'orphans') {
    // Hide all franchise circles, show only orphan layer
    rows.forEach(row => {
      const cb = row.querySelector('input');
      cb.checked = false;
      toggleFranchise(row.dataset.fid, false, { deferOrphanReseat: true, quiet: true });
    });
    state.orphansOnly = true;
    setOrphanVisibility(true);
    reseatOrphansOnTop();
    setActiveQuickBtn('btn-orphans-only');
    return;
  }

  state.orphansOnly = false;
  setOrphanVisibility(true);

  const setTo = (row, on) => {
    const cb = row.querySelector('input');
    if (cb.checked !== on) {
      cb.checked = on;
      toggleFranchise(row.dataset.fid, on, { deferOrphanReseat: true, quiet: true });
    }
  };

  if (kind === 'all') rows.forEach(r => setTo(r, true));
  else if (kind === 'none') rows.forEach(r => setTo(r, false));
  else if (kind === 'mine') {
    rows.forEach(r => {
      const fid = parseInt(r.dataset.fid, 10);
      setTo(r, state.myFranchiseIds.has(fid));
    });
  }
  reseatOrphansOnTop();
  setActiveQuickBtn('btn-' + kind);

  // After "mine", zoom to the union of mine
  if (kind === 'mine') zoomToMyFranchises();
}

function toggleFranchise(fid, on, opts = {}) {
  const layer = state.layers[fid];
  if (!layer) return;
  if (on && !state.visible.has(fid)) {
    layer.addTo(map);
    state.visible.add(fid);
  } else if (!on && state.visible.has(fid)) {
    map.removeLayer(layer);
    state.visible.delete(fid);
  }
  // Unless caller asks us to defer (batch mode), re-seat orphans on top.
  if (!opts.deferOrphanReseat) reseatOrphansOnTop();
  if (!opts.quiet) setActiveQuickBtn(null);  // user edit breaks the quick-filter
}

function reseatOrphansOnTop() {
  if (state.orphanLayer && map.hasLayer(state.orphanLayer)) {
    map.removeLayer(state.orphanLayer);
    state.orphanLayer.addTo(map);
  }
}

function setOrphanVisibility(on) {
  if (!state.orphanLayer) return;
  if (on && !map.hasLayer(state.orphanLayer)) state.orphanLayer.addTo(map);
  else if (!on && map.hasLayer(state.orphanLayer)) map.removeLayer(state.orphanLayer);
}

function zoomToFranchise(fid) {
  const fr = state.franchises[fid];
  if (!fr) return;
  const coords = fr.zips
    .map(z => state.centroids[z])
    .filter(Boolean);
  if (!coords.length) return;
  const bounds = L.latLngBounds(coords);
  map.flyToBounds(bounds.pad(0.15), { duration: 0.8 });

  // turn it on if not already
  const row = document.querySelector(`.f-row[data-fid="${fid}"]`);
  if (row) {
    const cb = row.querySelector('input');
    if (!cb.checked) { cb.checked = true; toggleFranchise(fid, true); }
  }
}

function zoomToMyFranchises() {
  const coords = [];
  for (const fid of state.myFranchiseIds) {
    const fr = state.franchises[fid];
    if (!fr) continue;
    for (const z of fr.zips) {
      const ll = state.centroids[z];
      if (ll) coords.push(ll);
    }
  }
  if (coords.length) {
    map.fitBounds(L.latLngBounds(coords).pad(0.1));
  }
}

function setHeaderStats(counts, orphanCounts) {
  const total = counts.zips.toLocaleString();
  const withZips = counts.franchises_with_zips;
  const orphans = orphanCounts.orphans;
  const mine = state.myFranchiseIds.size;
  const stats = document.getElementById('header-stats');
  stats.innerHTML =
    `<span class="pill">${withZips} franchises</span>` +
    `<span class="pill">${total} ZIPs</span>` +
    `<span class="pill mine">${mine} mine</span>` +
    `<span class="pill orphan">${orphans} orphans</span>`;
}

// ----- utilities -----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
