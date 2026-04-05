const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
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

// Cache des annonces Leboncoin — persisté sur disque
const CACHE_FILE = path.join(__dirname, '.lbc-cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))));
    }
  } catch (_) {}
  return new Map();
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)), 'utf-8');
  } catch (_) {}
}

const lbcCache = loadCache();

app.get('/api/leboncoin', async (req, res) => {
  const { city, zipcode, department_id, lat, lng, refresh } = req.query;

  const cacheKey = city ? `${city}_${zipcode}` : (zipcode || department_id || 'all');

  if (!refresh && lbcCache.has(cacheKey)) {
    const cached = lbcCache.get(cacheKey);
    return res.json({ ...cached, fromCache: true });
  }

  try {
    // Construire la requête pour l'API Leboncoin
    const body = {
      limit: 50,
      limit_alu: 3,
      filters: {
        category: { id: '9' },  // Ventes immobilières
        enums: {
          real_estate_type: ['1', '2'],  // Maison, Appartement
          ad_type: ['offer'],
        },
        ranges: {
          price: { min: 500000, max: 750000 },
          square: { min: 120 },
        },
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
      saveCache(lbcCache);
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
const AD_CACHE_FILE = path.join(__dirname, '.lbc-ad-cache.json');

function loadAdCache() {
  try {
    if (fs.existsSync(AD_CACHE_FILE)) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(AD_CACHE_FILE, 'utf-8'))));
    }
  } catch (_) {}
  return new Map();
}

function saveAdCache() {
  try {
    fs.writeFileSync(AD_CACHE_FILE, JSON.stringify(Object.fromEntries(adCacheStore)), 'utf-8');
  } catch (_) {}
}

const adCacheStore = loadAdCache();

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
const BIENICI_CACHE_FILE = path.join(__dirname, '.bienici-cache.json');
try { if (fs.existsSync(BIENICI_CACHE_FILE)) Object.entries(JSON.parse(fs.readFileSync(BIENICI_CACHE_FILE, 'utf-8'))).forEach(([k,v]) => bieniciCache.set(k,v)); } catch (_) {}

app.get('/api/bienici', async (req, res) => {
  const { city, zipcode, refresh } = req.query;
  const cacheKey = city ? `${city}_${zipcode}` : (zipcode || 'all');

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
      propertyType: ['house', 'flat'],
      minPrice: 500000,
      maxPrice: 750000,
      minArea: 120,
      onTheMarket: [true],
      zoneIdsByTypes: { zoneIds: zone.zoneIds },
      sortBy: 'relevance',
      sortOrder: 'desc',
    };

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
      price: [ad.price],
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
    }));

    const data = { total: searchRes.data?.total || ads.length, ads, fetchedAt: new Date().toISOString() };
    bieniciCache.set(cacheKey, data);
    try { fs.writeFileSync(BIENICI_CACHE_FILE, JSON.stringify(Object.fromEntries(bieniciCache)), 'utf-8'); } catch (_) {}
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
const TRAM_CACHE_FILE = path.join(__dirname, '.tram-cache.json');
try { if (fs.existsSync(TRAM_CACHE_FILE)) Object.entries(JSON.parse(fs.readFileSync(TRAM_CACHE_FILE, 'utf-8'))).forEach(([k,v]) => tramCache.set(k,v)); } catch (_) {}

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
      try { fs.writeFileSync(TRAM_CACHE_FILE, JSON.stringify(Object.fromEntries(tramCache)), 'utf-8'); } catch (_) {}
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
  const communes = [];
  for (const key of allKeys) {
    const parts = key.split('_');
    const zip = parts[parts.length - 1];
    const city = parts.length > 1 ? parts.slice(0, -1).join('_') : '';
    if (/^\d{5}$/.test(zip)) {
      communes.push({ key, city, zipcode: zip });
    } else if (/^\d{5}$/.test(key)) {
      communes.push({ key, city: '', zipcode: key });
    }
  }
  res.json(communes);
});

// --- Supprimer une commune du cache ---
app.delete('/api/cache/:key', (req, res) => {
  const key = req.params.key;
  lbcCache.delete(key);
  bieniciCache.delete(key);
  saveCache(lbcCache);
  try { fs.writeFileSync(BIENICI_CACHE_FILE, JSON.stringify(Object.fromEntries(bieniciCache)), 'utf-8'); } catch (_) {}
  console.log(`[Cache] Supprimé: ${key}`);
  res.json({ ok: true });
});

// --- Favoris sur disque ---
const FAVORITES_FILE = path.join(__dirname, '.favorites.json');

app.get('/api/favorites', (req, res) => {
  try {
    if (fs.existsSync(FAVORITES_FILE)) {
      res.json(JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf-8')));
    } else {
      res.json({});
    }
  } catch (_) {
    res.json({});
  }
});

app.post('/api/favorites', (req, res) => {
  try {
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Annonces masquées sur disque ---
const HIDDEN_FILE = path.join(__dirname, '.hidden-ads.json');

app.get('/api/hidden', (req, res) => {
  try {
    if (fs.existsSync(HIDDEN_FILE)) {
      res.json(JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf-8')));
    } else {
      res.json([]);
    }
  } catch (_) {
    res.json([]);
  }
});

app.post('/api/hidden', (req, res) => {
  try {
    fs.writeFileSync(HIDDEN_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});

