# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projet

Comparateur de prix immobilier qui confronte les annonces Leboncoin au prix réel des transactions enregistrées par l'État via les DVF (Demandes de Valeurs Foncières). L'utilisateur sélectionne une commune sur une carte interactive Leaflet.

## Commandes

- `npm start` — Démarre le serveur en production (ouvre un navigateur Chromium visible pour le scraping Leboncoin)
- `npm run dev` — Démarre avec `--watch` (rechargement automatique)
- Le serveur écoute sur `http://localhost:3000`

## Architecture

```
server.js          → Backend Express, 4 routes API + Puppeteer pour Leboncoin
public/
  index.html       → Page unique SPA
  style.css        → Styles
  app.js           → Logique frontend (carte Leaflet, appels API, rendu)
```

**Backend (server.js)** — Sert les fichiers statiques et expose 4 endpoints :
- `GET /api/communes` — Proxy vers geo.api.gouv.fr (recherche commune par nom, CP ou coordonnées)
- `GET /api/communes/:code/contour` — Récupère le contour GeoJSON d'une commune
- `GET /api/dvf` — Télécharge et parse les CSV DVF depuis files.data.gouv.fr (par commune/année)
- `GET /api/leboncoin` — Scraping via Puppeteer (mode visible obligatoire pour passer Datadome), extrait les données de `__NEXT_DATA__`

**Frontend (public/app.js)** — Tout le state est en variables globales. Le flux principal :
1. L'utilisateur clique sur la carte ou cherche une commune → appel `/api/communes`
2. Le contour est affiché sur Leaflet → appel `/api/communes/:code/contour`
3. DVF + Leboncoin sont appelés en parallèle
4. Le panneau latéral affiche la comparaison prix/m² et les dernières annonces/transactions

## APIs externes et scraping

| Source | Méthode | Notes |
|--------|---------|-------|
| geo.api.gouv.fr | API REST (proxy) | Aucune auth, recherche communes + contours GeoJSON |
| files.data.gouv.fr/geo-dvf | CSV téléchargés | Fichiers par commune/année, parsés côté serveur |
| leboncoin.fr | Puppeteer (mode visible) | Datadome bloque le headless — le mode visible est requis. Les données sont extraites de `__NEXT_DATA__` (Next.js SSR). Une instance Chromium reste ouverte et est réutilisée entre les requêtes. |

Le frontend gère gracieusement le cas où Leboncoin est indisponible (affiche "N/A").

## Langue

L'interface et les commentaires sont en français.
