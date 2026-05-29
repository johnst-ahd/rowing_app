# Postgres setup (Vercel / Neon)

The rowing app needs a database so phone uploads and the PC monitor share the same data. Without `POSTGRES_URL`, ingest can succeed on the phone but the dashboard stays empty.

**You do this once in the Vercel website** (about 5 minutes). Tables are created automatically on the first upload — you do not need to run SQL unless you want to.

---

## Step 1 — Open the correct Vercel project

1. Go to [https://vercel.com/dashboard](https://vercel.com/dashboard)
2. Open the project that deploys **rowing-app-recorder-pwa**
   - Usually linked to GitHub repo `rowing_app`
   - **Root Directory** must be `apps/recorder-pwa` (Project → Settings → General)

---

## Step 2 — Create Postgres

1. In the project, click **Storage** (top menu)
2. Click **Create Database**
3. Choose **Postgres** (powered by **Neon** on current Vercel)
4. Name it e.g. `rnz-rowing` → region closest to you (e.g. Sydney) → **Create**

---

## Step 3 — Connect database to the project

1. After creation, choose **Connect Project**
2. Select the **rowing-app-recorder-pwa** project (same project as step 1)
3. Environments: enable **Production** and **Preview** → **Connect**

Vercel adds environment variables automatically, including:

- `POSTGRES_URL` ← **required** (the app uses this)
- `POSTGRES_URL_NON_POOLING` (optional backup)
- Others from Neon (safe to leave as-is)

### Storage quota on the dashboard (optional)

The monitor **Database storage** bar shows **Used**, **Available**, and **Total** when a quota is set.

1. **Settings** → **Environment Variables** → add:
   - **Name:** `POSTGRES_STORAGE_LIMIT_MB`
   - **Value:** `512` (matches typical Neon free tier; change if your plan differs)
2. Or rely on the project default in `apps/recorder-pwa/vercel.json` (`512`).

Redeploy after changing env vars.

---

## Step 4 — Redeploy

1. **Deployments** tab → latest deployment → **⋯** → **Redeploy**
2. Or push any commit to `main` on GitHub

New serverless runs only pick up new env vars after a redeploy.

---

## Step 5 — Verify

### A. Ping API

Open in a browser:

```
https://rowing-app-recorder-pwa.vercel.app/api/ping
```

Expected:

```json
{
  "ok": true,
  "service": "rowing-recorder",
  "persisted": true,
  "storage": "postgres"
}
```

If `"persisted": false`, the database is not linked yet — repeat steps 2–4.

### B. Phone + monitor

1. Phone **Settings**:
   - Ingest URL: `https://rowing-app-recorder-pwa.vercel.app/api/ingest`
   - Device ID: e.g. `CREW-01`
   - Ingest token: same as Vercel `INGEST_TOKEN` if you use one
2. **Start session** for 30+ seconds
3. PC: [dashboard](https://rowing-app-recorder-pwa.vercel.app/dashboard.html) → device should appear within a few seconds

### C. Ingest response (optional)

After upload, the API returns `"persisted": true` when Postgres is working.

---

## Optional — run schema manually

Only if you want to inspect tables early. In Vercel:

**Storage** → your database → **Query** tab → paste contents of `scripts/schema.sql` → Run.

Normally **skip this** — `api/lib/db.js` runs `CREATE TABLE IF NOT EXISTS` on first ingest.

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| `persisted: false` on `/api/ping` | DB not connected or not redeployed after adding Storage |
| Monitor empty, phone log OK | Postgres not enabled (see above) |
| `401` on dashboard | Match **Ingest token** to Vercel `INGEST_TOKEN` |
| Overlay RNZ mode 503 | On **traccar-overlay** project set `ROWING_TRACKER_URL` + redeploy |

---

## traccar-overlay (maps / history)

On the **traccar-overlay** Vercel project (separate from rowing app):

```
ROWING_TRACKER_URL=https://rowing-app-recorder-pwa.vercel.app
ROWING_INGEST_TOKEN=<same as INGEST_TOKEN if used>
```

Redeploy overlay after adding env vars.

---

## Local development (optional)

1. Create a free database at [https://neon.tech](https://neon.tech)
2. Copy the connection string
3. In `apps/recorder-pwa`, create `.env.local` (do not commit):

```
POSTGRES_URL=postgresql://user:pass@host/db?sslmode=require
```

4. `npm run dev` in the monorepo — ingest uses Neon from your machine
