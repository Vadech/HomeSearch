const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// --- Leboncoin: scraping via Puppeteer (mode visible + cookies persistants) ---
let browser = null;
const USER_DATA_DIR = path.join(__dirname, '.chrome-data');

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: USER_DATA_DIR,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=800,600',
        '--window-position=2000,2000',
        '--no-focus-on-launch',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    // Minimiser la fenêtre du navigateur
    const pages = await browser.pages();
    for (const p of pages) {
      const session = await p.createCDPSession();
      await session.send('Browser.setWindowBounds', {
        windowId: (await session.send('Browser.getWindowForTarget')).windowId,
        bounds: { windowState: 'minimized' },
      }).catch(() => {});
    }
  }
  return browser;
}

// Résoudre le slider Datadome si présent
async function solveDateDomeSlider(page) {
  // Vérifier si on est sur une page de vérification Datadome
  const isBlocked = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text.includes('Faites glisser') || text.includes('Verifying') || text.includes('robot');
  });

  if (!isBlocked) return false;

  console.log('[LBC] Détection captcha Datadome — tentative de résolution du slider...');

  // Le slider peut être dans une iframe
  let sliderFrame = page;
  const frames = page.frames();
  for (const frame of frames) {
    const hasSlider = await frame.evaluate(() => {
      return !!document.querySelector('.captcha-slider, #captcha-container, .slider-container, [class*="slider"], [class*="captcha"]');
    }).catch(() => false);
    if (hasSlider) { sliderFrame = frame; break; }
  }

  // Chercher l'élément slider à glisser
  const slider = await sliderFrame.$('.captcha-slider .slider-handle, [class*="slider"] button, .captcha-container button, #captcha-container button, button[aria-label*="slide"], .geetest_slider_button, .slider-icon');

  if (slider) {
    const box = await slider.boundingBox();
    if (box) {
      // Glisser de gauche à droite avec un mouvement naturel
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      const endX = startX + 280;

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      // Mouvement progressif avec légère variation
      for (let x = startX; x <= endX; x += 5 + Math.random() * 3) {
        await page.mouse.move(x, startY + (Math.random() * 2 - 1));
        await new Promise(r => setTimeout(r, 10 + Math.random() * 15));
      }
      await page.mouse.move(endX, startY);
      await page.mouse.up();

      console.log('[LBC] Slider glissé, attente de la redirection...');
      await new Promise(r => setTimeout(r, 5000));
      return true;
    }
  }

  // Si pas de slider trouvé, attendre — l'utilisateur peut résoudre manuellement
  console.log('[LBC] Slider non trouvé automatiquement. Attente de résolution manuelle (30s)...');
  try {
    await page.waitForSelector('#__NEXT_DATA__', { timeout: 30000 });
    return true;
  } catch (_) {
    return false;
  }
}

process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(); });

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

  // Clé de cache basée sur la ville (pas seulement le code postal)
  const cacheKey = city ? `${city}_${zipcode}` : (zipcode || department_id || 'all');

  // Retourner le cache sauf si refresh explicite
  if (!refresh && lbcCache.has(cacheKey)) {
    const cached = lbcCache.get(cacheKey);
    return res.json({ ...cached, fromCache: true });
  }

  // Format Leboncoin : Ville_CP__lat_lng_rayon_0
  const params = new URLSearchParams({ category: '9', real_estate_type: '1,2', price: '500000-750000', sort: 'time', order: 'desc' });
  if (city && zipcode && lat && lng) {
    const cleanCity = city.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    params.set('locations', `${cleanCity}_${zipcode}__${lat}_${lng}_5000_0`);
  } else if (department_id) {
    params.set('locations', `d_${department_id}`);
  }

  const url = `https://www.leboncoin.fr/recherche?${params.toString()}`;
  let page;

  try {
    const b = await getBrowser();
    page = await b.newPage();
    // Minimiser l'onglet
    try {
      const session = await page.createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch (_) {}

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en'] });
      window.chrome = { runtime: {} };
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Vérifier si Datadome bloque et tenter de résoudre
    const hasData = await page.$('#__NEXT_DATA__');
    if (!hasData) {
      await solveDateDomeSlider(page);
    }

    // Attendre que le contenu charge
    try {
      await page.waitForSelector('#__NEXT_DATA__', { timeout: 10000 });
    } catch (_) {}

    await new Promise(r => setTimeout(r, 2000));

    // Accepter les cookies si présents
    try {
      const consentBtn = await page.evaluateHandle(() => {
        for (const btn of document.querySelectorAll('button')) {
          if (btn.textContent?.includes('Accepter')) return btn;
        }
        return null;
      });
      if (consentBtn && consentBtn.asElement()) {
        await consentBtn.asElement().click();
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (_) {}

    // Extraire les données depuis __NEXT_DATA__
    const result = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try {
        const json = JSON.parse(el.textContent);
        const searchData = json?.props?.pageProps?.searchData;
        if (searchData) return searchData;
      } catch (_) {}
      return null;
    });

    await page.close();

    if (result && result.ads && result.ads.length > 0) {
      const data = { total: result.total || result.ads.length, ads: result.ads, fetchedAt: new Date().toISOString() };
      lbcCache.set(cacheKey, data);
      saveCache(lbcCache);
      console.log(`[LBC] ${refresh ? 'Refresh' : 'Fetch'} OK: ${result.ads.length} annonces pour ${cacheKey}`);
      res.json(data);
    } else if (lbcCache.has(cacheKey)) {
      // Si le refresh échoue (captcha), retourner le cache existant
      console.log(`[LBC] Refresh échoué, retour du cache pour ${cacheKey}`);
      const cached = lbcCache.get(cacheKey);
      res.json({ ...cached, fromCache: true, refreshFailed: true });
    } else {
      console.log('[LBC] Aucune annonce et pas de cache');
      res.json({ total: 0, ads: [], error: 'Captcha Datadome non résolu. Ouvrez leboncoin.fr dans votre navigateur pour débloquer votre IP.' });
    }
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: 'Erreur Leboncoin (Puppeteer)', details: err.message });
  }
});

// --- Leboncoin: détail d'une annonce (description complète) ---
const adCache = new Map();
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

  // Cache
  if (adCacheStore.has(url)) {
    return res.json(adCacheStore.get(url));
  }

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    try {
      const session = await page.createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch (_) {}

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Gérer captcha si besoin
    const hasData = await page.$('#__NEXT_DATA__');
    if (!hasData) {
      await solveDateDomeSlider(page);
      try { await page.waitForSelector('#__NEXT_DATA__', { timeout: 15000 }); } catch (_) {}
    }

    await new Promise(r => setTimeout(r, 2000));

    const adData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try {
        const json = JSON.parse(el.textContent);
        const ad = json?.props?.pageProps?.ad;
        if (!ad) return null;
        return {
          body: ad.body || '',
          attributes: ad.attributes || [],
          subject: ad.subject || '',
        };
      } catch (_) {}
      return null;
    });

    await page.close();

    if (adData) {
      adCacheStore.set(url, adData);
      saveAdCache();
      res.json(adData);
    } else {
      res.json({ body: '', attributes: [], error: 'Impossible de charger le détail' });
    }
  } catch (err) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ error: 'Erreur détail annonce', details: err.message });
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

// --- Liste des communes en cache ---
app.get('/api/cached-communes', (req, res) => {
  const allKeys = new Set([
    ...lbcCache.keys(),
    ...bieniciCache.keys(),
  ]);
  // Extraire les codes postaux des clés (format "Ville_CP" ou "CP")
  const zipcodes = new Set();
  for (const key of allKeys) {
    const parts = key.split('_');
    const zip = parts[parts.length - 1];
    if (/^\d{5}$/.test(zip)) zipcodes.add(zip);
    else if (/^\d{5}$/.test(key)) zipcodes.add(key);
  }
  res.json([...zipcodes]);
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

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});

