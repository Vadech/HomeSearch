const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const dbSync = require('./lib/db-sync');
const app = express();
const PORT = process.env.PORT || 3000;

// Répertoire de backup local (Postgres = source de vérité, fichiers = filet de sécurité).
const DATA_DIR = process.env.DATA_DIR || __dirname;
dbSync.init(DATA_DIR);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Client HTTP pour Leboncoin (got-scraping pour le fingerprint TLS Chrome) ---
let gotScraping;
const gotReady = import('got-scraping').then(m => { gotScraping = m.gotScraping; });

const LBC_HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Origin': 'https://www.leboncoin.fr',
  'Referer': 'https://www.leboncoin.fr/',
  'api_key': 'ba0c2dad52b3ec',
  'Content-Type': 'application/json',
};

// --- Geo API: recherche de communes ---
app.get('/api/communes', async (req, res) => {
  try {
    const { nom, lat, lon, codePostal, limit = 10 } = req.query;
    const params = { limit, fields: 'nom,code,codesPostaux,population,centre,contour,codeDepartement' };

    if (nom) params.nom = nom;
    if (lat && lon) { params.lat = lat; params.lon = lon; }
    if (codePostal) params.codePostal = codePostal;

    const { data } = await axios.get('https://geo.api.gouv.fr/communes', { params });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la recherche de communes', details: err.message });
  }
});

// --- Geo API: contour d'une commune ---
app.get('/api/communes/:code/contour', async (req, res) => {
  try {
    const { data } = await axios.get(
      `https://geo.api.gouv.fr/communes/${req.params.code}`,
      { params: { fields: 'nom,code,contour', format: 'geojson', geometry: 'contour' } }
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erreur contour commune', details: err.message });
  }
});

// --- DVF: transactions immobilières via fichiers CSV data.gouv.fr ---
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] || ''; });
    return obj;
  });
}

app.get('/api/dvf', async (req, res) => {
  try {
    const { code_commune, annee_min, annee_max } = req.query;
    if (!code_commune) return res.status(400).json({ error: 'code_commune requis' });

    const dep = code_commune.startsWith('97') ? code_commune.slice(0, 3) : code_commune.slice(0, 2);
    const minYear = Number(annee_min) || 2022;
    const maxYear = Number(annee_max) || new Date().getFullYear();

    const allMutations = [];

    for (let year = minYear; year <= maxYear; year++) {
      const url = `https://files.data.gouv.fr/geo-dvf/latest/csv/${year}/communes/${dep}/${code_commune}.csv`;
      try {
        const { data } = await axios.get(url, { responseType: 'text', timeout: 10000 });
        const rows = parseCSV(data);
        for (const row of rows) {
          const valeur = parseFloat(row.valeur_fonciere);
          const surface = parseFloat(row.surface_reelle_bati);
          if (!valeur || !surface) continue;
          allMutations.push({
            id_mutation: row.id_mutation,
            date_mutation: row.date_mutation,
            nature_mutation: row.nature_mutation,
            valeur_fonciere: valeur,
            adresse_numero: row.adresse_numero,
            adresse_nom_voie: row.adresse_nom_voie,
            code_postal: row.code_postal,
            nom_commune: row.nom_commune,
            code_commune: row.code_commune,
            type_local: row.type_local,
            surface_reelle_bati: surface,
            nombre_pieces_principales: parseInt(row.nombre_pieces_principales) || null,
            longitude: parseFloat(row.longitude) || null,
            latitude: parseFloat(row.latitude) || null,
          });
        }
      } catch (e) {
        // Fichier inexistant pour cette année/commune — on continue
      }
    }

    // Dédupliquer par id_mutation (garder uniquement les locaux principaux)
    const seen = new Set();
    const unique = allMutations.filter(m => {
      if (m.nature_mutation !== 'Vente') return false;
      if (!m.type_local || m.type_local === 'Dépendance') return false;
      const key = m.id_mutation + '_' + m.type_local;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Trier par date décroissante
    unique.sort((a, b) => b.date_mutation.localeCompare(a.date_mutation));

    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: 'Erreur DVF', details: err.message });
  }
});

// --- Leboncoin: appels API directs (sans Puppeteer) ---

// Cache des annonces Leboncoin — persisté via Postgres (db-sync)
const lbcCache = new Map();
function saveCache() {
  dbSync.persist('.lbc-cache.json', Object.fromEntries(lbcCache));
}

// --- Helpers filtres ---
function parseFilterParams(query) {
  const minPrice = query.min_price ? Number(query.min_price) : null;
  const maxPrice = query.max_price ? Number(query.max_price) : null;
  const minSurface = query.min_surface ? Number(query.min_surface) : null;
  const maxSurface = query.max_surface ? Number(query.max_surface) : null;
  const propertyTypes = query.property_types
    ? String(query.property_types).split(',').map(s => s.trim()).filter(Boolean)
    : ['house', 'flat'];
  return { minPrice, maxPrice, minSurface, maxSurface, propertyTypes };
}

function filterCacheSuffix(f) {
  return [
    f.minPrice ?? '',
    f.maxPrice ?? '',
    f.minSurface ?? '',
    f.maxSurface ?? '',
    (f.propertyTypes || []).join('+'),
  ].join('-');
}

app.get('/api/leboncoin', async (req, res) => {
  const { city, zipcode, department_id, lat, lng, refresh } = req.query;
  const filters = parseFilterParams(req.query);

  const baseKey = city ? `${city}_${zipcode}` : (zipcode || department_id || 'all');
  const cacheKey = `${baseKey}|${filterCacheSuffix(filters)}`;

  if (!refresh && lbcCache.has(cacheKey)) {
    const cached = lbcCache.get(cacheKey);
    return res.json({ ...cached, fromCache: true });
  }

  try {
    // Mapper nos types vers les codes LBC
    const lbcTypeMap = { house: '1', flat: '2' };
    const realEstateTypes = (filters.propertyTypes || [])
      .map(t => lbcTypeMap[t])
      .filter(Boolean);

    const ranges = {};
    if (filters.minPrice != null || filters.maxPrice != null) {
      ranges.price = {};
      if (filters.minPrice != null) ranges.price.min = filters.minPrice;
      if (filters.maxPrice != null) ranges.price.max = filters.maxPrice;
    }
    if (filters.minSurface != null || filters.maxSurface != null) {
      ranges.square = {};
      if (filters.minSurface != null) ranges.square.min = filters.minSurface;
      if (filters.maxSurface != null) ranges.square.max = filters.maxSurface;
    }

    // Construire la requête pour l'API Leboncoin
    const body = {
      limit: 50,
      limit_alu: 3,
      filters: {
        category: { id: '9' },  // Ventes immobilières
        enums: {
          real_estate_type: realEstateTypes.length ? realEstateTypes : ['1', '2'],
          ad_type: ['offer'],
        },
        ranges,
        location: {},
        keywords: {},
      },
      sort_by: 'time',
      sort_order: 'desc',
    };

    // Géolocalisation
    if (city && zipcode && lat && lng) {
      body.filters.location = {
        locations: [{
          city: city,
          zipcode: zipcode,
          locationType: 'city',
          lat: parseFloat(lat),
          lng: parseFloat(lng),
          radius: 5000,
        }],
      };
    } else if (department_id) {
      body.filters.location = {
        locations: [{
          department_id: department_id,
          locationType: 'department',
        }],
      };
    }

    await gotReady;
    const response = await gotScraping.post({
      url: 'https://api.leboncoin.fr/finder/search',
      headers: LBC_HEADERS,
      json: body,
      responseType: 'json',
      headerGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['macos'] },
      timeout: { request: 15000 },
    });

    const result = response.body;
    const ads = result.ads || [];

    if (ads.length > 0) {
      const data = { total: result.total || ads.length, ads, fetchedAt: new Date().toISOString() };
      lbcCache.set(cacheKey, data);
      saveCache();
      console.log(`[LBC API] ${refresh ? 'Refresh' : 'Fetch'} OK: ${ads.length} annonces pour ${cacheKey}`);
      res.json(data);
    } else if (lbcCache.has(cacheKey)) {
      console.log(`[LBC API] Aucun résultat, retour du cache pour ${cacheKey}`);
      const cached = lbcCache.get(cacheKey);
      res.json({ ...cached, fromCache: true, refreshFailed: true });
    } else {
      console.log('[LBC API] Aucune annonce trouvée');
      res.json({ total: 0, ads: [] });
    }
  } catch (err) {
    console.error('[LBC API] Erreur:', err.response?.statusCode, err.message);
    if (lbcCache.has(cacheKey)) {
      const cached = lbcCache.get(cacheKey);
      return res.json({ ...cached, fromCache: true, refreshFailed: true });
    }
    res.status(500).json({ error: 'Erreur API Leboncoin', details: err.message });
  }
});

// --- Leboncoin: détail d'une annonce via API ---
const adCacheStore = new Map();
function saveAdCache() {
  dbSync.persist('.lbc-ad-cache.json', Object.fromEntries(adCacheStore));
}

app.get('/api/leboncoin/ad', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url requis' });

  if (adCacheStore.has(url)) {
    return res.json(adCacheStore.get(url));
  }

  try {
    // Extraire l'ID de l'annonce depuis l'URL (ex: /ad/ventes_immobilieres/12345678.htm)
    const match = url.match(/(\d{6,})\.htm/);
    if (!match) {
      return res.status(400).json({ error: 'ID annonce introuvable dans l\'URL' });
    }

    const adId = match[1];
    await gotReady;
    const response = await gotScraping({
      url: `https://api.leboncoin.fr/finder/classified/${adId}`,
      headers: LBC_HEADERS,
      responseType: 'json',
      headerGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['macos'] },
      timeout: { request: 15000 },
    });

    const ad = response.body;
    const adData = {
      body: ad.body || '',
      attributes: ad.attributes || [],
      subject: ad.subject || '',
    };

    adCacheStore.set(url, adData);
    saveAdCache();
    res.json(adData);
  } catch (err) {
    console.error('[LBC API] Erreur détail:', err.response?.statusCode, err.message);
    res.json({ body: '', attributes: [], error: 'Impossible de charger le détail' });
  }
});

// --- Bien'ici: API JSON directe ---
const bieniciCache = new Map();
function saveBieniciCache() {
  dbSync.persist('.bienici-cache.json', Object.fromEntries(bieniciCache));
}

app.get('/api/bienici', async (req, res) => {
  const { city, zipcode, refresh } = req.query;
  const userFilters = parseFilterParams(req.query);
  const baseKey = city ? `${city}_${zipcode}` : (zipcode || 'all');
  const cacheKey = `${baseKey}|${filterCacheSuffix(userFilters)}`;

  if (!refresh && bieniciCache.has(cacheKey)) {
    return res.json({ ...bieniciCache.get(cacheKey), fromCache: true });
  }

  try {
    // Résoudre le zoneId via l'API suggest
    const suggestRes = await axios.get(`https://res.bienici.com/suggest.json?q=${encodeURIComponent(city + ' ' + zipcode)}`);
    const zone = suggestRes.data?.[0];
    if (!zone || !zone.zoneIds?.length) {
      return res.json({ total: 0, ads: [], error: 'Zone non trouvée sur Bien\'ici' });
    }

    const filters = {
      size: 50,
      page: 1,
      from: 0,
      filterType: 'buy',
      propertyType: userFilters.propertyTypes?.length ? userFilters.propertyTypes : ['house', 'flat'],
      onTheMarket: [true],
      zoneIdsByTypes: { zoneIds: zone.zoneIds },
      sortBy: 'relevance',
      sortOrder: 'desc',
    };
    if (userFilters.minPrice != null) filters.minPrice = userFilters.minPrice;
    if (userFilters.maxPrice != null) filters.maxPrice = userFilters.maxPrice;
    if (userFilters.minSurface != null) filters.minArea = userFilters.minSurface;
    if (userFilters.maxSurface != null) filters.maxArea = userFilters.maxSurface;

    const searchRes = await axios.get('https://www.bienici.com/realEstateAds.json', {
      params: { filters: JSON.stringify(filters) },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    const ads = (searchRes.data?.realEstateAds || []).map(ad => ({
      source: 'bienici',
      subject: ad.title || `${ad.propertyType === 'house' ? 'Maison' : 'Appartement'} ${ad.roomsQuantity || '?'} pièces ${ad.surfaceArea || '?'} m²`,
      // Bien'ici renvoie parfois price sous forme [810000, null] : on extrait le 1er nombre
      price: [Array.isArray(ad.price) ? ad.price.find(p => typeof p === 'number') ?? null : ad.price],
      url: `https://www.bienici.com/annonce/${ad.id}`,
      images: { small_url: ad.photos?.[0]?.url || '' },
      attributes: [
        { key: 'square', value: String(ad.surfaceArea || '') },
        { key: 'rooms', value: String(ad.roomsQuantity || '') },
        { key: 'real_estate_type', value: ad.propertyType === 'house' ? '1' : '2' },
        ...(ad.energyClassification ? [{ key: 'energy_rate', value: ad.energyClassification }] : []),
        ...(ad.greenhouseGasClassification ? [{ key: 'ges', value: ad.greenhouseGasClassification }] : []),
      ],
      location: {
        city: ad.city || '',
        zipcode: ad.postalCode || '',
        city_label: `${ad.city || ''} ${ad.postalCode || ''}`,
      },
      body: ad.description || '',
      first_publication_date: ad.publicationDate || ad.firstPublicationDate || ad.modificationDate || null,
    }));

    const data = { total: searchRes.data?.total || ads.length, ads, fetchedAt: new Date().toISOString() };
    bieniciCache.set(cacheKey, data);
    saveBieniciCache();
    console.log(`[Bienici] ${ads.length} annonces pour ${cacheKey}`);
    res.json(data);
  } catch (err) {
    if (bieniciCache.has(cacheKey)) {
      return res.json({ ...bieniciCache.get(cacheKey), fromCache: true });
    }
    res.status(500).json({ error: 'Erreur Bien\'ici', details: err.message });
  }
});

// --- Tram: données OSM via Overpass API (avec cache) ---
const tramCache = new Map();
function saveTramCache() {
  dbSync.persist('.tram-cache.json', Object.fromEntries(tramCache));
}

app.get('/api/tram', async (req, res) => {
  const { lat, lng, radius = 8000 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat et lng requis' });

  const cacheKey = `${parseFloat(lat).toFixed(2)}_${parseFloat(lng).toFixed(2)}`;
  if (tramCache.has(cacheKey)) {
    return res.json(tramCache.get(cacheKey));
  }

  // Essayer plusieurs miroirs Overpass
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const stopsQuery = `[out:json][timeout:30];(node["railway"="tram_stop"](around:${radius},${lat},${lng});node["public_transport"="stop_position"]["tram"="yes"](around:${radius},${lat},${lng});node["public_transport"="platform"]["tram"="yes"](around:${radius},${lat},${lng});node["public_transport"="stop_position"]["railway"="tram"](around:${radius},${lat},${lng});node["highway"="bus_stop"]["tram"="yes"](around:${radius},${lat},${lng}););out;`;

  for (const mirror of mirrors) {
    try {
      const { data } = await axios.get(
        `${mirror}?data=${encodeURIComponent(stopsQuery)}`,
        { timeout: 35000 }
      );

      if (!data.elements) continue;

      const stops = data.elements
        .filter(el => el.type === 'node' && el.lat && el.lon)
        .map(el => ({
          id: el.id,
          name: el.tags?.name || 'Arrêt tram',
          lat: el.lat,
          lng: el.lon,
        }));

      const seen = new Set();
      const uniqueStops = stops.filter(s => {
        const key = s.name + '_' + s.lat.toFixed(4);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const result = { stops: uniqueStops };
      tramCache.set(cacheKey, result);
      saveTramCache();
      console.log(`[Tram] ${uniqueStops.length} arrêts pour ${cacheKey}`);
      return res.json(result);
    } catch (_) {
      // Essayer le miroir suivant
    }
  }

  // Tous les miroirs ont échoué
  res.json({ stops: [], error: 'Overpass API indisponible' });
});

// --- Toutes les annonces en cache ---
app.get('/api/all-cached-ads', (req, res) => {
  const allAds = [];
  for (const [key, data] of lbcCache) {
    for (const ad of (data.ads || [])) {
      allAds.push({ ...ad, _source: ad.source || 'leboncoin', _cacheKey: key });
    }
  }
  for (const [key, data] of bieniciCache) {
    for (const ad of (data.ads || [])) {
      allAds.push({ ...ad, source: 'bienici', _source: 'bienici', _cacheKey: key });
    }
  }
  res.json({ total: allAds.length, ads: allAds });
});

// --- Liste des communes en cache (avec noms) ---
app.get('/api/cached-communes', (req, res) => {
  const allKeys = new Set([
    ...lbcCache.keys(),
    ...bieniciCache.keys(),
  ]);
  // Dédoublonner par baseKey (city_zip), peu importe les filtres
  const byBase = new Map();
  for (const key of allKeys) {
    const baseKey = key.split('|')[0];
    const parts = baseKey.split('_');
    const zip = parts[parts.length - 1];
    const city = parts.length > 1 ? parts.slice(0, -1).join('_') : '';
    if (/^\d{5}$/.test(zip)) {
      byBase.set(baseKey, { key, city, zipcode: zip });
    } else if (/^\d{5}$/.test(baseKey)) {
      byBase.set(baseKey, { key, city: '', zipcode: baseKey });
    }
  }
  res.json([...byBase.values()]);
});

// --- Supprimer une commune du cache ---
// Si la clé se termine par "|*", supprime toutes les variantes de filtres pour ce préfixe,
// y compris l'entrée nue (legacy, sans suffixe |...).
app.delete('/api/cache/:key', (req, res) => {
  const key = req.params.key;
  let removed = 0;
  if (key.endsWith('|*')) {
    const baseKey = key.slice(0, -2); // "city_zip"
    const prefix = baseKey + '|';
    const matches = (k) => k === baseKey || k.startsWith(prefix);
    for (const k of [...lbcCache.keys()]) {
      if (matches(k)) { lbcCache.delete(k); removed++; }
    }
    for (const k of [...bieniciCache.keys()]) {
      if (matches(k)) { bieniciCache.delete(k); removed++; }
    }
  } else {
    if (lbcCache.delete(key)) removed++;
    if (bieniciCache.delete(key)) removed++;
  }
  saveCache();
  saveBieniciCache();
  console.log(`[Cache] Supprimé: ${key} (${removed} entrées)`);
  res.json({ ok: true, removed });
});

// --- Favoris (en mémoire, persistés via db-sync) ---
let favoritesStore = {};

app.get('/api/favorites', (req, res) => {
  res.json(favoritesStore);
});

app.post('/api/favorites', (req, res) => {
  favoritesStore = req.body || {};
  dbSync.persist('.favorites.json', favoritesStore);
  res.json({ ok: true });
});

// --- Annonces masquées (en mémoire, persistées via db-sync) ---
let hiddenStore = [];

app.get('/api/hidden', (req, res) => {
  res.json(hiddenStore);
});

app.post('/api/hidden', (req, res) => {
  hiddenStore = req.body || [];
  dbSync.persist('.hidden-ads.json', hiddenStore);
  res.json({ ok: true });
});

// --- Démarrage : on charge tout depuis Postgres avant d'ouvrir les routes ---
async function bootstrap() {
  const [lbc, ad, bie, tram, fav, hid] = await Promise.all([
    dbSync.load('.lbc-cache.json'),
    dbSync.load('.lbc-ad-cache.json'),
    dbSync.load('.bienici-cache.json'),
    dbSync.load('.tram-cache.json'),
    dbSync.load('.favorites.json'),
    dbSync.load('.hidden-ads.json'),
  ]);
  if (lbc) Object.entries(lbc).forEach(([k, v]) => lbcCache.set(k, v));
  if (ad) Object.entries(ad).forEach(([k, v]) => adCacheStore.set(k, v));
  if (bie) Object.entries(bie).forEach(([k, v]) => bieniciCache.set(k, v));
  if (tram) Object.entries(tram).forEach(([k, v]) => tramCache.set(k, v));
  if (fav) favoritesStore = fav;
  if (hid) hiddenStore = hid;
  console.log(`[bootstrap] caches chargés — lbc:${lbcCache.size} bie:${bieniciCache.size} ad:${adCacheStore.size} tram:${tramCache.size}`);

  app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    if (process.env.DATABASE_URL) {
      console.log('[db-sync] persistance Postgres active (backup local toutes les 5 min)');
    } else {
      console.log('[db-sync] DATABASE_URL non défini — fonctionnement en mémoire + backup fichier local');
    }
  });

  // Flush final lors d'un shutdown
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      try { await dbSync.flush(); } catch (_) {}
      process.exit(0);
    });
  }
}

bootstrap().catch(err => {
  console.error('[bootstrap] échec:', err);
  process.exit(1);
});

