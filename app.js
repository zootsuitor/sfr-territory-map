/**
 * SFR Territory Map — Milestone 1 Step 3
 *
 * Renders TRUE franchise polygon boundaries (per-ZIP, colored by franchise)
 * with hover tooltips showing ZIP + franchise. Overlays orphan ZIPs as
 * FILLED RED POLYGONS on top.
 *
 * Data files (data/):
 *   - franchises.json             — 139 franchises w/ colors + their ZIP lists
 *   - zip_centroids.json          — { "27231": [lat, lon], ... } (20,019 entries)
 *   - zcta_polygons.json          — FeatureCollection of 15,223 per-ZIP polygons tagged with franchise_id
 *   - orphans.json                — 209 orphan records (187 adjacency + 22 Raleigh purchased-unmapped)
 *   - orphan_polygons.json        — FeatureCollection of 209 per-ZIP polygons for the orphan overlay
 *
 * Orphan types:
 *   - "adjacency"           → ZIP is surrounded by a neighbor franchise's territory
 *   - "purchased_unmapped"  → ZIP is in Raleigh's purchased territory but not mapped in Fence360
 */

// ----- Config -----
const POLY_FILL_OPACITY = 0.50;
const POLY_STROKE_COLOR = '#1f2937';
// Internal ZIP seams hidden by default — stroke only shows on hover highlight
const POLY_STROKE_WEIGHT = 0;
const POLY_STROKE_OPACITY = 0;
const HOVER_STROKE_COLOR = '#111827';
const HOVER_STROKE_WEIGHT = 2;
const HOVER_FILL_OPACITY = 0.72;
// Orphan overlay — filled red polygons rendered on top
const ORPHAN_FILL_COLOR = '#ff1a1a';
const ORPHAN_FILL_OPACITY = 0.55;
const ORPHAN_STROKE_COLOR = '#7a0000';
const ORPHAN_STROKE_WEIGHT = 1.5;
const ORPHAN_STROKE_OPACITY = 0.95;
// County boundaries inside Raleigh + Triad territories.
// Color = darker shade of each franchise's territory fill.
const COUNTY_BORDER_COLORS = {
  Raleigh: '#0D47A1',  // darker than Raleigh's #1565C0 fill
  Triad:   '#1B5E20',  // darker than Triad's #43A047 fill
};
const COUNTY_BORDER_WEIGHT = 2;
const COUNTY_BORDER_HOVER_WEIGHT = 4;
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
  zctaFC: null,            // FeatureCollection of per-ZIP polygons (primary render data)
  orphans: [],             // array of orphan objects
  orphanPolygonsFC: null,  // raw FeatureCollection of orphan polygons
  myFranchiseIds: new Set(),
  layers: {},              // franchiseId -> L.GeoJSON layer (covers all that franchise's ZIPs)
  orphanLayer: null,       // L.geoJSON layer of red orphan polygons
  visible: new Set(),      // franchiseIds currently shown
  orphansVisible: true,
  orphansOnly: false,
  hoverTooltip: null,      // L.tooltip instance used for the current hover
  zipToCounty: {},         // "27330" -> {city, county, state} — loaded async from GitHub crosswalk
  countyBordersLayer: null,// L.geoJSON layer of NC county polygon outlines in Raleigh+Triad
};

// Converts "BEAR CREEK" or "bear creek" -> "Bear Creek"
function toTitle(s) {
  if (!s) return s;
  return String(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

// Async fetch the ZIP → county crosswalk so every assigned ZIP's hover tooltip
// can include city + county. Loads in background; tooltips work before it lands
// (just without the county line), and re-render after it completes.
async function loadCountyCrosswalk() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/scpike/us-state-county-zip/master/geo-data.csv');
    if (!res.ok) return {};
    const text = await res.text();
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const iZip = header.indexOf('zipcode');
    const iState = header.indexOf('state_abbr');
    const iCounty = header.indexOf('county');
    const iCity = header.indexOf('city');
    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 6) continue;
      const zip = parts[iZip].padStart(5, '0');
      if (!map[zip]) {
        map[zip] = { city: parts[iCity], county: parts[iCounty], state: parts[iState] };
      }
    }
    return map;
  } catch (e) {
    console.warn('[sfr-territory-map] county crosswalk failed to load:', e);
    return {};
  }
}

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
  // cache: 'default' lets the browser revalidate with the server instead of
  // blindly reusing a stale copy (prior `force-cache` caused color changes to
  // stick in the browser even after redeploy).
  const res = await fetch(path, { cache: 'default' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const data = await res.json();
  setLoad(pctEnd, `${label} loaded`);
  return data;
}

// ----- Boot -----
(async function init() {
  try {
    // Kick off the county crosswalk in parallel — don't block the map on it.
    const countyPromise = loadCountyCrosswalk();

    const [franchisesDoc, centroidsDoc, orphansDoc, zctaDoc, orphanPolysDoc, countiesDoc] = await Promise.all([
      loadJSON('data/franchises.json', 'franchises', 5, 10),
      loadJSON('data/zip_centroids.json', 'ZIP centroids', 10, 20),
      loadJSON('data/orphans.json', 'orphans', 20, 25),
      loadJSON('data/zcta_polygons.json', 'ZIP polygons', 25, 78),
      loadJSON('data/orphan_polygons.json', 'orphan overlay', 78, 85),
      loadJSON('data/nc_counties.json', 'NC counties', 85, 88).catch(() => null),
    ]);

    // Stash the crosswalk once it arrives (usually by now); tooltips look it up live.
    countyPromise.then(map => {
      state.zipToCounty = map;
      const n = Object.keys(map).length;
      console.log(`[sfr-territory-map] county crosswalk loaded: ${n.toLocaleString()} ZIPs`);
    });

    state.franchises = franchisesDoc.franchises;
    state.centroids = centroidsDoc;
    state.orphans = orphansDoc.orphans;
    state.zctaFC = zctaDoc;
    state.orphanPolygonsFC = orphanPolysDoc;
    state.myFranchiseIds = new Set(franchisesDoc.my_franchises);

    setLoad(88, 'Building layers…');
    await new Promise(r => setTimeout(r, 20)); // let UI breathe
    buildLayers();
    if (countiesDoc) buildCountyBorders(countiesDoc);

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

// ----- Build per-ZIP polygon layers, grouped by franchise -----
function buildLayers() {
  // Bucket features by franchise id
  const byFranchise = {};
  for (const f of state.zctaFC.features) {
    const fid = String(f.properties.franchise_id);
    (byFranchise[fid] ||= []).push(f);
  }

  // Shared hover handler — sets highlight + tooltip with ZIP, franchise, and
  // city/county (once the county crosswalk finishes loading).
  const onFeature = (feat, lyr) => {
    const p = feat.properties || {};
    const fr = state.franchises[String(p.franchise_id)] || {};
    const color = fr.color || '#666';

    const buildLocLine = () => {
      const m = state.zipToCounty[p.zip];
      if (!m) return '';
      const bits = [];
      if (m.city) bits.push(toTitle(m.city));
      if (m.county) bits.push(`${m.county} Co.${m.state ? ', ' + m.state : ''}`);
      return bits.join(' — ');
    };

    const buildTooltipHtml = () => {
      const loc = buildLocLine();
      return `<div class="zip-tip"><b>ZIP ${escapeHtml(p.zip || '?')}</b>` +
        `<span class="swatch-inline" style="background:${color}"></span>` +
        `<span class="fr">${escapeHtml(fr.name || '?')}</span>` +
        (loc ? `<div class="zip-tip-loc">${escapeHtml(loc)}</div>` : '') +
        `</div>`;
    };

    lyr.on('mouseover', (e) => {
      const t = e.target;
      t.setStyle({
        color: HOVER_STROKE_COLOR,
        weight: HOVER_STROKE_WEIGHT,
        opacity: 1,
        fillOpacity: HOVER_FILL_OPACITY,
      });
      if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) t.bringToFront();
      // Re-compute tooltip HTML on each hover so it picks up the county crosswalk
      // whenever it finishes loading.
      t.bindTooltip(buildTooltipHtml(), {
        sticky: true,
        direction: 'top',
        offset: [0, -8],
        opacity: 0.95,
        className: 'zip-hover-tip',
      }).openTooltip(e.latlng);
    });
    lyr.on('mouseout', (e) => {
      e.target.setStyle({
        color: POLY_STROKE_COLOR,
        weight: POLY_STROKE_WEIGHT,
        opacity: POLY_STROKE_OPACITY,
        fillOpacity: POLY_FILL_OPACITY,
      });
      e.target.closeTooltip();
    });
    // Click = same-info popup (persistent)
    lyr.on('click', (e) => {
      const loc = buildLocLine();
      L.popup({ offset: [0, -4] })
        .setLatLng(e.latlng)
        .setContent(
          `<b style="color:${color}">ZIP ${escapeHtml(p.zip)}</b><br>` +
          `Franchise: <b>${escapeHtml(fr.name || 'unassigned')}</b><br>` +
          (loc ? `${escapeHtml(loc)}<br>` : '') +
          (p.state ? `<span style="color:#94a3b8">${escapeHtml(p.state)}</span>` : '')
        )
        .openOn(map);
    });
  };

  let polyCount = 0;
  let emptyCount = 0;
  for (const fid of Object.keys(state.franchises)) {
    const fr = state.franchises[fid];
    const feats = byFranchise[fid];
    if (!feats || feats.length === 0) {
      // No polygon data for this franchise (all PO-box ZIPs, or zero zips).
      state.layers[fid] = L.layerGroup();
      emptyCount++;
      continue;
    }
    const layer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
      style: () => ({
        color: POLY_STROKE_COLOR,
        weight: POLY_STROKE_WEIGHT,
        opacity: POLY_STROKE_OPACITY,
        fillColor: fr.color,
        fillOpacity: POLY_FILL_OPACITY,
      }),
      onEachFeature: onFeature,
    });
    state.layers[fid] = layer;
    polyCount++;
  }
  console.log(
    `[sfr-territory-map] built ${polyCount} franchise layers from ${state.zctaFC.features.length} ZIP polygons ` +
    `(${emptyCount} franchises without polygon data)`
  );

  // Orphan overlay — FILLED RED POLYGONS rendered on top of franchise polygons.
  // Two types get the same red styling but different popup copy:
  //   - "adjacency"          → ZIP surrounded by a neighbor franchise's territory
  //   - "purchased_unmapped" → in Raleigh's purchased list but not mapped in Fence360
  const orphanLayer = L.geoJSON(state.orphanPolygonsFC, {
    style: {
      color: ORPHAN_STROKE_COLOR,
      weight: ORPHAN_STROKE_WEIGHT,
      opacity: ORPHAN_STROKE_OPACITY,
      fillColor: ORPHAN_FILL_COLOR,
      fillOpacity: ORPHAN_FILL_OPACITY,
    },
    onEachFeature: (feat, lyr) => {
      const p = feat.properties || {};
      const z = p.zip;
      // Build a location string: "City — County Co., STATE" with whatever we have.
      const st = p.state || '';
      const parts = [];
      if (p.city) parts.push(`<b>${escapeHtml(p.city)}</b>`);
      if (p.county) parts.push(`${escapeHtml(p.county)} Co.${st ? ', ' + escapeHtml(st) : ''}`);
      else if (st) parts.push(escapeHtml(st));
      const where = parts.join(' — ');
      let body, typeLabel;
      if (p.orphan_type === 'purchased_unmapped') {
        typeLabel = 'RALEIGH GAP';
        body =
          `<b style="color:${ORPHAN_FILL_COLOR}">RALEIGH GAP — ZIP ${z}</b><br>` +
          (where ? `${where}<br>` : '') +
          `In Raleigh's purchased territory but <b>not yet mapped</b> in Fence360.<br>` +
          `<em>Action: add to Raleigh's mapped territory.</em>`;
      } else if (p.orphan_type === 'unassigned') {
        typeLabel = 'UNASSIGNED';
        body =
          `<b style="color:${ORPHAN_FILL_COLOR}">UNASSIGNED — ZIP ${z}</b><br>` +
          (where ? `${where}<br>` : '') +
          `Not assigned to any SFR franchise.<br>` +
          `<em>${escapeHtml(p.surrounded_by_name || 'Open territory.')}</em>`;
      } else {
        typeLabel = 'ORPHAN';
        const cur = p.current_franchise_name || '<em>unassigned</em>';
        const vote = (p.neighbor_vote != null && p.neighbor_count != null)
          ? ` (${p.neighbor_vote}/${p.neighbor_count} adjacent polygons)` : '';
        body =
          `<b style="color:${ORPHAN_FILL_COLOR}">ORPHAN ZIP ${z}</b><br>` +
          `Surrounded by <b>${escapeHtml(p.surrounded_by_name || '?')}</b> territory${vote}<br>` +
          `Currently: ${escapeHtml(cur)}`;
      }
      lyr.bindPopup(body);
      // Hover tooltip — show ZIP, type, and city/county so Cam can identify the area at a glance
      const tipHtml =
        `<div class="zip-tip"><b style="color:${ORPHAN_FILL_COLOR}">${typeLabel} — ZIP ${escapeHtml(z)}</b>` +
        (where ? `<div class="zip-tip-loc">${where}</div>` : '') +
        `</div>`;
      lyr.bindTooltip(tipHtml, {
        sticky: true,
        direction: 'top',
        offset: [0, -8],
        opacity: 0.95,
        className: 'zip-hover-tip orphan-tip',
      });
    },
  });
  state.orphanLayer = orphanLayer;
  orphanLayer.addTo(map);
  const adj = (state.orphanPolygonsFC.features || []).filter(f => f.properties.orphan_type === 'adjacency').length;
  const gap = (state.orphanPolygonsFC.features || []).filter(f => f.properties.orphan_type === 'purchased_unmapped').length;
  console.log(`[sfr-territory-map] rendered ${adj + gap} orphan polygons (${adj} adjacency + ${gap} Raleigh gaps)`);
}

// ----- County borders inside Raleigh + Triad territories -----
// Renders each NC county polygon outline in a darker shade of its franchise's
// fill color. Hover reveals the county name and franchise.
function buildCountyBorders(fc) {
  const layer = L.geoJSON(fc, {
    style: (feat) => {
      const p = feat.properties || {};
      return {
        color: COUNTY_BORDER_COLORS[p.franchise] || '#333',
        weight: COUNTY_BORDER_WEIGHT,
        opacity: 0.85,
        fillOpacity: 0,
        lineJoin: 'round',
        lineCap: 'round',
      };
    },
    onEachFeature: (feat, lyr) => {
      const p = feat.properties || {};
      const base = COUNTY_BORDER_COLORS[p.franchise] || '#333';
      lyr.on('mouseover', (e) => {
        const t = e.target;
        t.setStyle({ color: base, weight: COUNTY_BORDER_HOVER_WEIGHT, opacity: 1 });
        t.bringToFront();
        t.bindTooltip(
          `<div class="zip-tip"><b>${escapeHtml(p.name)} County</b>` +
          `<div class="zip-tip-loc" style="color:${base}">${escapeHtml(p.franchise)} territory</div>` +
          `</div>`,
          { sticky: true, direction: 'top', offset: [0, -6], opacity: 0.95, className: 'zip-hover-tip' }
        ).openTooltip(e.latlng);
      });
      lyr.on('mouseout', (e) => {
        e.target.setStyle({ weight: COUNTY_BORDER_WEIGHT, opacity: 0.85 });
        e.target.closeTooltip();
      });
    },
  });
  state.countyBordersLayer = layer;
  layer.addTo(map);
  const n = (fc.features || []).length;
  console.log(`[sfr-territory-map] rendered ${n} NC county outlines`);
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
