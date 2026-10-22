// Dependency-free OpenStreetMap slippy map layer (team amad).
// Web Mercator; the anchor (lat0, lon0) is the intersection centre, which is world (0,0) metres for the Scene.
// The Scene keeps the view centre as a metre offset (pan) from the anchor; this layer converts it to tiles.
// Metres <-> pixels use metres-per-pixel = 156543.03 * cos(lat0) / 2^zoom, so the overlay is drawn to scale.
const TILE = 256;
const URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const MAX_TILE_Z = 19;

const worldPx = (lat, lon, z) => {
  const W = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * W, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W];
};

export class TileMap {
  constructor(container) {
    this.el = container;
    this.tiles = document.createElement('div');
    this.tiles.className = 'map-tiles';
    this.markersEl = document.createElement('div');
    this.markersEl.className = 'map-markers';
    this.el.append(this.tiles);
    this.lat0 = null; this.lon0 = null;
    this.zoom = 18;
    this.enabled = false;
    this.markers = [];          // [{ id, name, lat, lon }]
    this.showMarkers = false;
    this.selectedId = null;
    this.hideSelected = false;  // the selected junction is drawn by the Scene when zoomed in
    this.onMarker = null;       // (id) => void
    this.onFail = null;         // () => void, when tiles cannot be loaded (offline)
    this._imgs = new Map();
    this._loaded = 0; this._errors = 0; this._failed = false;
  }

  // The markers layer must sit above the canvas to be clickable; the app mounts it.
  mountMarkers(parent) { parent.append(this.markersEl); }

  get ready() { return this.enabled && this.lat0 != null && this.lon0 != null && !this._failed; }
  setAnchor(lat, lon) { this.lat0 = lat; this.lon0 = lon; }
  setEnabled(on) {
    this.enabled = on;
    this.el.hidden = !on;
    this.markersEl.hidden = !on;
  }
  setZoom(z) { this.zoom = Math.max(3, Math.min(20, z)); }
  mpp(z = this.zoom) { return (156543.03 * Math.cos((this.lat0 * Math.PI) / 180)) / 2 ** z; }
  pxPerMetre() { return 1 / this.mpp(); }
  // metre offset (east, north) of a lat/lon from the anchor, consistent with the tiles at any zoom
  offsetMetres(lat, lon) {
    const [ax, ay] = worldPx(this.lat0, this.lon0, 0);
    const [x, y] = worldPx(lat, lon, 0);
    const m = this.mpp(0);
    return [(x - ax) * m, -(y - ay) * m];
  }
  // zoom + pan (metres from anchor) that fit all markers in a w x h view
  fitMarkers(w, h, pad = 80) {
    if (!this.markers.length || this.lat0 == null) return null;
    const offs = this.markers.map((m) => this.offsetMetres(m.lat, m.lon));
    const xs = offs.map((o) => o[0]), ys = offs.map((o) => o[1]);
    const spanX = Math.max(200, Math.max(...xs) - Math.min(...xs));
    const spanY = Math.max(200, Math.max(...ys) - Math.min(...ys));
    const mppNeeded = Math.max(spanX / Math.max(1, w - 2 * pad), spanY / Math.max(1, h - 2 * pad));
    const z = Math.log2((156543.03 * Math.cos((this.lat0 * Math.PI) / 180)) / mppNeeded);
    return { zoom: Math.max(3, Math.min(18, Math.floor(z * 2) / 2)), pan: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2] };
  }

  // Draw tiles for a view centred on `pan` metres from the anchor, w x h CSS pixels.
  render(pan, w, h) {
    if (!this.ready) return;
    const tz = Math.max(0, Math.min(MAX_TILE_Z, Math.round(this.zoom)));
    const k = 2 ** (this.zoom - tz);              // CSS scale of a tile-zoom pixel
    const [ax, ay] = worldPx(this.lat0, this.lon0, tz);
    const mTz = this.mpp(tz);
    const cx = ax + pan[0] / mTz, cy = ay - pan[1] / mTz; // view centre in tile-zoom world pixels
    const n = 2 ** tz;
    const x0 = Math.floor((cx - w / 2 / k) / TILE), x1 = Math.floor((cx + w / 2 / k) / TILE);
    const y0 = Math.max(0, Math.floor((cy - h / 2 / k) / TILE)), y1 = Math.min(n - 1, Math.floor((cy + h / 2 / k) / TILE));
    const want = new Set();
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const key = `${tz}/${wx}/${ty}`;
      want.add(key + '@' + tx);
      let img = this._imgs.get(key + '@' + tx);
      if (!img) {
        img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.draggable = false;
        img.referrerPolicy = 'strict-origin-when-cross-origin';
        img.addEventListener('load', () => { this._loaded++; img.classList.add('in'); });
        img.addEventListener('error', () => { this._errors++; img.remove(); this._checkFail(); });
        img.src = URL(tz, wx, ty);
        this.tiles.append(img);
        this._imgs.set(key + '@' + tx, img);
      }
      const size = TILE * k;
      img.style.transform = `translate(${w / 2 + (tx * TILE - cx) * k}px, ${h / 2 + (ty * TILE - cy) * k}px)`;
      img.style.width = img.style.height = `${size + 0.5}px`;
    }
    for (const [key, img] of this._imgs) if (!want.has(key)) { img.remove(); this._imgs.delete(key); }
    this._renderMarkers(pan, w, h);
  }

  _renderMarkers(pan, w, h) {
    if (!this.showMarkers || !this.markers.length) { this.markersEl.replaceChildren(); return; }
    const s = this.pxPerMetre();
    if (this.markersEl.childElementCount !== this.markers.length) {
      this.markersEl.replaceChildren(...this.markers.map((m) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'marker';
        b.dataset.id = m.id;
        b.title = `${m.name} (click to load)`;
        b.innerHTML = '<span class="pin"></span><span class="lbl"></span>';
        b.querySelector('.lbl').textContent = m.name;
        b.addEventListener('click', (e) => { e.stopPropagation(); if (this.onMarker) this.onMarker(m.id); });
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        return b;
      }));
    }
    [...this.markersEl.children].forEach((b, i) => {
      const m = this.markers[i];
      const [ox, oy] = this.offsetMetres(m.lat, m.lon);
      b.style.transform = `translate(${w / 2 + (ox - pan[0]) * s}px, ${h / 2 - (oy - pan[1]) * s}px)`;
      b.classList.toggle('sel', m.id === this.selectedId);
      b.hidden = this.hideSelected && m.id === this.selectedId;
    });
  }

  _checkFail() {
    if (!this._failed && this._loaded === 0 && this._errors >= 4) {
      this._failed = true;
      for (const img of this._imgs.values()) img.remove();
      this._imgs.clear();
      if (this.onFail) this.onFail();
    }
  }
}
