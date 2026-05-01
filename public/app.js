// --- State ---
let map;
let communeLayer = null;
let selectedCommune = null;
let searchTimeout = null;
let lastDvfData = null;
let dvfMarkersLayer = null;
let tramLayer = null;
let cachedCommunesLayer = null;

// --- Filtres de recherche (paramétrables) ---
const DEFAULT_FILTERS = {
  minPrice: 500000,
  maxPrice: 750000,
  minSurface: 120,
  maxSurface: null,
  propertyTypes: ['house', 'flat'],
};

function getFilters() {
  try {
    const raw = localStorage.getItem('homeSearchFilters');
    if (!raw) return { ...DEFAULT_FILTERS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FILTERS, ...parsed };
  } catch (_) {
    return { ...DEFAULT_FILTERS };
  }
}

function saveFilters(f) {
  localStorage.setItem('homeSearchFilters', JSON.stringify(f));
}

// Construit les query params filtres pour les API
function filterQueryParams() {
  const f = getFilters();
  const params = {};
  if (f.minPrice != null && f.minPrice !== '') params.min_price = f.minPrice;
  if (f.maxPrice != null && f.maxPrice !== '') params.max_price = f.maxPrice;
  if (f.minSurface != null && f.minSurface !== '') params.min_surface = f.minSurface;
  if (f.maxSurface != null && f.maxSurface !== '') params.max_surface = f.maxSurface;
  if (f.propertyTypes?.length) params.property_types = f.propertyTypes.join(',');
  return params;
}

// Mappe le real_estate_type LBC ('1','2') vers nos codes ('house','flat')
function adPropertyType(ad) {
  const t = getAttr(ad, 'real_estate_type');
  if (t === '1') return 'house';
  if (t === '2') return 'flat';
  return null;
}

// Vérifie qu'une annonce passe les filtres courants
function matchesFilters(ad) {
  const f = getFilters();
  const price = ad.price?.[0];
  const square = Number(getAttr(ad, 'square'));
  if (f.minPrice && (!price || price < f.minPrice)) return false;
  if (f.maxPrice && (!price || price > f.maxPrice)) return false;
  if (f.minSurface && (!square || square < f.minSurface)) return false;
  if (f.maxSurface && (!square || square > f.maxSurface)) return false;
  if (f.propertyTypes?.length) {
    const t = adPropertyType(ad);
    if (t && !f.propertyTypes.includes(t)) return false;
  }
  return true;
}

function matchesFiltersDvf(m) {
  const f = getFilters();
  const v = m.valeur_fonciere;
  const s = m.surface_reelle_bati;
  if (f.minPrice && v < f.minPrice) return false;
  if (f.maxPrice && v > f.maxPrice) return false;
  if (f.minSurface && s < f.minSurface) return false;
  if (f.maxSurface && s > f.maxSurface) return false;
  if (f.propertyTypes?.length) {
    const wantHouse = f.propertyTypes.includes('house');
    const wantFlat = f.propertyTypes.includes('flat');
    if (m.type_local === 'Maison' && !wantHouse) return false;
    if (m.type_local === 'Appartement' && !wantFlat) return false;
    if (m.type_local !== 'Maison' && m.type_local !== 'Appartement') return false;
  } else {
    if (m.type_local !== 'Maison' && m.type_local !== 'Appartement') return false;
  }
  return true;
}

// --- Date de mise en ligne ---
function adPublishedAt(ad) {
  const raw = ad.first_publication_date || ad.index_date || ad.publicationDate || ad._publishedAt;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function formatRelativeDate(date) {
  if (!date) return '';
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays < 0) return date.toLocaleDateString('fr-FR');
  if (diffDays === 0) return "aujourd'hui";
  if (diffDays === 1) return 'hier';
  if (diffDays < 7) return `il y a ${diffDays} j`;
  if (diffDays < 30) return `il y a ${Math.floor(diffDays / 7)} sem.`;
  if (diffDays < 365) return `il y a ${Math.floor(diffDays / 30)} mois`;
  return date.toLocaleDateString('fr-FR');
}

function setupFilters() {
  const f = getFilters();
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v == null ? '' : v;
  };
  setVal('filter-min-price', f.minPrice);
  setVal('filter-max-price', f.maxPrice);
  setVal('filter-min-surface', f.minSurface);
  setVal('filter-max-surface', f.maxSurface);
  const elHouse = document.getElementById('filter-type-house');
  const elFlat = document.getElementById('filter-type-flat');
  if (elHouse) elHouse.checked = f.propertyTypes?.includes('house');
  if (elFlat) elFlat.checked = f.propertyTypes?.includes('flat');
}

function readFiltersFromUI() {
  const num = (id) => {
    const v = document.getElementById(id)?.value;
    return v === '' || v == null ? null : Number(v);
  };
  const types = [];
  if (document.getElementById('filter-type-house')?.checked) types.push('house');
  if (document.getElementById('filter-type-flat')?.checked) types.push('flat');
  return {
    minPrice: num('filter-min-price'),
    maxPrice: num('filter-max-price'),
    minSurface: num('filter-min-surface'),
    maxSurface: num('filter-max-surface'),
    propertyTypes: types,
  };
}

function toggleFiltersPanel() {
  const panel = document.getElementById('filters-panel');
  const btn = document.getElementById('filters-btn');
  if (!panel) return;
  panel.classList.toggle('hidden');
  btn?.classList.toggle('active', !panel.classList.contains('hidden'));
}

async function applyFilters() {
  const next = readFiltersFromUI();
  saveFilters(next);

  // Rafraîchir le cache de toutes les communes avec les nouveaux critères
  await refreshAllCachedCommunes();

  // Recharger la vue selon le contexte
  if (selectedCommune) {
    const [dvfData, lbcData, bieniciData] = await Promise.all([
      fetchDVF(selectedCommune),
      fetchLeboncoin(selectedCommune),
      fetchBienici(selectedCommune),
    ]);
    lastDvfData = dvfData;
    renderResults(selectedCommune, dvfData, lbcData, bieniciData);
  } else {
    showAllCached();
  }
}

async function refreshAllCachedCommunes() {
  const applyBtn = document.getElementById('filters-apply');
  let cached = [];
  try {
    const res = await fetch('/api/cached-communes');
    cached = await res.json();
  } catch (_) { return; }
  if (!cached.length) return;

  const originalLabel = applyBtn?.textContent;
  if (applyBtn) applyBtn.disabled = true;

  for (let i = 0; i < cached.length; i++) {
    const c = cached[i];
    const label = c.city || c.zipcode;
    if (applyBtn) applyBtn.textContent = `${label} (${i + 1}/${cached.length})...`;
    try {
      const geoRes = await fetch(`/api/communes?codePostal=${c.zipcode}&limit=1`);
      const communes = await geoRes.json();
      if (!communes.length) continue;
      const commune = communes[0];
      const coords = commune.centre?.coordinates;
      const params = new URLSearchParams({
        city: commune.nom,
        zipcode: commune.codesPostaux?.[0] || '',
        department_id: commune.codeDepartement,
        refresh: '1',
        ...(coords ? { lat: coords[1], lng: coords[0] } : {}),
        ...filterQueryParams(),
      });
      await Promise.all([
        fetch(`/api/leboncoin?${params}`),
        fetch(`/api/bienici?${params}`),
      ]);
    } catch (_) {}
  }

  if (applyBtn) {
    applyBtn.disabled = false;
    applyBtn.textContent = originalLabel || 'Appliquer';
  }
}

function resetFilters() {
  saveFilters({ ...DEFAULT_FILTERS });
  setupFilters();
}

// --- Resize horizontal de la carte / panel ---
function applyPanelWidth(width) {
  const panel = document.getElementById('panel');
  if (!panel) return;
  // Sur mobile, on ne fixe pas de largeur px (le CSS gère 100%)
  if (window.innerWidth <= 640) {
    panel.style.width = '';
    panel.dataset.responsiveTier = 'compact';
    return;
  }
  const min = 320;
  const max = Math.max(min, window.innerWidth - 280);
  const w = Math.min(max, Math.max(min, width));
  panel.style.width = w + 'px';
  panel.dataset.responsiveTier = w >= 680 ? 'wide' : (w >= 500 ? 'medium' : 'compact');
  if (map) map.invalidateSize();
}

function initPanelResizer() {
  const resizer = document.getElementById('panel-resizer');
  const panel = document.getElementById('panel');
  if (!resizer || !panel) return;

  // Restaurer la largeur sauvegardée
  const saved = Number(localStorage.getItem('homeSearchPanelWidth'));
  if (saved && saved > 200) applyPanelWidth(saved);
  else applyPanelWidth(panel.getBoundingClientRect().width);

  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('resizing');
    document.body.classList.add('resizing-panel');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newWidth = window.innerWidth - e.clientX - 3; // 3 = moitié largeur resizer
    applyPanelWidth(newWidth);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('resizing');
    document.body.classList.remove('resizing-panel');
    const w = panel.getBoundingClientRect().width;
    localStorage.setItem('homeSearchPanelWidth', String(Math.round(w)));
  });

  window.addEventListener('resize', () => {
    const w = panel.getBoundingClientRect().width;
    applyPanelWidth(w);
  });
}

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

// --- Annotations utilisateur (clé = url, valeur = texte libre) ---
let _annotationsCache = {};

async function loadAnnotationsFromDisk() {
  try {
    const res = await fetch('/api/annotations');
    _annotationsCache = await res.json();
  } catch (_) {
    _annotationsCache = {};
  }
}

function getAnnotation(adUrl) {
  return _annotationsCache[adUrl] || '';
}

function saveAnnotation(adUrl, text) {
  if (text && text.trim()) {
    _annotationsCache[adUrl] = text.trim();
  } else {
    delete _annotationsCache[adUrl];
  }
  fetch('/api/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_annotationsCache),
  }).catch(() => {});
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderAnnotationBlock(adUrl) {
  const note = getAnnotation(adUrl);
  const safe = escapeHtml(note);
  const hasNote = !!note;
  return `<div class="listing-annotation ${hasNote ? 'listing-annotation--has' : ''}" data-annotation-url="${escapeHtml(adUrl)}">
    <span class="listing-annotation-text">${hasNote ? '📝 ' + safe : ''}</span>
    <button class="annotation-btn" data-annotation-url="${escapeHtml(adUrl)}" title="${hasNote ? 'Modifier l\'annotation' : 'Ajouter une annotation'}">${hasNote ? '✏️' : '+ Note'}</button>
  </div>`;
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

// Event listener délégué : clic sur "+ Note" ou "✏️" → édite l'annotation
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.annotation-btn[data-annotation-url]');
  if (!btn) return;
  const url = btn.dataset.annotationUrl;
  const current = getAnnotation(url);
  const next = prompt('Annotation pour ce bien :', current);
  if (next === null) return; // annulé
  saveAnnotation(url, next);
  // Mettre à jour le bloc dans la card
  const card = btn.closest('.listing-item');
  const block = card?.querySelector('.listing-annotation');
  if (block) block.outerHTML = renderAnnotationBlock(url);
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
          ${url ? renderAnnotationBlock(url) : ''}
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
      if (!matchesFilters(ad)) return false;
      const price = ad.price?.[0];
      const square = Number(getAttr(ad, 'square'));
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

    // Trier par date de publication (récentes d'abord), fallback prix/m²
    ads.sort((a, b) => {
      const dA = adPublishedAt(a);
      const dB = adPublishedAt(b);
      if (dA && dB) return dB - dA;
      if (dA) return -1;
      if (dB) return 1;
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

      const pubDate = adPublishedAt(ad);
      const pubLabel = pubDate ? formatRelativeDate(pubDate) : '';
      const pubTitle = pubDate ? pubDate.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

      const tags = analyzeListing(ad.body, ad.attributes, ad.subject);
      const tagsHtml = tags.length > 0
        ? `<div class="listing-tags">${tags.map(t => `<span class="tag" style="color:${t.color}">${t.icon} ${t.label}</span>`).join('')}</div>`
        : '';

      return `<div class="listing-item listing-item--lbc ${ad._isRenov ? 'listing-item--renov' : ''} ${fav ? 'listing-item--fav' : ''} ${hidden ? 'listing-item--hidden' : ''}" data-url="${ad.url || ''}"${hideStyle}>
        ${thumb ? `<div class="listing-thumb"><img src="${thumb}" alt="${ad.subject || ''}" loading="lazy" /></div>` : ''}
        <div class="listing-content">
          <div class="listing-top-row">
            <span class="source-badge source-badge--small" style="background:${sourceInfo.color}">${sourceInfo.name}</span>
            ${ad._isRenov ? '<span class="source-badge source-badge--small" style="background:#d84315">🔨 Travaux</span>' : ''}
            ${pubLabel ? `<span class="listing-date" title="${pubTitle}">📅 ${pubLabel}</span>` : ''}
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
          ${tagsHtml}
          ${ad.url ? renderAnnotationBlock(ad.url) : ''}
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

    // Stats LBC agrégées (sans travaux / avec travaux)
    const calcPrixM2 = (adsArr) => {
      const vals = adsArr
        .map(ad => {
          const p = Number(ad.price?.[0]);
          const sq = Number(getAttr(ad, 'square'));
          return p > 0 && sq > 0 ? p / sq : NaN;
        })
        .filter(v => Number.isFinite(v));
      return { avg: trimmedMean(vals), count: adsArr.length };
    };
    const normalStats = calcPrixM2(normalAds);
    const renovStats = calcPrixM2(renovAds);
    document.getElementById('lbc-price').textContent = normalStats.avg ? `${Math.round(normalStats.avg).toLocaleString('fr-FR')} €/m²` : '--';
    document.getElementById('lbc-count').textContent = `${normalStats.count} annonces`;
    document.getElementById('renov-price').textContent = renovStats.avg ? `${Math.round(renovStats.avg).toLocaleString('fr-FR')} €/m²` : '--';
    document.getElementById('renov-count').textContent = `${renovStats.count} annonces`;

    // Stats DVF agrégées sur toutes les communes en cache (chargées en arrière-plan)
    document.getElementById('dvf-price').textContent = '...';
    document.getElementById('dvf-count').textContent = `${cachedCommunes.length} communes`;
    Promise.all(cachedCommunes.map(async (c) => {
      try {
        const geoRes = await fetch(`/api/communes?codePostal=${c.zipcode}&limit=1`);
        const communes = await geoRes.json();
        if (!communes.length) return null;
        return await fetchDVF(communes[0]);
      } catch (_) { return null; }
    })).then(results => {
      const allVentes = [];
      results.forEach(r => { if (r?.ventes) allVentes.push(...r.ventes); });
      const prixM2 = allVentes.map((m) => m.valeur_fonciere / m.surface_reelle_bati);
      const avg = trimmedMean(prixM2);
      const dvfPriceEl = document.getElementById('dvf-price');
      const dvfCountEl = document.getElementById('dvf-count');
      if (dvfPriceEl) dvfPriceEl.textContent = avg ? `${Math.round(avg).toLocaleString('fr-FR')} €/m²` : '--';
      if (dvfCountEl) dvfCountEl.textContent = `${allVentes.length} ventes`;
    });

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
    html += normalAds.map(ad => renderCachedCard(ad, ads.indexOf(ad))).join('');
    html += '</div>';

    if (renovAds.length > 0) {
      html += `<div><h3 class="section-title section-title--renov" id="renov-title">🔨 ${renovAds.length} bien${renovAds.length > 1 ? 's' : ''} avec travaux</h3></div>`;
      html += '<div id="renov-listings">';
      html += renovAds.map(ad => renderCachedCard(ad, ads.indexOf(ad))).join('');
      html += '</div>';
    }

    container.innerHTML = html;
    updateCategoryCounts();

    // Bouton supprimer une commune du cache (toutes variantes de filtres)
    container.querySelectorAll('.commune-tag-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const key = btn.dataset.cacheKey;
        const baseKey = key.split('|')[0];
        await fetch(`/api/cache/${encodeURIComponent(baseKey + '|*')}`, { method: 'DELETE' });
        btn.closest('.commune-tag')?.remove();
        // Recharger la vue
        showAllCached();
        loadCachedCommunes();
      });
    });

    // Helper : recharge les annonces et met à jour uniquement les listes (sans rebuild du header)
    async function reloadListingsContent() {
      try {
        const r = await fetch('/api/all-cached-ads');
        const d = await r.json();
        const seenU = new Set(), seenK = new Set();
        const newAds = (d.ads || []).filter(ad => {
          if (!matchesFilters(ad)) return false;
          const p = ad.price?.[0];
          const sq = Number(getAttr(ad, 'square'));
          if (ad.url && seenU.has(ad.url)) return false;
          const city = ad.location?.city || ad.location?.zipcode || '';
          const dk = `${p}_${sq}_${city}`;
          if (p && sq && seenK.has(dk)) return false;
          if (ad.url) seenU.add(ad.url);
          if (p && sq) seenK.add(dk);
          return true;
        });
        newAds.sort((a, b) => {
          const dA = adPublishedAt(a), dB = adPublishedAt(b);
          if (dA && dB) return dB - dA;
          if (dA) return -1;
          if (dB) return 1;
          const pA = a.price?.[0] / Number(getAttr(a, 'square')) || Infinity;
          const pB = b.price?.[0] / Number(getAttr(b, 'square')) || Infinity;
          return pA - pB;
        });
        newAds.forEach(ad => {
          const ft = ((ad.subject || '') + ' ' + (ad.body || '')).toLowerCase();
          ad._isRenov = renovRegex.test(ft) && !noRenovRegex.test(ft);
        });
        currentAllListings = newAds;
        const newNormal = newAds.filter(a => !a._isRenov);
        const newRenov = newAds.filter(a => a._isRenov);

        const infoEl = document.getElementById('commune-info');
        if (infoEl) infoEl.textContent = `${newAds.length} annonces en cache`;
        const headerH3 = document.querySelector('#listings-header h3');
        if (headerH3) headerH3.textContent = 'Toutes les annonces en cache (' + newAds.length + ')';

        const normalEl = document.getElementById('normal-listings');
        if (normalEl) normalEl.innerHTML = newNormal.map(ad => renderCachedCard(ad, newAds.indexOf(ad))).join('');
        const renovEl = document.getElementById('renov-listings');
        if (renovEl) renovEl.innerHTML = newRenov.map(ad => renderCachedCard(ad, newAds.indexOf(ad))).join('');

        updateCategoryCounts();
      } catch (_) {}
    }

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
            ...filterQueryParams(),
          });
          await Promise.all([
            fetch(`/api/leboncoin?${params}`),
            fetch(`/api/bienici?${params}`),
          ]);
          // Mettre à jour la liste après chaque commune (toutes communes confondues)
          await reloadListingsContent();
        } catch (_) {}
      }

      btn.disabled = false;
      btn.textContent = 'Rafraîchir tout';
    });
  } catch (_) {
    document.getElementById('panel-loading')?.classList.add('hidden');
    container.innerHTML = '<p class="text-muted">Erreur lors du chargement des annonces en cache</p>';
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
  setupFilters();
  initPanelResizer();
  await Promise.all([loadFavoritesFromDisk(), loadHiddenFromDisk(), loadAnnotationsFromDisk()]);
  updateFavCount();
  updateHiddenCount();
  initSearch();

  // Afficher les communes en cache sur la carte
  loadCachedCommunes();

  // Vue par défaut : toutes les annonces de toutes les communes en cache
  showAllCached();
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
  // Centré sur Montpellier par défaut (zoom métropole)
  map = L.map('map').setView([43.6108, 3.8767], 11);

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

    const ventes = (Array.isArray(data) ? data : []).filter(matchesFiltersDvf);

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
      ...filterQueryParams(),
    });

    const res = await fetch(`/api/leboncoin?${params}`);
    const data = await res.json();

    if (data.error) {
      return { avgPrixM2: null, count: 0, listings: [], error: data.hint || data.error };
    }

    const ads = (data.ads || []).filter(matchesFilters);

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
      ...filterQueryParams(),
    });
    const res = await fetch(`${endpoint}?${params}`);
    const data = await res.json();
    const ads = (data.ads || []).filter(matchesFilters);

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

  // Trier par date de publication (récentes d'abord), fallback prix/m²
  allListings.sort((a, b) => {
    const dA = adPublishedAt(a);
    const dB = adPublishedAt(b);
    if (dA && dB) return dB - dA;
    if (dA) return -1;
    if (dB) return 1;
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

  // Prix/m² par catégorie (filtre les valeurs non finies pour éviter qu'une annonce
  // corrompue type price=[[810000, null]] ne contamine la moyenne)
  function calcPrixM2(ads) {
    const vals = ads
      .map(ad => {
        const p = Number(ad.price?.[0]);
        const sq = Number(getAttr(ad, 'square'));
        return p > 0 && sq > 0 ? p / sq : NaN;
      })
      .filter(v => Number.isFinite(v));
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
  headerHtml += '<button id="delete-commune-cache-btn" title="Supprimer cette commune du cache">🗑️ Supprimer du cache</button>';
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

    const pubDate = adPublishedAt(ad);
    const pubLabel = pubDate ? formatRelativeDate(pubDate) : '';
    const pubTitle = pubDate ? pubDate.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '';

    return `<div class="listing-item listing-item--lbc ${ad._isRenov ? 'listing-item--renov' : ''} ${fav ? 'listing-item--fav' : ''} ${hidden ? 'listing-item--hidden' : ''}" data-url="${ad.url || ''}"${hideStyle}>
      ${thumb ? `<div class="listing-thumb"><img src="${thumb}" alt="${ad.subject || ''}" loading="lazy" /></div>` : ''}
      <div class="listing-content">
        <div class="listing-top-row">
          <span class="source-badge source-badge--small" style="background:${sourceInfo.color}">${sourceInfo.name}</span>
          ${ad._isRenov ? '<span class="source-badge source-badge--small" style="background:#d84315">🔨 Travaux</span>' : ''}
          ${pubLabel ? `<span class="listing-date" title="${pubTitle}">📅 ${pubLabel}</span>` : ''}
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
        ${ad.url ? renderAnnotationBlock(ad.url) : ''}
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
    updateCategoryCounts();

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

  // Bouton supprimer cette commune du cache
  document.getElementById('delete-commune-cache-btn')?.addEventListener('click', async () => {
    if (!selectedCommune) return;
    const name = selectedCommune.nom || selectedCommune.codesPostaux?.[0] || 'cette commune';
    if (!confirm(`Supprimer ${name} du cache ?`)) return;
    const zipcode = selectedCommune.codesPostaux?.[0];
    // "|*" supprime toutes les variantes de filtres pour cette commune
    const cacheKey = `${selectedCommune.nom}_${zipcode}|*`;
    await fetch(`/api/cache/${encodeURIComponent(cacheKey)}`, { method: 'DELETE' });
    loadCachedCommunes();
    showAllCached();
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
  const logementSecondaire = /logement ind[eé]pendant|studio ind[eé]pendant|t[12] ind[eé]pendant|appartement ind[eé]pendant|studio attenant|appartement attenant|gîte|g[iî]te|chambre d'h[oô]te|annexe habitable|maison d'amis|d[eé]pendance am[eé]nag[eé]e|second logement|logement annexe|logement s[eé]par[eé]|habitation s[eé]par[eé]e|partie ind[eé]pendante|partie habitable|possibilit[eé] de cr[eé]er|possibilit[eé] de divis|divisible|deux logements|2 logements|bi-famille|bifamili|entr[eé]e ind[eé]pendante|2 entr[eé]es|deux entr[eé]es|double entr[eé]e|convertible en|am[eé]nageable en|potentiel locatif|rapport locatif|louer une partie|airbnb|location saisonni[eè]re/i;
  if (logementSecondaire.test(text)) {
    tags.push({ icon: '🏠', label: 'Logement secondaire possible', color: '#2e7d32' });
  }

  // Garage / atelier
  const garageRegex = /\bgarages?\b|\batelier\b|\bhangar\b|\blocal technique\b|\bremise\b|\bd[eé]pendance/i;
  const garageMatch = text.match(garageRegex);
  if (garageMatch) {
    const word = garageMatch[0].charAt(0).toUpperCase() + garageMatch[0].slice(1);
    tags.push({ icon: '🔧', label: word, color: '#1565c0' });
  } else {
    tags.push({ icon: '❌', label: 'Pas de garage', color: '#999' });
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
  const countVisible = (selector) => {
    let n = 0;
    document.querySelectorAll(selector).forEach(card => {
      if (showHiddenAds || !card.classList.contains('listing-item--hidden')) n++;
    });
    return n;
  };
  const normalCount = countVisible('#normal-listings .listing-item');
  const renovCount = countVisible('#renov-listings .listing-item');
  const normalTitle = document.getElementById('normal-title');
  const renovTitle = document.getElementById('renov-title');
  if (normalTitle) normalTitle.textContent = `${normalCount} bien${normalCount > 1 ? 's' : ''}`;
  if (renovTitle) renovTitle.textContent = `🔨 ${renovCount} bien${renovCount > 1 ? 's' : ''} avec travaux`;
  if (renovTitle) renovTitle.parentElement.style.display = renovCount > 0 ? '' : 'none';
}
