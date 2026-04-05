// --- State ---
let map;
let communeLayer = null;
let selectedCommune = null;
let searchTimeout = null;
let lastDvfData = null;
let mapVisible = true;
let dvfMarkersLayer = null;
let tramLayer = null;
let cachedCommunesLayer = null;

// --- Favoris (persistés sur disque via API) ---
let _favoritesCache = {};

async function loadFavoritesFromDisk() {
  try {
    const res = await fetch('/api/favorites');
    _favoritesCache = await res.json();
  } catch (_) {
    _favoritesCache = {};
  }
}

function getFavorites() {
  return _favoritesCache;
}

function saveFavorites(favs) {
  _favoritesCache = favs;
  fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(favs),
  }).catch(() => {});
}

function toggleFavorite(adUrl, adData) {
  const favs = getFavorites();
  if (favs[adUrl]) {
    delete favs[adUrl];
  } else {
    favs[adUrl] = { ...adData, favoritedAt: new Date().toISOString() };
  }
  saveFavorites(favs);
  return !!favs[adUrl];
}

function isFavorite(adUrl) {
  return !!_favoritesCache[adUrl];
}

// --- Annonces masquées (persistées sur disque via API) ---
let _hiddenAdsCache = [];

async function loadHiddenFromDisk() {
  try {
    const res = await fetch('/api/hidden');
    _hiddenAdsCache = await res.json();
  } catch (_) {
    _hiddenAdsCache = [];
  }
}

function getHiddenAds() {
  return _hiddenAdsCache;
}

function saveHiddenAds(list) {
  _hiddenAdsCache = list;
  fetch('/api/hidden', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  }).catch(() => {});
}

function toggleHidden(adUrl) {
  const list = getHiddenAds();
  const idx = list.indexOf(adUrl);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(adUrl);
  }
  saveHiddenAds(list);
  return idx < 0; // true = vient d'être masqué
}

function isHidden(adUrl) {
  return _hiddenAdsCache.includes(adUrl);
}

let showHiddenAds = false;

// Stockage global des annonces pour le système de favoris
let currentAllListings = [];

// Event listener délégué pour les clics sur les étoiles
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.fav-btn[data-fav-index]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.favIndex);
  const ad = currentAllListings[idx];
  if (!ad || !ad.url) return;

  const adData = { subject: ad.subject, price: ad.price, url: ad.url, images: ad.images, attributes: ad.attributes, location: ad.location, _source: ad._source };
  const isNowFav = toggleFavorite(ad.url, adData);
  btn.textContent = isNowFav ? '★' : '☆';
  btn.classList.toggle('fav-btn--active', isNowFav);
  btn.title = isNowFav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  btn.closest('.listing-item')?.classList.toggle('listing-item--fav', isNowFav);
  updateFavCount();
});

// Event listener délégué pour les clics sur le bouton masquer
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.hide-btn[data-hide-index]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.hideIndex);
  const ad = currentAllListings[idx];
  if (!ad || !ad.url) return;

  const isNowHidden = toggleHidden(ad.url);
  const card = btn.closest('.listing-item');
  if (card) {
    if (isNowHidden && !showHiddenAds) {
      card.style.display = 'none';
    }
    card.classList.toggle('listing-item--hidden', isNowHidden);
  }
  btn.textContent = isNowHidden ? '👁' : '✕';
  btn.title = isNowHidden ? 'Réafficher' : 'Masquer';
  updateHiddenCount();
  updateCategoryCounts();
});

function updateHiddenCount() {
  const el = document.getElementById('hidden-count');
  if (el) el.textContent = getHiddenAds().length;
}

function updateFavCount() {
  const count = Object.keys(getFavorites()).length;
  const el = document.getElementById('fav-count');
  if (el) el.textContent = count;
}

function showFavorites() {
  const panel = document.getElementById('panel-results');
  if (!panel) return;

  const favs = getFavorites();
  const entries = Object.entries(favs);
  const container = document.getElementById('all-listings');
  if (!container) return;

  let html = '<div id="listings-header"><h3>★ Favoris (' + entries.length + ')</h3>';
  html += '<button id="back-to-results-btn" onclick="backToResults()">Retour aux annonces</button></div>';

  if (entries.length === 0) {
    html += '<p class="text-muted">Aucun favori pour le moment</p>';
  } else {
    html += entries.map(([url, ad]) => {
      const price = ad.price?.[0];
      const surface = getAttr(ad, 'square');
      const rooms = getAttr(ad, 'rooms');
      const type = getAttr(ad, 'real_estate_type');
      const typeLabel = { '1': 'Maison', '2': 'Appart.', '3': 'Terrain', '4': 'Parking', '5': 'Autre' }[type] || '';
      const prixM2 = price && surface ? Math.round(price / Number(surface)) : null;
      const thumb = ad.images?.small_url || ad.images?.thumb_url || '';
      const locationLabel = ad.location?.city_label || [ad.location?.zipcode, ad.location?.city].filter(Boolean).join(' ') || '';
      const sourceInfo = SOURCE_LABELS[ad._source] || { name: ad._source, color: '#999' };

      return `<div class="listing-item listing-item--lbc listing-item--fav">
        ${thumb ? `<div class="listing-thumb"><img src="${thumb}" alt="${ad.subject || ''}" loading="lazy" /></div>` : ''}
        <div class="listing-content">
          <div class="listing-top-row">
            <span class="source-badge source-badge--small" style="background:${sourceInfo.color}">${sourceInfo.name}</span>
            <button class="fav-btn fav-btn--active" onclick="removeFavAndRefresh(this, '${url.replace(/'/g, "\\'")}')" title="Retirer des favoris">★</button>
          </div>
          <div class="listing-title">${ad.subject || 'Annonce'}</div>
          <div class="listing-location">${locationLabel}</div>
          <div class="listing-details">
            ${typeLabel} | ${surface || '?'} m² | ${rooms || '?'} pièces
          </div>
          <div class="listing-price-line">
            <span class="listing-price">${price?.toLocaleString('fr-FR')} €</span>
            ${prixM2 ? `<span class="listing-price-m2">(${prixM2.toLocaleString('fr-FR')} €/m²)</span>` : ''}
          </div>
          ${url ? `<a href="${url}" target="_blank" rel="noopener">Voir l'annonce</a>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  container.innerHTML = html;
}

function removeFavAndRefresh(btn, url) {
  const favs = getFavorites();
  delete favs[url];
  saveFavorites(favs);
  btn.closest('.listing-item')?.remove();
  updateFavCount();
  // Mettre à jour le compteur dans le header
  const header = document.querySelector('#listings-header h3');
  if (header) header.textContent = `★ Favoris (${Object.keys(getFavorites()).length})`;
}

function backToResults() {
  if (selectedCommune && lastDvfData && lastSources.lbc) {
    renderResults(selectedCommune, lastDvfData, lastSources.lbc, lastSources.bienici);
  }
}

async function showAllCached() {
  const container = document.getElementById('all-listings');
  const panel = document.getElementById('panel-results');
  if (!container || !panel) return;

  document.getElementById('panel-placeholder')?.classList.add('hidden');
  document.getElementById('panel-loading')?.classList.remove('hidden');
  panel.classList.remove('hidden');

  try {
    const res = await fetch('/api/all-cached-ads');
    const data = await res.json();

    // Appliquer les filtres prix/surface + dédoublonner
    const seenUrls = new Set();
    const seenKeys = new Set();
    const ads = (data.ads || []).filter(ad => {
      const price = ad.price?.[0];
      const square = Number(getAttr(ad, 'square'));
      if (!(price >= 500000 && price <= 750000 && square > 120)) return false;
      // Dédoublonner par URL
      if (ad.url && seenUrls.has(ad.url)) return false;
      // Dédoublonner cross-source par prix + surface + ville
      const city = ad.location?.city || ad.location?.zipcode || '';
      const dedupKey = `${price}_${square}_${city}`;
      if (price && square && seenKeys.has(dedupKey)) return false;
      if (ad.url) seenUrls.add(ad.url);
      if (price && square) seenKeys.add(dedupKey);
      return true;
    });

    // Trier par prix/m²
    ads.sort((a, b) => {
      const pA = a.price?.[0] / Number(getAttr(a, 'square')) || Infinity;
      const pB = b.price?.[0] / Number(getAttr(b, 'square')) || Infinity;
      return pA - pB;
    });

    currentAllListings = ads;

    // Détecter travaux
    const renovRegex = /[àa] r[eé]nover|travaux [àa] pr[eé]voir|[àa] rafra[iî]chir|[àa] restaurer|[àa] r[eé]habiliter|n[eé]cessite des travaux|gros travaux|remise en [eé]tat|[àa] remettre en [eé]tat|[àa] moderniser|enti[eè]rement [àa] refaire|totalement [àa] r[eé]nover|r[eé]novation compl[eè]te|r[eé]novation totale|gros potentiel|fort potentiel|id[eé]al investisseur|travaux importants|n[eé]cessite une r[eé]novation/i;
    const noRenovRegex = /aucun travaux|aucuns travaux|sans travaux|pas de travaux|rien [àa] faire|cl[eé]s? en main/i;

    ads.forEach(ad => {
      const fullText = ((ad.subject || '') + ' ' + (ad.body || '')).toLowerCase();
      ad._isRenov = renovRegex.test(fullText) && !noRenovRegex.test(fullText);
    });

    const normalAds = ads.filter(a => !a._isRenov);
    const renovAds = ads.filter(a => a._isRenov);

    document.getElementById('panel-loading')?.classList.add('hidden');
    document.getElementById('commune-name').textContent = 'Toutes les communes';
    document.getElementById('commune-info').textContent = `${ads.length} annonces en cache`;

    function renderCachedCard(ad, i) {
      const price = ad.price?.[0];
      const surface = getAttr(ad, 'square');
      const rooms = getAttr(ad, 'rooms');
      const type = getAttr(ad, 'real_estate_type');
      const typeLabel = { '1': 'Maison', '2': 'Appart.', '3': 'Terrain', '4': 'Parking', '5': 'Autre' }[type] || '';
      const prixM2 = price && surface ? Math.round(price / Number(surface)) : null;
      const thumb = ad.images?.small_url || ad.images?.thumb_url || '';
      const locationLabel = ad.location?.city_label || [ad.location?.zipcode, ad.location?.city].filter(Boolean).join(' ') || '';
      const sourceInfo = SOURCE_LABELS[ad._source] || { name: ad._source, color: '#999' };
      const fav = isFavorite(ad.url);

      const hidden = isHidden(ad.url);
      const hideStyle = hidden && !showHiddenAds ? ' style="display:none"' : '';

      return `<div class="listing-item listing-item--lbc ${ad._isRenov ? 'listing-item--renov' : ''} ${fav ? 'listing-item--fav' : ''} ${hidden ? 'listing-item--hidden' : ''}" data-url="${ad.url || ''}"${hideStyle}>
        ${thumb ? `<div class="listing-thumb"><img src="${thumb}" alt="${ad.subject || ''}" loading="lazy" /></div>` : ''}
        <div class="listing-content">
          <div class="listing-top-row">
            <span class="source-badge source-badge--small" style="background:${sourceInfo.color}">${sourceInfo.name}</span>
            ${ad._isRenov ? '<span class="source-badge source-badge--small" style="background:#d84315">🔨 Travaux</span>' : ''}
            <button class="hide-btn ${hidden ? 'hide-btn--active' : ''}" data-hide-index="${i}" title="${hidden ? 'Réafficher' : 'Masquer'}">${hidden ? '👁' : '✕'}</button>
            <button class="fav-btn ${fav ? 'fav-btn--active' : ''}" data-fav-index="${i}" title="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${fav ? '★' : '☆'}</button>
          </div>
          <div class="listing-title">${ad.subject || 'Annonce'}</div>
          <div class="listing-location">${locationLabel}</div>
          <div class="listing-details">
            ${typeLabel} | ${surface || '?'} m² | ${rooms || '?'} pièces
          </div>
          <div class="listing-price-line">
            <span class="listing-price">${price?.toLocaleString('fr-FR')} €</span>
            ${prixM2 ? `<span class="listing-price-m2">(${prixM2.toLocaleString('fr-FR')} €/m²)</span>` : ''}
          </div>
          ${ad.url ? `<a href="${ad.url}" target="_blank" rel="noopener">Voir l'annonce</a>` : ''}
        </div>
      </div>`;
    }

    // Charger la liste des communes en cache
    let cachedCommunes = [];
    try {
      const ccRes = await fetch('/api/cached-communes');
      cachedCommunes = await ccRes.json();
    } catch (_) {}

    let html = '<div id="listings-header"><h3>Toutes les annonces en cache (' + ads.length + ')</h3>';
    html += '<button id="refresh-all-cache-btn">Rafraîchir tout</button>';
    html += '<button id="back-to-results-btn" onclick="backToResults()">Retour</button></div>';

    // Liste des communes en cache
    if (cachedCommunes.length > 0) {
      html += '<div id="cached-communes-list">';
      html += '<h3 class="section-title">Communes en cache</h3>';
      html += '<div class="communes-tags">';
      for (const c of cachedCommunes) {
        const label = c.city ? `${c.city} (${c.zipcode})` : c.zipcode;
        html += `<span class="commune-tag" data-cache-key="${c.key}">
          ${label}
          <button class="commune-tag-delete" data-cache-key="${c.key}" title="Supprimer du cache">✕</button>
        </span>`;
      }
      html += '</div></div>';
    }

    html += `<h3 class="section-title" id="normal-title">${normalAds.length} bien${normalAds.length > 1 ? 's' : ''}</h3>`;
    html += '<div id="normal-listings">';
    html += normalAds.map((ad, idx) => renderCachedCard(ad, ads.indexOf(ad))).join('');
    html += '</div>';

    if (renovAds.length > 0) {
      html += `<div><h3 class="section-title section-title--renov" id="renov-title">🔨 ${renovAds.length} bien${renovAds.length > 1 ? 's' : ''} avec travaux</h3></div>`;
      html += '<div id="renov-listings">';
      html += renovAds.map((ad, idx) => renderCachedCard(ad, ads.indexOf(ad))).join('');
      html += '</div>';
    }

    container.innerHTML = html;

    // Bouton supprimer une commune du cache
    container.querySelectorAll('.commune-tag-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const key = btn.dataset.cacheKey;
        await fetch(`/api/cache/${encodeURIComponent(key)}`, { method: 'DELETE' });
        btn.closest('.commune-tag')?.remove();
        // Recharger la vue
        showAllCached();
        loadCachedCommunes();
      });
    });

    // Bouton rafraîchir tout le cache
    document.getElementById('refresh-all-cache-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('refresh-all-cache-btn');
      btn.disabled = true;
      btn.textContent = 'Chargement...';

      for (const c of cachedCommunes) {
        try {
          const label = c.city || c.zipcode;
          btn.textContent = `${label}...`;
          // Trouver la commune via l'API geo
          const geoRes = await fetch(`/api/communes?codePostal=${c.zipcode}&limit=1`);
          const communes = await geoRes.json();
          if (!communes.length) continue;
          const commune = communes[0];
          const coords = commune.centre?.coordinates;

          // Rafraîchir Leboncoin + Bien'ici en parallèle
          const params = new URLSearchParams({
            city: commune.nom,
            zipcode: commune.codesPostaux?.[0] || '',
            department_id: commune.codeDepartement,
            refresh: '1',
            ...(coords ? { lat: coords[1], lng: coords[0] } : {}),
          });
          await Promise.all([
            fetch(`/api/leboncoin?${params}`),
            fetch(`/api/bienici?${params}`),
          ]);
        } catch (_) {}
      }

      btn.disabled = false;
      btn.textContent = 'Rafraîchir tout';
      // Recharger la vue
      showAllCached();
    });
  } catch (_) {
    document.getElementById('panel-loading')?.classList.add('hidden');
    container.innerHTML = '<p class="text-muted">Erreur lors du chargement des annonces en cache</p>';
  }
}

function toggleMap() {
  const container = document.getElementById('map-container');
  const btn = document.getElementById('toggle-map-btn');
  mapVisible = !mapVisible;
  container.classList.toggle('hidden', !mapVisible);
  btn.textContent = mapVisible ? 'Masquer la carte' : 'Afficher la carte';
  if (mapVisible) {
    setTimeout(() => map.invalidateSize(), 100);
  }
}

// --- Init ---
function toggleShowHidden() {
  showHiddenAds = !showHiddenAds;
  const btn = document.getElementById('hidden-btn-header');
  if (btn) btn.style.background = showHiddenAds ? '#c62828' : '#757575';

  // Rafraîchir l'affichage des cartes masquées
  document.querySelectorAll('.listing-item--hidden').forEach(card => {
    card.style.display = showHiddenAds ? '' : 'none';
  });

  // Aussi masquer les cartes qui ne sont pas marquées mais sont cachées (premier affichage)
  document.querySelectorAll('.listing-item[data-url]').forEach(card => {
    const url = card.dataset.url;
    if (isHidden(url)) {
      card.classList.add('listing-item--hidden');
      card.style.display = showHiddenAds ? '' : 'none';
    }
  });

  updateCategoryCounts();
}

document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  await Promise.all([loadFavoritesFromDisk(), loadHiddenFromDisk()]);
  updateFavCount();
  updateHiddenCount();
  initSearch();

  // Afficher les communes en cache sur la carte
  loadCachedCommunes();

  // Charger Le Crès (34920) par défaut
  try {
    const res = await fetch('/api/communes?codePostal=34920&limit=1');
    const communes = await res.json();
    const leCres = communes.find(c => c.nom.includes('Crès')) || communes[0];
    if (leCres) selectCommune(leCres);
  } catch (_) {}
});

async function loadCachedCommunes() {
  try {
    const res = await fetch('/api/cached-communes');
    const entries = await res.json();
    if (!entries.length) return;

    if (cachedCommunesLayer) map.removeLayer(cachedCommunesLayer);
    cachedCommunesLayer = L.layerGroup();

    for (const entry of entries) {
      const zip = entry.zipcode || entry;
      try {
        const cRes = await fetch(`/api/communes?codePostal=${zip}&limit=1`);
        const communes = await cRes.json();
        if (!communes.length) continue;
        const commune = communes[0];

        const contourRes = await fetch(`/api/communes/${commune.code}/contour`);
        const contourData = await contourRes.json();

        const layer = L.geoJSON(contourData, {
          style: {
            color: '#ff9800',
            weight: 1.5,
            fillColor: '#ff9800',
            fillOpacity: 0.12,
            dashArray: '4 4',
          },
        });
        layer.bindTooltip(`${commune.nom} (${zip}) — en cache`, { sticky: true });
        layer.on('click', () => selectCommune(commune));
        cachedCommunesLayer.addLayer(layer);
      } catch (_) {}
    }

    cachedCommunesLayer.addTo(map);
  } catch (_) {}
}

function initMap() {
  map = L.map('map').setView([46.6, 2.5], 6); // Centre de la France

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  map.on('click', async (e) => {
    const { lat, lng } = e.latlng;
    try {
      const res = await fetch(`/api/communes?lat=${lat}&lon=${lng}&limit=1`);
      const communes = await res.json();
      if (communes.length > 0) {
        selectCommune(communes[0]);
      }
    } catch (err) {
      showError('Impossible de trouver la commune pour cette position.');
    }
  });
}

// --- Search ---
function initSearch() {
  const input = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = input.value.trim();
    if (query.length < 2) {
      results.style.display = 'none';
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const param = /^\d+$/.test(query) ? `codePostal=${query}` : `nom=${encodeURIComponent(query)}`;
        const res = await fetch(`/api/communes?${param}&limit=8`);
        const communes = await res.json();
        renderSearchResults(communes);
      } catch (err) {
        results.style.display = 'none';
      }
    }, 300);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-bar')) {
      results.style.display = 'none';
    }
  });
}

function renderSearchResults(communes) {
  const results = document.getElementById('search-results');
  results.innerHTML = '';

  if (communes.length === 0) {
    results.style.display = 'none';
    return;
  }

  communes.forEach((c) => {
    const li = document.createElement('li');
    li.innerHTML = `${c.nom} <span class="commune-code">${c.codesPostaux?.[0] || ''} - ${c.codeDepartement}</span>`;
    li.addEventListener('click', () => {
      document.getElementById('search-input').value = c.nom;
      results.style.display = 'none';
      selectCommune(c);
    });
    results.appendChild(li);
  });

  results.style.display = 'block';
}

// --- Commune selection ---
async function selectCommune(commune) {
  selectedCommune = commune;
  showLoading();

  // Afficher le contour sur la carte
  try {
    const contourRes = await fetch(`/api/communes/${commune.code}/contour`);
    const contourData = await contourRes.json();

    if (communeLayer) {
      map.removeLayer(communeLayer);
    }
    communeLayer = L.geoJSON(contourData, {
      style: { color: '#4361ee', weight: 2, fillOpacity: 0.15 },
    }).addTo(map);
    map.fitBounds(communeLayer.getBounds(), { padding: [20, 20] });
  } catch (err) {
    // Centrer sur le centre de la commune si pas de contour
    if (commune.centre) {
      map.setView([commune.centre.coordinates[1], commune.centre.coordinates[0]], 13);
    }
  }

  // Charger les données en parallèle
  const coords = commune.centre?.coordinates;
  const [dvfData, lbcData, bieniciData] = await Promise.all([
    fetchDVF(commune),
    fetchLeboncoin(commune),
    fetchBienici(commune),
  ]);

  // Charger les trams (sans bloquer le rendu)
  if (coords) loadTram(coords[1], coords[0]);

  lastDvfData = dvfData;
  renderResults(commune, dvfData, lbcData, bieniciData);
}

async function loadTram(lat, lng) {
  if (tramLayer) { map.removeLayer(tramLayer); tramLayer = null; }
  try {
    const res = await fetch(`/api/tram?lat=${lat}&lng=${lng}&radius=8000`);
    const data = await res.json();

    tramLayer = L.layerGroup();

    for (const stop of (data.stops || [])) {
      const marker = L.circleMarker([stop.lat, stop.lng], {
        radius: 5,
        fillColor: '#7b1fa2',
        color: '#fff',
        weight: 2,
        fillOpacity: 0.9,
      });
      marker.bindTooltip(`🚊 ${stop.name}`, { direction: 'top' });
      tramLayer.addLayer(marker);
    }

    tramLayer.addTo(map);
  } catch (_) {}
}

// --- Moyenne tronquée : enlève les 10% extrêmes (5% bas + 5% haut) ---
function trimmedMean(values) {
  if (values.length === 0) return null;
  if (values.length < 5) return values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.05);
  const trimmed = sorted.slice(trim, sorted.length - trim);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

// --- Data fetching ---
async function fetchDVF(commune) {
  try {
    const currentYear = new Date().getFullYear();
    const res = await fetch(`/api/dvf?code_commune=${commune.code}&annee_min=${currentYear - 3}&annee_max=${currentYear}`);
    const data = await res.json();

    const ventes = (Array.isArray(data) ? data : []).filter(
      (m) => m.valeur_fonciere >= 500000 && m.valeur_fonciere <= 750000 &&
        m.surface_reelle_bati > 120 &&
        (m.type_local === 'Appartement' || m.type_local === 'Maison')
    );

    const prixM2 = ventes.map((m) => m.valeur_fonciere / m.surface_reelle_bati);
    const avg = trimmedMean(prixM2);
    const min = prixM2.length > 0 ? Math.min(...prixM2) : null;
    const max = prixM2.length > 0 ? Math.max(...prixM2) : null;

    return {
      avgPrixM2: avg,
      min,
      max,
      count: ventes.length,
      ventes,
      error: null,
    };
  } catch (err) {
    return { avgPrixM2: null, count: 0, error: err.message };
  }
}

async function fetchLeboncoin(commune, refresh = false) {
  try {
    const coords = commune.centre?.coordinates;
    const params = new URLSearchParams({
      city: commune.nom,
      zipcode: commune.codesPostaux?.[0] || '',
      department_id: commune.codeDepartement,
      ...(coords ? { lat: coords[1], lng: coords[0] } : {}),
      ...(refresh ? { refresh: '1' } : {}),
    });

    const res = await fetch(`/api/leboncoin?${params}`);
    const data = await res.json();

    if (data.error) {
      return { avgPrixM2: null, count: 0, listings: [], error: data.hint || data.error };
    }

    const ads = (data.ads || []).filter((ad) => {
      const price = ad.price?.[0];
      const square = Number(getAttr(ad, 'square'));
      return price >= 500000 && price <= 750000 && square > 120;
    });

    const prixM2 = ads
      .filter((ad) => ad.price?.[0] && Number(getAttr(ad, 'square')) > 0)
      .map((ad) => ad.price[0] / Number(getAttr(ad, 'square')));
    const avg = trimmedMean(prixM2);
    const min = prixM2.length > 0 ? Math.min(...prixM2) : null;
    const max = prixM2.length > 0 ? Math.max(...prixM2) : null;

    return {
      avgPrixM2: avg,
      min,
      max,
      count: ads.length,
      total: data.total || 0,
      listings: ads,
      fromCache: !!data.fromCache,
      refreshFailed: !!data.refreshFailed,
      fetchedAt: data.fetchedAt || null,
      error: null,
    };
  } catch (err) {
    return { avgPrixM2: null, count: 0, listings: [], error: err.message };
  }
}

async function fetchBienici(commune, refresh = false) {
  return fetchExternalSource('/api/bienici', commune, refresh, 'bienici');
}

async function fetchExternalSource(endpoint, commune, refresh, source) {
  try {
    const params = new URLSearchParams({
      city: commune.nom,
      zipcode: commune.codesPostaux?.[0] || '',
      department_id: commune.codeDepartement,
      ...(refresh ? { refresh: '1' } : {}),
    });
    const res = await fetch(`${endpoint}?${params}`);
    const data = await res.json();
    const ads = (data.ads || []).filter((ad) => {
      const price = ad.price?.[0];
      const square = Number(getAttr(ad, 'square'));
      return price >= 500000 && price <= 750000 && square > 120;
    });

    return {
      source,
      count: ads.length,
      total: data.total || ads.length,
      listings: ads,
      fromCache: !!data.fromCache,
      fetchedAt: data.fetchedAt || null,
      error: data.error || null,
    };
  } catch (err) {
    return { source, count: 0, listings: [], error: err.message };
  }
}

function getAttr(ad, key) {
  const attr = (ad.attributes || []).find((a) => a.key === key);
  return attr ? attr.value : null;
}

// --- Rendering ---
function showLoading() {
  document.getElementById('panel-placeholder').classList.add('hidden');
  document.getElementById('panel-results').classList.add('hidden');
  document.getElementById('panel-error').classList.add('hidden');
  document.getElementById('panel-loading').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('panel-placeholder').classList.add('hidden');
  document.getElementById('panel-loading').classList.add('hidden');
  document.getElementById('panel-results').classList.add('hidden');
  document.getElementById('panel-error').classList.remove('hidden');
  document.getElementById('error-message').textContent = msg;
}

const SOURCE_LABELS = {
  leboncoin: { name: 'Leboncoin', color: '#ff9800' },
  bienici: { name: "Bien'ici", color: '#00bcd4' },
};

let lastSources = {};

function renderResults(commune, dvf, lbc, bienici) {
  document.getElementById('panel-loading').classList.add('hidden');
  document.getElementById('panel-error').classList.add('hidden');
  document.getElementById('panel-placeholder').classList.add('hidden');
  document.getElementById('panel-results').classList.remove('hidden');

  document.getElementById('commune-name').textContent = commune.nom;
  document.getElementById('commune-info').textContent =
    `Code INSEE: ${commune.code} | CP: ${commune.codesPostaux?.[0] || 'N/A'} | Pop: ${commune.population?.toLocaleString('fr-FR') || 'N/A'}`;

  // DVF card
  document.getElementById('dvf-price').textContent = dvf.avgPrixM2 ? `${Math.round(dvf.avgPrixM2).toLocaleString('fr-FR')} €/m²` : 'N/A';
  document.getElementById('dvf-count').textContent = `${dvf.count} ventes`;
  const dvfRangeEl = document.getElementById('dvf-range');
  if (dvfRangeEl) dvfRangeEl.textContent = dvf.min ? `Min: ${Math.round(dvf.min).toLocaleString('fr-FR')} - Max: ${Math.round(dvf.max).toLocaleString('fr-FR')} €/m²` : '';

  // Marqueurs DVF sur la carte
  if (dvfMarkersLayer) {
    map.removeLayer(dvfMarkersLayer);
  }
  dvfMarkersLayer = L.layerGroup();
  for (const v of (dvf.ventes || [])) {
    if (!v.latitude || !v.longitude) continue;
    const prixM2 = Math.round(v.valeur_fonciere / v.surface_reelle_bati);
    const marker = L.circleMarker([v.latitude, v.longitude], {
      radius: 6,
      fillColor: '#42a5f5',
      color: '#1565c0',
      weight: 1,
      fillOpacity: 0.8,
    });
    marker.bindTooltip(
      `<strong>${v.valeur_fonciere.toLocaleString('fr-FR')} €</strong><br>` +
      `${prixM2.toLocaleString('fr-FR')} €/m²<br>` +
      `${v.type_local} — ${v.surface_reelle_bati} m²<br>` +
      `${v.adresse_numero || ''} ${v.adresse_nom_voie || ''}<br>` +
      `<em>${v.date_mutation}</em>`,
      { direction: 'top' }
    );
    dvfMarkersLayer.addLayer(marker);
  }
  dvfMarkersLayer.addTo(map);

  lastSources = { lbc, bienici };

  // Fusionner toutes les annonces avec dédoublonnage
  const allListings = [];
  const seenUrls = new Set();
  const seenKeys = new Set();
  const sources = [
    { data: lbc, key: 'leboncoin' },
    { data: bienici, key: 'bienici' },
  ];

  for (const s of sources) {
    if (!s.data) continue;
    for (const ad of (s.data.listings || [])) {
      // Dédoublonner par URL
      if (ad.url && seenUrls.has(ad.url)) continue;
      // Dédoublonner cross-source par prix + surface + ville
      const price = ad.price?.[0];
      const square = getAttr(ad, 'square');
      const city = ad.location?.city || ad.location?.zipcode || '';
      const dedupKey = `${price}_${square}_${city}`;
      if (price && square && seenKeys.has(dedupKey)) continue;
      if (ad.url) seenUrls.add(ad.url);
      if (price && square) seenKeys.add(dedupKey);
      allListings.push({ ...ad, _source: ad.source || s.key });
    }
  }

  // Trier par prix au m² croissant
  allListings.sort((a, b) => {
    const pA = a.price?.[0] && Number(getAttr(a, 'square')) > 0 ? a.price[0] / Number(getAttr(a, 'square')) : Infinity;
    const pB = b.price?.[0] && Number(getAttr(b, 'square')) > 0 ? b.price[0] / Number(getAttr(b, 'square')) : Infinity;
    return pA - pB;
  });

  currentAllListings = allListings;

  // Détecter les biens à rénover (depuis titre + body si dispo)
  const renovRegex = /[àa] r[eé]nover|travaux [àa] pr[eé]voir|[àa] rafra[iî]chir|[àa] restaurer|[àa] r[eé]habiliter|n[eé]cessite des travaux|gros travaux|remise en [eé]tat|[àa] remettre en [eé]tat|[àa] moderniser|enti[eè]rement [àa] refaire|totalement [àa] r[eé]nover|r[eé]novation compl[eè]te|r[eé]novation totale|gros potentiel|fort potentiel|id[eé]al investisseur|travaux importants|n[eé]cessite une r[eé]novation/i;

  const noRenovRegex = /aucun travaux|aucuns travaux|aucun travail|sans travaux|pas de travaux|rien [àa] faire|rien [àa] pr[eé]voir|z[eé]ro travaux|cl[eé]s? en main/i;

  allListings.forEach(ad => {
    const fullText = ((ad.subject || '') + ' ' + (ad.body || '')).toLowerCase();
    ad._isRenov = renovRegex.test(fullText) && !noRenovRegex.test(fullText);
  });

  const normalAds = allListings.filter(a => !a._isRenov);
  const renovAds = allListings.filter(a => a._isRenov);

  // Prix/m² par catégorie
  function calcPrixM2(ads) {
    const vals = ads
      .filter(ad => ad.price?.[0] && Number(getAttr(ad, 'square')) > 0)
      .map(ad => ad.price[0] / Number(getAttr(ad, 'square')));
    return { avg: trimmedMean(vals), count: ads.length };
  }

  const normalStats = calcPrixM2(normalAds);
  const renovStats = calcPrixM2(renovAds);

  // Carte "Annonces sans travaux"
  document.getElementById('lbc-price').textContent = normalStats.avg ? `${Math.round(normalStats.avg).toLocaleString('fr-FR')} €/m²` : 'N/A';
  document.getElementById('lbc-count').textContent = `${normalStats.count} annonces`;

  // Carte "Avec travaux"
  document.getElementById('renov-price').textContent = renovStats.avg ? `${Math.round(renovStats.avg).toLocaleString('fr-FR')} €/m²` : 'N/A';
  document.getElementById('renov-count').textContent = `${renovStats.count} annonces`;

  const container = document.getElementById('all-listings');

  // Header avec badges par source + bouton rafraîchir
  let headerHtml = '<div id="listings-header">';
  headerHtml += `<h3>${allListings.length} annonces</h3>`;
  headerHtml += '<div class="source-counts">';
  for (const s of sources) {
    const count = s.data?.listings?.length || 0;
    const label = SOURCE_LABELS[s.key];
    const cache = s.data?.fromCache ? ' (cache)' : '';
    headerHtml += `<span class="source-badge" style="background:${label.color}">${label.name}: ${count}${cache}</span>`;
  }
  headerHtml += '</div>';
  headerHtml += '<button id="refresh-all-btn">Rafraîchir tout</button>';
  headerHtml += '</div>';

  function renderAdCard(ad, i) {
    const price = ad.price?.[0];
    const surface = getAttr(ad, 'square');
    const rooms = getAttr(ad, 'rooms');
    const type = getAttr(ad, 'real_estate_type');
    const typeLabel = { '1': 'Maison', '2': 'Appart.', '3': 'Terrain', '4': 'Parking', '5': 'Autre' }[type] || '';
    const prixM2 = price && surface ? Math.round(price / Number(surface)) : null;
    const thumb = ad.images?.small_url || ad.images?.thumb_url || '';
    const locationLabel = ad.location?.city_label || [ad.location?.zipcode, ad.location?.city].filter(Boolean).join(' ') || '';
    const sourceInfo = SOURCE_LABELS[ad._source] || { name: ad._source, color: '#999' };

    const fav = isFavorite(ad.url);

    const hidden = isHidden(ad.url);
    const hideStyle = hidden && !showHiddenAds ? ' style="display:none"' : '';

    return `<div class="listing-item listing-item--lbc ${ad._isRenov ? 'listing-item--renov' : ''} ${fav ? 'listing-item--fav' : ''} ${hidden ? 'listing-item--hidden' : ''}" data-url="${ad.url || ''}"${hideStyle}>
      ${thumb ? `<div class="listing-thumb"><img src="${thumb}" alt="${ad.subject || ''}" loading="lazy" /></div>` : ''}
      <div class="listing-content">
        <div class="listing-top-row">
          <span class="source-badge source-badge--small" style="background:${sourceInfo.color}">${sourceInfo.name}</span>
          ${ad._isRenov ? '<span class="source-badge source-badge--small" style="background:#d84315">🔨 Travaux</span>' : ''}
          <button class="hide-btn ${hidden ? 'hide-btn--active' : ''}" data-hide-index="${i}" title="${hidden ? 'Réafficher' : 'Masquer'}">${hidden ? '👁' : '✕'}</button>
          <button class="fav-btn ${fav ? 'fav-btn--active' : ''}" data-fav-index="${i}" title="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${fav ? '★' : '☆'}</button>
        </div>
        <div class="listing-title">${ad.subject || 'Annonce'}</div>
        <div class="listing-location">${locationLabel}</div>
        <div class="listing-details">
          ${typeLabel} | ${surface || '?'} m² | ${rooms || '?'} pièces
        </div>
        <div class="listing-price-line">
          <span class="listing-price">${price?.toLocaleString('fr-FR')} €</span>
          ${prixM2 ? `<span class="listing-price-m2">(${prixM2.toLocaleString('fr-FR')} €/m²)</span>` : ''}
        </div>
        <div class="listing-summary" id="ad-summary-${i}"><span class="text-muted">Chargement du résumé...</span></div>
        ${ad.url ? `<a href="${ad.url}" target="_blank" rel="noopener">Voir l'annonce</a>` : ''}
      </div>
    </div>`;
  }

  if (allListings.length === 0) {
    container.innerHTML = headerHtml + '<p class="text-muted">Aucune annonce disponible</p>';
  } else {
    let html = headerHtml;

    // Liste principale
    html += `<h3 class="section-title" id="normal-title">${normalAds.length} bien${normalAds.length > 1 ? 's' : ''}</h3>`;
    html += `<div id="normal-listings">`;
    html += normalAds.map((ad) => renderAdCard(ad, allListings.indexOf(ad))).join('');
    html += `</div>`;

    // Liste des biens à rénover
    html += `<div style="${renovAds.length === 0 ? 'display:none' : ''}">`;
    html += `<h3 class="section-title section-title--renov" id="renov-title">🔨 ${renovAds.length} bien${renovAds.length > 1 ? 's' : ''} avec travaux</h3>`;
    html += `</div>`;
    html += `<div id="renov-listings">`;
    html += renovAds.map((ad) => renderAdCard(ad, allListings.indexOf(ad))).join('');
    html += `</div>`;

    container.innerHTML = html;

    // Résumés pour Leboncoin (chargés via Puppeteer)
    const lbcAds = allListings.filter(a => a._source === 'leboncoin');
    loadAdSummaries(lbcAds, allListings);

    // Résumés pour les autres sources (description déjà disponible)
    allListings.forEach((ad, i) => {
      if (ad._source !== 'leboncoin') {
        const el = document.getElementById(`ad-summary-${i}`);
        if (!el) return;
        let html = '';
        if (ad.body || ad.attributes?.length) {
          const tags = analyzeListing(ad.body, ad.attributes, ad.subject);
          if (tags.length > 0) {
            html += `<div class="listing-tags">${tags.map(t => `<span class="tag" style="color:${t.color}">${t.icon} ${t.label}</span>`).join('')}</div>`;
          }
        }
        if (ad.body) {
          const escaped = ad.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          html += `<details class="listing-description-collapse">
            <summary>Voir la description</summary>
            <p class="listing-description-body">${escaped.replace(/\n/g, '<br>')}</p>
          </details>`;
        }
        el.innerHTML = html || '';
      }
    });
  }

  // Bouton rafraîchir tout
  document.getElementById('refresh-all-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('refresh-all-btn');
    btn.disabled = true;
    btn.textContent = 'Chargement...';
    const [freshLbc, freshBienici] = await Promise.all([
      fetchLeboncoin(selectedCommune, true),
      fetchBienici(selectedCommune, true),
    ]);
    renderResults(selectedCommune, lastDvfData, freshLbc, freshBienici);
  });
}

// --- Résumé des annonces ---
function analyzeListing(body, attributes, subject) {
  const text = ((body || '') + ' ' + (subject || '')).toLowerCase();
  const tags = [];

  // Travaux / à rénover
  const renovRegex = /[àa] r[eé]nover|travaux [àa] pr[eé]voir|[àa] rafra[iî]chir|[àa] restaurer|[àa] r[eé]habiliter|n[eé]cessite des travaux|gros travaux|remise en [eé]tat|[àa] remettre en [eé]tat|[àa] moderniser|[àa] actualiser|enti[eè]rement [àa] refaire|totalement [àa] r[eé]nover|r[eé]novation compl[eè]te|r[eé]novation totale|gros potentiel|fort potentiel|id[eé]al investisseur|travaux importants|n[eé]cessite une r[eé]novation/i;
  const noRenovRegex = /aucun travaux|aucuns travaux|aucun travail|sans travaux|pas de travaux|rien [àa] faire|rien [àa] pr[eé]voir|z[eé]ro travaux|cl[eé]s? en main/i;
  if (renovRegex.test(text) && !noRenovRegex.test(text)) {
    tags.push({ icon: '🔨', label: 'Travaux / à rénover', color: '#d84315', isRenov: true });
  }

  // Logement secondaire / indépendant
  const logementSecondaire = /logement ind[eé]pendant|studio ind[eé]pendant|t[12] ind[eé]pendant|appartement ind[eé]pendant|gîte|g[iî]te|chambre d'h[oô]te|annexe habitable|maison d'amis|d[eé]pendance am[eé]nag[eé]e|second logement|logement annexe|habitation s[eé]par[eé]e|partie ind[eé]pendante|possibilit[eé] de cr[eé]er|divisible|deux logements|2 logements|bi-famille|bifamili/i;
  if (logementSecondaire.test(text)) {
    tags.push({ icon: '🏠', label: 'Logement secondaire possible', color: '#2e7d32' });
  }

  // Garage / atelier
  const garageMatch = text.match(/garage|atelier|hangar|local technique|remise|d[eé]pendance/i);
  if (garageMatch) {
    const word = garageMatch[0].charAt(0).toUpperCase() + garageMatch[0].slice(1);
    tags.push({ icon: '🔧', label: word, color: '#1565c0' });
  }

  // Piscine
  if (/piscine/.test(text)) {
    tags.push({ icon: '🏊', label: 'Piscine', color: '#0277bd' });
  } else {
    tags.push({ icon: '❌', label: 'Pas de piscine', color: '#999' });
  }

  // DPE / GES depuis attributs
  const dpe = (attributes || []).find(a => a.key === 'energy_rate')?.value;
  const ges = (attributes || []).find(a => a.key === 'ges')?.value;
  if (dpe) {
    const dpeColor = { 'A': '#2e7d32', 'B': '#558b2f', 'C': '#9e9d24', 'D': '#f9a825', 'E': '#ef6c00', 'F': '#d84315', 'G': '#b71c1c' }[dpe] || '#666';
    tags.push({ icon: '⚡', label: `DPE: ${dpe}`, color: dpeColor });
  }
  if (ges) {
    tags.push({ icon: '💨', label: `GES: ${ges}`, color: '#666' });
  }

  return tags;
}

async function loadAdSummaries(lbcAds, allListings) {
  for (const ad of lbcAds) {
    if (ad._descLoaded) continue;

    const i = allListings.indexOf(ad);
    const el = document.getElementById(`ad-summary-${i}`);
    if (!el || i === -1) continue;

    try {
      const res = await fetch(`/api/leboncoin/ad?url=${encodeURIComponent(ad.url)}`);
      const data = await res.json();

      if (data.body) ad.body = data.body;
      if (data.attributes?.length) ad._fullAttributes = data.attributes;
      ad._descLoaded = true;

      const tags = analyzeListing(data.body, data.attributes || ad.attributes, ad.subject);

      let html = '';
      if (tags.length > 0) {
        html += `<div class="listing-tags">${tags.map(t =>
          `<span class="tag" style="color:${t.color}">${t.icon} ${t.label}</span>`
        ).join('')}</div>`;
      }
      if (data.body) {
        const escaped = data.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += `<details class="listing-description-collapse">
          <summary>Voir la description</summary>
          <p class="listing-description-body">${escaped.replace(/\n/g, '<br>')}</p>
        </details>`;
      }
      el.innerHTML = html || '';

      // Si l'annonce est maintenant détectée comme "travaux", la déplacer visuellement
      const isNowRenov = tags.some(t => t.isRenov);
      if (isNowRenov && !ad._isRenov) {
        ad._isRenov = true;
        const card = el.closest('.listing-item');
        const renovSection = document.getElementById('renov-listings');
        if (card && renovSection) {
          card.classList.add('listing-item--renov');
          // Ajouter le badge travaux
          const content = card.querySelector('.listing-content');
          if (content && !content.querySelector('[style*="d84315"]')) {
            const badge = document.createElement('span');
            badge.className = 'source-badge source-badge--small';
            badge.style.background = '#d84315';
            badge.textContent = '🔨 Travaux';
            content.insertBefore(badge, content.children[1]);
          }
          renovSection.appendChild(card);
          // Mettre à jour les compteurs
          updateCategoryCounts();
        }
      }
    } catch (_) {
      el.innerHTML = '<span class="text-muted">Résumé indisponible</span>';
    }
  }
}

function updateCategoryCounts() {
  const normalCount = document.querySelectorAll('#normal-listings .listing-item').length;
  const renovCount = document.querySelectorAll('#renov-listings .listing-item').length;
  const normalTitle = document.getElementById('normal-title');
  const renovTitle = document.getElementById('renov-title');
  if (normalTitle) normalTitle.textContent = `${normalCount} bien${normalCount > 1 ? 's' : ''}`;
  if (renovTitle) renovTitle.textContent = `🔨 ${renovCount} bien${renovCount > 1 ? 's' : ''} avec travaux`;
  if (renovTitle) renovTitle.parentElement.style.display = renovCount > 0 ? '' : 'none';
}
