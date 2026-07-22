import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { TopoSite } from '../types';

/**
 * Geographic site map (P33) — plots each site with coordinates on an OpenStreetMap
 * base layer, colored by the worst device status in that site. Tiles load from
 * openstreetmap.org (needs internet from the browser); markers are pure CSS
 * (L.divIcon) so they render even when tiles don't, and carry no bundled image
 * assets. Read-only: RubyMIK never invents a location — a site appears only once
 * an admin has set its coordinates.
 */

const STATUS_COLOR: Record<string, string> = {
  down: '#ef4444', rebooting: '#3b82f6', warning: '#f59e0b', up: '#22c55e', pending: '#9ca3af',
};

function pin(color: string, label: string): L.DivIcon {
  return L.divIcon({
    className: 'rubymik-pin',
    html: `<div style="position:relative;width:26px;height:36px">
      <svg width="26" height="36" viewBox="0 0 26 36" xmlns="http://www.w3.org/2000/svg">
        <path d="M13 0C5.8 0 0 5.8 0 13c0 9.2 13 23 13 23s13-13.8 13-23C26 5.8 20.2 0 13 0z" fill="${color}" stroke="#0008" stroke-width="1"/>
        <circle cx="13" cy="13" r="6" fill="#fff" fill-opacity="0.92"/>
        <text x="13" y="17" text-anchor="middle" font-size="9" font-weight="700" fill="${color}">${label}</text>
      </svg></div>`,
    iconSize: [26, 36], iconAnchor: [13, 36], popupAnchor: [0, -34],
  });
}

const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t?.includes('dark')) return true;
  if (t === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

export default function SiteMap({ sites, onSiteClick }: { sites: TopoSite[]; onSiteClick?: (siteId: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const placed = sites.filter((s) => s.latitude != null && s.longitude != null);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: [0, 20], zoom: 2, scrollWheelZoom: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    map.current = m;
    // dark-mode tile treatment (OSM tiles are light) — soften + invert
    const applyTheme = () => { el.current?.classList.toggle('map-dark', isDark()); };
    applyTheme();
    const obs = new MutationObserver(applyTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { obs.disconnect(); m.remove(); map.current = null; };
  }, []);

  // (re)draw markers whenever the site set / statuses change
  useEffect(() => {
    const m = map.current; if (!m) return;
    m.eachLayer((layer) => { if (layer instanceof L.Marker) m.removeLayer(layer); });
    const pts: L.LatLngExpression[] = [];
    for (const s of placed) {
      const color = STATUS_COLOR[s.status] ?? STATUS_COLOR.pending;
      const marker = L.marker([s.latitude!, s.longitude!], { icon: pin(color, String(s.counts.total || '')) }).addTo(m);
      const c = s.counts;
      marker.bindPopup(
        `<div style="font:600 13px system-ui;margin-bottom:4px">${escapeHtml(s.name)}</div>` +
        `<div style="font:12px system-ui;color:#555">${c.total} device${c.total === 1 ? '' : 's'} · ` +
        `<span style="color:#22c55e">${c.up} up</span>` +
        (c.warning ? ` · <span style="color:#f59e0b">${c.warning} warn</span>` : '') +
        (c.down ? ` · <span style="color:#ef4444">${c.down} down</span>` : '') +
        (c.pending ? ` · ${c.pending} pending` : '') + '</div>' +
        `<a href="#" data-site="${s.id}" class="rubymik-site-link" style="font:600 12px system-ui;color:#2563eb;display:inline-block;margin-top:6px">Open site →</a>`,
      );
      pts.push([s.latitude!, s.longitude!]);
    }
    if (pts.length === 1) m.setView(pts[0], 12);
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts).pad(0.2));
  }, [placed.map((s) => `${s.id}:${s.status}:${s.latitude},${s.longitude}`).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  // delegate the popup "Open site" click (popup DOM is created lazily by Leaflet)
  useEffect(() => {
    const m = map.current; if (!m || !onSiteClick) return;
    const handler = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains('rubymik-site-link')) { e.preventDefault(); const id = Number(t.dataset.site); if (id) onSiteClick(id); }
    };
    el.current?.addEventListener('click', handler);
    return () => el.current?.removeEventListener('click', handler);
  }, [onSiteClick]);

  return (
    <div className="relative">
      <div ref={el} className="h-[600px] w-full rounded-2xl border border-border bg-app" />
      {placed.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto max-w-md rounded-xl border border-border bg-surface/95 px-5 py-4 text-center text-sm text-fg-dim shadow-lg">
            No site has coordinates yet. Open <span className="font-semibold text-fg-body">Sites</span>, edit a site, and set its location (search an address or enter latitude/longitude) — it will appear here.
          </div>
        </div>
      )}
      <style>{`
        .map-dark .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9); }
        .leaflet-container { background: transparent; font-family: inherit; }
        .leaflet-popup-content-wrapper, .leaflet-popup-tip { background: #fff; }
      `}</style>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}
