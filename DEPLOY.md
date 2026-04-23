# Deploy Guide — push to GitHub + Netlify

One-time setup. Takes ~5 minutes.

Target site name (per Cam's request): **SFR Territory Map — Orphans**
Netlify slug suggestion: `sfr-territory-map-orphans` → https://sfr-territory-map-orphans.netlify.app

---

## Step 1 — create the GitHub repo

Go to https://github.com/new (you're already logged in as `zootsuitor`):

- **Repository name:** `sfr-territory-map`
- **Description:** `Interactive map of Superior Fence & Rail franchise territories w/ orphan ZIP detection`
- **Visibility:** Private *(recommended — contains your primary ZIP database)*
- Do **not** check "Add a README" — we already have one.
- Click **Create repository**.

On the next page, copy the HTTPS URL (should look like `https://github.com/zootsuitor/sfr-territory-map.git`).

---

## Step 2 — initialize git + push the code

Open your terminal (the always-on one in the office), then:

```powershell
cd "C:\Users\mail\Desktop\Claude Projects\360 ZIPS\sfr-territory-map"

git init -b main
git add .
git commit -m "M1 Step 2 — all 123 franchises + orphan detection"
git remote add origin https://github.com/zootsuitor/sfr-territory-map.git
git push -u origin main
```

That pushes all 7 files (428 KB total). You'll see the repo fill in on GitHub.

> **If git asks for credentials:** use your GitHub username + a Personal Access Token (Settings → Developer settings → Personal access tokens → Fine-grained → generate one with `repo` scope on `sfr-territory-map`). GitHub stopped accepting passwords for git push years ago.

---

## Step 3 — connect Netlify to the repo

1. Open https://app.netlify.com/teams/cams/sites (your `Cams` team).
2. Click **Add new site** → **Import an existing project**.
3. Choose **Deploy with GitHub** → authorize Netlify if prompted.
4. Pick the `zootsuitor/sfr-territory-map` repo.
5. Build settings:
   - **Branch to deploy:** `main`
   - **Build command:** *(leave empty)*
   - **Publish directory:** `.`
   - *(The `netlify.toml` in the repo already sets these — Netlify will auto-detect.)*
6. Click **Deploy site**.

Netlify starts the first deploy immediately. It'll finish in ~20–40 seconds since there's no build step.

---

## Step 4 — rename to the site name you want

Default Netlify slug will be something random like `resonant-otter-a1b2c3`. Change it:

1. Site dashboard → **Site configuration** → **Change site name**.
2. Enter `sfr-territory-map-orphans`.
3. Save. Live URL is now https://sfr-territory-map-orphans.netlify.app

---

## Step 5 — verify

Open the live URL. You should see:

- Map centered on the US, zoomed to your 3 franchises.
- Raleigh/Atlanta/Triad ZIPs colored red/blue/green.
- 29 bright red orphan dots in/around your territories.
- Right-side panel with 123 franchises, "Just mine" quick-filter active.
- Clicking **All** → the whole US fills in with 20,019 colored dots.
- Clicking **Only orphans** → just the 869 red dots nationwide.

---

## Future pushes

From then on, any change is:

```powershell
git add .
git commit -m "what changed"
git push
```

Netlify auto-builds on every push to `main` and the live site updates in under a minute.

---

## Privacy note

The repo contains `data/franchises.json` which has every franchise's primary ZIP list. That's internal Fence360 data. **Keep the GitHub repo private.** Even with a private repo, the deployed Netlify site is publicly accessible by URL — anyone with the URL can see the territory map. If you want password protection on the site itself, Netlify supports it under **Site configuration → Access control → Visitor access → Password protection** (paid plan feature).
