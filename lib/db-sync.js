// Persistance des données via Postgres (Neon).
// La base est la source de vérité ; les fichiers locaux ne sont qu'un backup
// occasionnel (toutes les 5 min max) au cas où la DB serait inaccessible.

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
let dataDir = null;
const pendingWrites = new Map(); // key -> latest value
let flushScheduled = false;
const lastBackupAt = new Map(); // key -> ms timestamp
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

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

function init(dir) {
  dataDir = dir;
  if (dataDir) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  }
}

// Charge une valeur : DB d'abord, fallback fichier de backup local.
async function load(key) {
  const p = await getPool();
  if (p) {
    try {
      const r = await p.query('SELECT value FROM kv_store WHERE key=$1', [key]);
      if (r.rows.length) {
        console.log(`[db-sync] ${key} chargé depuis Postgres`);
        return r.rows[0].value;
      }
    } catch (e) {
      console.error(`[db-sync] load ${key}:`, e.message);
    }
  }
  // Fallback : backup local
  if (dataDir) {
    const fp = path.join(dataDir, key);
    if (fs.existsSync(fp)) {
      try {
        const v = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        console.log(`[db-sync] ${key} chargé depuis backup local (DB indisponible)`);
        return v;
      } catch (_) {}
    }
  }
  return null;
}

// Planifie une persistance : DB immédiate (debounced 200ms), backup fichier
// au plus toutes les 5 min par clé.
function persist(key, value) {
  pendingWrites.set(key, value);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(() => { flush().catch(e => console.error('[db-sync] flush:', e.message)); }, 200);
  }
}

async function flush() {
  flushScheduled = false;
  if (!pendingWrites.size) return;
  const batch = new Map(pendingWrites);
  pendingWrites.clear();
  const p = await getPool();
  for (const [key, value] of batch) {
    const raw = JSON.stringify(value);
    if (p) {
      try {
        await p.query(
          `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [key, raw]
        );
      } catch (e) {
        console.error(`[db-sync] persist ${key}:`, e.message);
      }
    }
    // Backup local : au plus une fois toutes les 5 min par clé
    const last = lastBackupAt.get(key) || 0;
    if (dataDir && Date.now() - last > BACKUP_INTERVAL_MS) {
      try {
        fs.writeFileSync(path.join(dataDir, key), raw, 'utf-8');
        lastBackupAt.set(key, Date.now());
      } catch (e) {
        console.error(`[db-sync] backup ${key}:`, e.message);
      }
    }
  }
}

module.exports = { init, load, persist, flush, KEYS };
