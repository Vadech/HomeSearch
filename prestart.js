// Tire les fichiers JSON depuis Postgres (Neon) vers DATA_DIR avant le boot
// du serveur. No-op si DATABASE_URL n'est pas défini.

const dbSync = require('./lib/db-sync');

const DATA_DIR = process.env.DATA_DIR || __dirname;

(async () => {
  try {
    await dbSync.pullFromDb(DATA_DIR);
  } catch (e) {
    console.error('[prestart] erreur pull DB:', e.message);
  } finally {
    process.exit(0);
  }
})();
