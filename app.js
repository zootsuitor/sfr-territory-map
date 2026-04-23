/**
 * SFR Territory Map — Milestone 1 Step 3
 *
 * Renders TRUE franchise polygon boundaries (dissolved ZCTA outlines) instead
 * of centroid dots. Loads franchises + centroids + orphans + dissolved polygons,
 * builds one L.geoJSON layer per franchise, and highlights orphan ZIPs
 * (surrounded by contiguous territory they're not in) in bright red.
 *
 * Data files (data/):
 *   - franchises.json             — 139 franchises w/ colors + their ZIP lists
 *   - zip_centroids.json          — { "27231": [lat, lon], ... } (20,019 entries)
 *   - franchise_polygons.json     — FeatureCollection of 122 dissolved franchise outlines
 *   - orphans.json                — polygon-adjacency orphan list (187 orphans)
 *
 * Centroids are still used for orphan marker placement and zoom fallbacks for
 * franchises that have no polygon data (all PO-box only ZIPs).
 */

// ----- Config -----
const POLY_FILL_OPACITY = 0.45;
const POLY_STROKE_COLOR = '#1f2937';
const POLY_STROKE_WEIGHT = 1;
const POLY_STROKE_OPACITY = 0.7;
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
  franchises: {},          // keyed by numeric id (string form)
  centroids: {},           // "zip" -> [lat, lon]
  franchisePolygons: {},   // fid (string) -> GeoJSON Feature (Polygon/MultiPolygon/GeometryCollection)
  orphans: [],             // array of orphan objects
  myFranchiseIds: new Set(),
  layers: {},              // franchiseId -> L.GeoJSON (or L.LayerGroup for franchises w/o polygons)
  orphanLayer: null,       // L.LayerGroup of orphan markers
  visible: new Set(),      // franchiseIds currently shown
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
    const [franchisesDoc, centroidsDoc, orphansDoc, polygonsDoc] = await Promise.all([
      loadJSON('data/franchises.json', 'franchises', 5, 20),
      loadJSON('data/zip_centroids.json', 'ZIP centroids', 20, 40),
      loadJSON('data/orphans.json', 'orphans', 40, 50),
      loadJSON('data/franchise_polygons.json', 'franchise polygons', 50, 85),
    ]);

    state.franchises = franchisesDoc.franchises;
    state.centroids = centroidsDoc;
    state.orphans = orphansDoc.orphans;
    state.myFranchiseIds = new Set(franchisesDoc.my_franchises);

    // Index polygons by franchise id (string)
    for (const f of (polygonsDoc.features || [])) {
      state.franchisePolygons[String(f.properties.id)] = f;
    }

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

// ----- Build one polygon layer per franchise -----
function buildLayers() {
  let polyCount = 0;
  let emptyCount = 0;
  for (const fid of Object.keys(state.franchises)) {
    const fr = state.franchises[fid];
    const feature = state.franchisePolygons[fid];
    if (!feature || !feature.geometry) {
      // No polygon data for this franchise (all PO-box ZIPs, or zero zips).
      // Use empty LayerGroup so toggle/search still work without errors.
      state.layers[fid] = L.layerGroup();
      emptyCount++;
      continue;
    }
    const layer = L.geoJSON(feature, {
      style: {
        color: POLY_STROKE_COLOR,
        weight: POLY_STROKE_WEIGHT,
        opacity: POLY_STROKE_OPACITY,
        fillColor: fr.color,
        fillOpacity: POLY_FILL_OPACITY,
      },
      onEachFeature: (feat, lyr) => {
        const p = feat.properties || {};
        const gz = p.geom_zip_count ?? fr.zip_count;
        lyr.bindPopup(
          `<b style="color:${fr.color}">${escapeHtml(fr.name)}</b><br>` +
          `${fr.zip_count} ZIPs assigned` +
          (gz !== fr.zip_count ? ` <span style="color:#94a3b8">(${gz} with polygons)</span>` : '')
        );
      },
    });
    state.layers[fid] = layer;
    polyCount++;
  }
  console.log(
    `[sfr-territory-map] built ${polyCount} franchise polygon layers ` +
    `(${emptyCount} franchises without polygon data)`
  );

  // Orphan layer — bright red circles with white halo, rendered on top.
  // Positions come from state.centroids since orphans.json no longer stores lat/lon.
  const orphanLayer = L.layerGroup();
  let orphansPlaced = 0;
  for (const o of state.orphans) {
    const ll = state.centroids[o.zip];
    if (!ll) continue;
    const halo = L.circleMarker(ll, {
      radius: ORPHAN_RADIUS + 2,
      color: ORPHAN_HALO_COLOR,
      weight: 2,
      fillColor: ORPHAN_COLOR,
      fillOpacity: 0.0,
      renderer: canvasRenderer,
    });
    const ring = L.circleMarker(ll, {
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
      `(${o.neighbor_vote}/${o.neighbor_count} adjacent polygons)<br>` +
      `Currently: ${cur}`
    );
    orphanLayer.addLayer(halo);
    orphanLayer.addLayer(ring);
    orphansPlaced++;
  }
  state.orphanLayer = orphanLayer;
  orphanLayer.addTo(map);
  console.log(`[sfr-territory-map] placed ${orphansPlaced} orphan markers`);
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
    // Hide all franchise polygons, show only orphan layer
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

  // Prefer polygon bounds when available — more accurate than centroid cloud.
  let bounds = null;
  const layer = state.layers[fid];
  if (layer && typeof layer.getBounds === 'function') {
    try {
      const b = layer.getBounds();
      if (b && b.isValid()) bounds = b;
    } catch (e) { /* fall through to centroid fallback */ }
  }
  if (!bounds) {
    const coords = fr.zips.map(z => state.centroids[z]).filter(Boolean);
    if (!coords.length) return;
    bounds = L.latLngBounds(coords);
  }
  map.flyToBounds(bounds.pad(0.15), { duration: 0.8 });

  // turn it on if not already
  const row = document.querySelector(`.f-row[data-fid="${fid}"]`);
  if (row) {
    const cb = row.querySelector('input');
    if (!cb.checked) { cb.checked = true; toggleFranchise(fid, true); }
  }
}

function zoomToMyFranchises() {
  let bounds = null;
  for (const fid of state.myFranchiseIds) {
    const layer = state.layers[String(fid)];
    if (layer && typeof layer.getBounds === 'function') {
      try {
        const b = layer.getBounds();
        if (b && b.isValid()) {
          bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
        }
      } catch (e) { /* ignore */ }
    }
  }
  if (!bounds) {
    // fallback: centroids
    const coords = [];
    for (const fid of state.myFranchiseIds) {
      const fr = state.franchises[String(fid)];
      if (!fr) continue;
      for (const z of fr.zips) {
        const ll = state.centroids[z];
        if (ll) coords.push(ll);
      }
    }
    if (coords.length) bounds = L.latLngBounds(coords);
  }
  if (bounds) map.fitBounds(bounds.pad(0.1));
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
