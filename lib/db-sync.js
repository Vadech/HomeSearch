// Synchronisation des fichiers JSON locaux <-> Postgres (Neon free tier).
// Stratégie : les fichiers dans DATA_DIR restent la source de vérité runtime.
// - Au démarrage : on tire toutes les clés depuis Postgres et on écrit les
//   fichiers locaux (overwrite) avant que server.js ne les lise.
// - En continu : toutes les N secondes, on pousse vers Postgres les fichiers
//   modifiés (mtime > dernier upload).

const fs = require('fs');
const path = require('path');

const KEYS = [
  '.lbc-cache.json',
  '.lbc-ad-cache.json',
  '.bienici-cache.json',
  '.tram-cache.json',
  '.favorites.json',
  '.hidden-ads.json',
];

let pool = null;
const lastUploadMtime = new Map();

async function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30000,
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  return pool;
}

// Restaure les fichiers locaux depuis la DB. À appeler avant tout chargement.
async function pullFromDb(dataDir) {
  const p = await getPool();
  if (!p) return;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const key of KEYS) {
    try {
      const r = await p.query('SELECT value FROM kv_store WHERE key=$1', [key]);
      if (!r.rows.length) continue;
      const filePath = path.join(dataDir, key);
      fs.writeFileSync(filePath, JSON.stringify(r.rows[0].value), 'utf-8');
      lastUploadMtime.set(key, fs.statSync(filePath).mtimeMs);
      console.log(`[db-sync] restauré ${key} depuis Postgres`);
    } catch (e) {
      console.error(`[db-sync] pull ${key}:`, e.message);
    }
  }
}

// Pousse les fichiers modifiés vers la DB.
async function pushChanges(dataDir) {
  const p = await getPool();
  if (!p) return;
  for (const key of KEYS) {
    const filePath = path.join(dataDir, key);
    if (!fs.existsSync(filePath)) continue;
    let mtime;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch (_) { continue; }
    if (lastUploadMtime.get(key) === mtime) continue;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const value = JSON.parse(raw);
      await p.query(
        `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value]
      );
      lastUploadMtime.set(key, mtime);
      console.log(`[db-sync] poussé ${key} → Postgres`);
    } catch (e) {
      console.error(`[db-sync] push ${key}:`, e.message);
    }
  }
}

function startUploadLoop(dataDir, intervalMs = 30000) {
  if (!process.env.DATABASE_URL) return;
  setInterval(() => {
    pushChanges(dataDir).catch(e => console.error('[db-sync] loop:', e.message));
  }, intervalMs);
  // Push final au shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      try { await pushChanges(dataDir); } catch (_) {}
      process.exit(0);
    });
  }
}

module.exports = { pullFromDb, pushChanges, startUploadLoop, KEYS };
