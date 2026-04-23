# SFR Territory Map

Interactive map of Superior Fence & Rail franchise territories across the United States. Shows ZIP-code coverage, color-coded by franchise, with toggleable visibility and orphan-ZIP detection.

**Status:** Milestone 1 Step 2 — all 123 franchises w/ ZIPs rendered as color-coded centroid dots, orphan ZIPs highlighted bright red.

## What you see

- **20,019 ZIP centroid dots** — each ZIP in Fence360's primary-territory database, one dot per ZIP, colored by its assigned franchise.
- **123 distinct franchise colors** — Cam's 3 get brand colors (Raleigh red, Atlanta blue, Triad green); the rest get a golden-angle HSL sweep for maximum visual separation.
- **869 orphan ZIPs** in bright red — ZIPs where ≥ 6 of the 8 nearest neighbors belong to a single franchise, but the ZIP itself is **not** on that franchise's list. Either the ZIP is unassigned (gap they should fill) or assigned to the "wrong" franchise (island).
- **Control panel (right)** — list of all franchises with checkboxes, color swatches, ZIP counts, per-franchise orphan count, search (by name or ZIP), and "Zoom" buttons that fly to a franchise's bbox.
- **Quick filters** — All / None / Just mine / Only orphans.

## Milestones

| # | Goal | Status |
|---|------|--------|
| M1 Step 1 | Map scaffold, HQ markers | ✅ done |
| M1 Step 2 | Full 123-franchise rendering + orphan detection | ✅ this push |
| M1 Step 3 | Upgrade centroid dots → dissolved polygon boundaries (needs ZCTA polygon data) | pending |
| M1 Step 4 | GitHub repo + Netlify auto-deploy | pending |
| M2 | More control-panel polish (groups, sort, export selected ZIPs) | pending |
| M3 | Search, filter, "go to franchise" quick-jump (partially done in M1S2) | pending |
| M4+ | Data refresh pipeline pulling live from Fence360 | pending |

## Why centroids and not polygons?

Rendering *true* ZCTA polygons for 20,043 ZIPs requires ~50 MB of polygon data from the US Census. That data isn't reachable from the build sandbox right now — so for Step 2, we use ZIP **centroids** (one lat/lon per ZIP, bundled from the `us-zips` and `zipcodes` npm packages, 99.9 % coverage).

This gives you the same *territorial information* at a fraction of the weight. Step 3 will upgrade the centroid dots to dissolved polygon outlines once we have a polygon source.

## Orphan detection: how it works

An "orphan" ZIP is defined as:

> A ZIP whose nearest neighbors are overwhelmingly in one franchise's territory, but the ZIP itself isn't.

Server-side, we build a KD-tree over all ~42,560 US ZIP centroids and ask, for each ZIP, "how many of your 8 nearest neighbors belong to the same franchise?" If ≥ 6 do, and this ZIP isn't on that franchise's list, it gets flagged.

This is a **proxy for true polygon adjacency**. It works well in densely-populated urban areas (dense ZIP coverage ≈ close centroid spacing ≈ actual adjacency). It's noisier in rural areas where centroids can be far apart. Step 3 will rerun the detector against real polygon adjacency.

Output (`data/orphans.json`): 869 orphans nationwide, 29 within Cam's 3 franchise territories. For Raleigh/Triad specifically, the orphans overlap ~20 of the 22 "missing Raleigh ZIPs" from the earlier gap analysis — independent corroboration.

## Local dev

Just a static HTML file — open `index.html` in any browser, or run a tiny local server:

```bash
# Python 3
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

Auto-deploys to Netlify on push to `main`. Site: _(pending Step 4)_.

## Data sources

- `data/franchises.json` — franchise metadata, colors, and ZIP assignments. Built from `Primary_ZIPs_All_Franchises.xlsx` which was assembled from two Fence360 endpoints:
  - `GET /x/v2/zipcode/` — logged-in franchise's primary ZIPs
  - `GET /x/admin/v2/franchise/other-zip-codes` — all other franchises' primary ZIPs
- `data/zip_centroids.json` — ZIP → [lat, lon] for our 20,019 assigned ZIPs. Source: `us-zips` + `zipcodes` npm packages merged.
- `data/orphans.json` — pre-computed orphan list (KD-tree KNN, k=8, threshold ≥6).

## Files

```
sfr-territory-map/
├── index.html            # page shell, Leaflet + CSS
├── app.js                # map bootstrap, loaders, panel, orphan rendering
├── netlify.toml          # static-site config (no build step)
├── .gitignore
├── README.md             # this file
└── data/
    ├── franchises.json
    ├── zip_centroids.json
    └── orphans.json
```
