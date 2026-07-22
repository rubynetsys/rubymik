// RubyMIK device catalogue (P27; rebuilt v1.0.1) — a data-driven list of the MikroTik
// line, used to (a) seed the Add-device (provision) port/interface picker and (b) classify
// a device into a category from its RouterOS-reported model. Source of truth for ports is
// mikrotik.com product specs; a spot-check sample is verified there each rebuild.
//
// Ports are declared compactly (counts by type) and expanded to RouterOS-style interface
// names; port[0] is treated as the WAN candidate by the provision flow. Wireless interface
// names are given as `wlanN` — the legacy naming; devices on the newer `wifiwave2` driver
// (most ax models on RouterOS 7.13+) present the same radios as `wifiN`.

export type DeviceCategory = 'router' | 'switch' | 'ap' | 'other';

export const CATEGORY_META: { id: DeviceCategory; label: string; plural: string }[] = [
  { id: 'router', label: 'Router', plural: 'Routers' },
  { id: 'switch', label: 'Switch', plural: 'Switches' },
  { id: 'ap', label: 'Access Point', plural: 'Access Points' },
  { id: 'other', label: 'Other', plural: 'Other' },
];

export interface CatalogModel {
  model: string;                 // display name
  category: DeviceCategory;
  ports: string[];               // expanded interface names (port[0] = WAN candidate)
  wireless: boolean;
  bands?: ('2GHz' | '5GHz' | '60GHz')[];
}

interface PortSpec {
  ether?: number;    // etherN            — RJ45 (10/100/1000 or 2.5G)
  sfp?: number;      // sfpN              — 1G / 2.5G SFP
  sfpPlus?: number;  // sfp-sfpplusN      — 10G SFP+
  sfp28?: number;    // sfp28-N           — 25G SFP28
  qsfpPlus?: number; // qsfpplusN         — 40G QSFP+
  qsfp28?: number;   // qsfp28-N          — 100G QSFP28
  wifi?: number;     // wlanN (or wifiN on wifiwave2)
}

function expand(p: PortSpec): string[] {
  const out: string[] = [];
  for (let i = 1; i <= (p.ether ?? 0); i++) out.push(`ether${i}`);
  for (let i = 1; i <= (p.sfp ?? 0); i++) out.push(`sfp${i}`);
  for (let i = 1; i <= (p.sfpPlus ?? 0); i++) out.push(`sfp-sfpplus${i}`);
  for (let i = 1; i <= (p.sfp28 ?? 0); i++) out.push(`sfp28-${i}`);
  for (let i = 1; i <= (p.qsfpPlus ?? 0); i++) out.push(`qsfpplus${i}`);
  for (let i = 1; i <= (p.qsfp28 ?? 0); i++) out.push(`qsfp28-${i}`);
  for (let i = 1; i <= (p.wifi ?? 0); i++) out.push(`wlan${i}`);
  return out;
}

const m = (
  model: string, category: DeviceCategory, spec: PortSpec, bands?: CatalogModel['bands'],
): CatalogModel => ({ model, category, ports: expand(spec), wireless: !!bands?.length, bands });

// The catalogue — a broad sweep of the current MikroTik line across every category, plus
// common discontinued units (RB951, RB2011, hAP lite). "Other / not listed" is the UI
// fallback (not an entry here). Port counts follow mikrotik.com; SFP+ = 10G, SFP28 = 25G,
// QSFP+ = 40G, QSFP28 = 100G.
export const CATALOG: CatalogModel[] = [
  // ─── Routers · hEX / RB / L009 (ethernet) ──────────────────────────────────
  m('hEX lite (RB750r2)', 'router', { ether: 5 }),
  m('hEX PoE lite (RB750UPr2)', 'router', { ether: 5 }),
  m('hEX (RB750Gr3)', 'router', { ether: 5 }),
  m('hEX S (RB760iGS)', 'router', { ether: 5, sfp: 1 }),
  m('hEX PoE (RB960PGS)', 'router', { ether: 5, sfp: 1 }),
  m('L009UiGS-RM', 'router', { ether: 8, sfp: 1 }),
  m('RB1100AHx4', 'router', { ether: 13 }),
  m('RB2011UiAS-RM', 'router', { ether: 10, sfp: 1 }),
  m('RB3011UiAS-RM', 'router', { ether: 10, sfp: 1 }),
  m('RB4011iGS+', 'router', { ether: 10, sfpPlus: 1 }),
  m('RB5009UG+S+IN', 'router', { ether: 8, sfpPlus: 1 }),        // ether1 = 2.5G, ether2-8 = 1G, + SFP+
  m('RB5009UPr+S+IN (PoE)', 'router', { ether: 8, sfpPlus: 1 }),
  // ─── Routers · CCR (Cloud Core) ────────────────────────────────────────────
  m('CCR1009-7G-1C-1S+', 'router', { ether: 8, sfpPlus: 1 }),
  m('CCR1016-12G', 'router', { ether: 12 }),
  m('CCR1016-12S-1S+', 'router', { sfp: 12, sfpPlus: 1 }),
  m('CCR1036-8G-2S+', 'router', { ether: 8, sfpPlus: 2 }),
  m('CCR1036-12G-4S', 'router', { ether: 12, sfp: 4 }),
  m('CCR1072-1G-8S+', 'router', { ether: 1, sfpPlus: 8 }),
  m('CCR2004-1G-12S+2XS', 'router', { ether: 1, sfpPlus: 12, sfp28: 2 }),
  m('CCR2004-16G-2S+', 'router', { ether: 16, sfpPlus: 2 }),
  m('CCR2116-12G-4S+', 'router', { ether: 13, sfpPlus: 4 }),
  m('CCR2216-1G-12XS-2XQ', 'router', { ether: 1, sfp28: 12, qsfp28: 2 }),
  // ─── Routers · hAP (wireless) ──────────────────────────────────────────────
  m('hAP mini (RB931-2nD)', 'router', { ether: 3, wifi: 1 }, ['2GHz']),
  m('hAP lite (RB941-2nD)', 'router', { ether: 4, wifi: 1 }, ['2GHz']),
  m('hAP (RB951Ui-2nD)', 'router', { ether: 5, wifi: 1 }, ['2GHz']),
  m('hAP ac lite (RB952Ui-5ac2nD)', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ac (RB962UiGS-5HacT2HnD)', 'router', { ether: 5, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ac²', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ac³', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ax lite (L41G-2axD)', 'router', { ether: 4, wifi: 1 }, ['2GHz']),
  m('hAP ax²', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ax³', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),   // 1×2.5G + 4×1G, no SFP
  // ─── Routers · RB9xx wireless (common discontinued) ────────────────────────
  m('RB951Ui-2HnD', 'router', { ether: 5, wifi: 1 }, ['2GHz']),
  m('RB951G-2HnD', 'router', { ether: 5, wifi: 1 }, ['2GHz']),
  // ─── Routers · LTE / 5G ────────────────────────────────────────────────────
  m('Chateau LTE12', 'router', { ether: 4, wifi: 2 }, ['2GHz', '5GHz']),
  m('Chateau 5G', 'router', { ether: 4, wifi: 2 }, ['2GHz', '5GHz']),
  m('Chateau PRO ax', 'router', { ether: 4, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('LtAP LTE6 kit', 'router', { ether: 1, wifi: 1 }, ['2GHz']),
  m('LtAP mini LTE kit', 'router', { ether: 1, wifi: 1 }, ['2GHz']),
  // ─── Switches · CRS ────────────────────────────────────────────────────────
  m('CRS305-1G-4S+', 'switch', { ether: 1, sfpPlus: 4 }),
  m('CRS309-1G-8S+', 'switch', { ether: 1, sfpPlus: 8 }),
  m('CRS310-8G+2S+', 'switch', { ether: 8, sfpPlus: 2 }),
  m('CRS310-1G-5S-4S+', 'switch', { ether: 1, sfp: 5, sfpPlus: 4 }),
  m('CRS312-4C+8XG', 'switch', { ether: 8, sfpPlus: 4 }),
  m('CRS317-1G-16S+', 'switch', { ether: 1, sfpPlus: 16 }),
  m('CRS326-24G-2S+', 'switch', { ether: 24, sfpPlus: 2 }),
  m('CRS326-24S+2Q+', 'switch', { sfpPlus: 24, qsfpPlus: 2 }),
  m('CRS328-24P-4S+ (PoE)', 'switch', { ether: 24, sfpPlus: 4 }),
  m('CRS354-48G-4S+2Q+', 'switch', { ether: 48, sfpPlus: 4, qsfpPlus: 2 }),
  m('CRS504-4XQ', 'switch', { ether: 1, qsfp28: 4 }),
  m('CRS510-8XS-2XQ', 'switch', { ether: 1, sfp28: 8, qsfp28: 2 }),
  m('CRS518-16XS-2XQ', 'switch', { ether: 1, sfp28: 16, qsfp28: 2 }),
  m('CRS112-8G-4S', 'switch', { ether: 8, sfp: 4 }),
  m('CRS125-24G-1S', 'switch', { ether: 24, sfp: 1 }),
  m('CRS109-8G-1S-2HnD', 'switch', { ether: 8, sfp: 1, wifi: 1 }, ['2GHz']),
  // ─── Switches · CSS / netPower ─────────────────────────────────────────────
  m('CSS610-8G-2S+', 'switch', { ether: 8, sfpPlus: 2 }),
  m('CSS610-8P-2S+ (PoE)', 'switch', { ether: 8, sfpPlus: 2 }),
  m('CSS318-16G-2S+', 'switch', { ether: 16, sfpPlus: 2 }),
  m('CSS326-24G-2S+', 'switch', { ether: 24, sfpPlus: 2 }),
  m('netPower 16P (CRS318-16P-2S+)', 'switch', { ether: 16, sfpPlus: 2 }),
  m('netPower Lite 7R (CSS610-1Gi-7R-2S+)', 'switch', { ether: 8, sfpPlus: 2 }),
  // ─── Access points / wireless CPE ──────────────────────────────────────────
  m('cAP ac', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('cAP ax', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('cAP XL ac', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('cAP XL ax', 'ap', { ether: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('wAP ac', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('wAP ax', 'ap', { ether: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('wAP LR8 kit', 'ap', { ether: 1, wifi: 1 }, ['2GHz']),
  m('wAP 60G', 'ap', { ether: 1, wifi: 1 }, ['60GHz']),
  m('mAP lite (RBmAPL-2nD)', 'ap', { ether: 1, wifi: 1 }, ['2GHz']),
  m('mAP (RBmAP2nD)', 'ap', { ether: 2, wifi: 1 }, ['2GHz']),
  m('Audience', 'ap', { ether: 3, wifi: 3 }, ['2GHz', '5GHz']),
  m('OmniTIK 5 PoE ac', 'ap', { ether: 5, wifi: 1 }, ['5GHz']),
  m('SXTsq 5 ac', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('LHG 5 ac', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('LHG XL 52 ac', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('LDF 5 ac', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('mANTBox 52 15s', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('BaseBox 5', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('NetMetal ax', 'ap', { ether: 1, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('Cube 60G ac', 'ap', { ether: 1, wifi: 1 }, ['60GHz']),
];

export const MODEL_COUNT = CATALOG.length;

/** Ordered classifier rules over a RouterOS-reported model / board-name string.
 *  Real board strings are concatenated (e.g. "E60iUGS", "L009UiGS-2HaxD"), so the
 *  tokens match as prefixes (leading word-boundary, NO trailing boundary). */
const RULES: { re: RegExp; cat: DeviceCategory }[] = [
  { re: /\b(CRS|CSS|netPower)/i, cat: 'switch' },
  { re: /\b(cAP|wAP|SXT|LHG|LDF|mANTBox|NetMetal|BaseBox|QRT|DynaDish|nRAY|Cube|Audience|mAP|OmniTIK)/i, cat: 'ap' },
  { re: /\b(CCR|RB|hEX|hAP|Chateau|LtAP|L0\d\d|E\d\d)/i, cat: 'router' },
];

/** Best-effort category for a device from its polled model string. Falls back to
 *  'other' when nothing matches (the user can override the stored category). */
export function categoryForModel(model: string | null | undefined): DeviceCategory {
  if (!model) return 'other';
  for (const { re, cat } of RULES) if (re.test(model)) return cat;
  return 'other';
}

/** Effective category for a device: an explicit stored override wins, else derive
 *  from the polled model, else 'other'. */
export function effectiveCategory(
  storedCategory: DeviceCategory | null | undefined,
  polledModel: string | null | undefined,
): DeviceCategory {
  if (storedCategory) return storedCategory;
  return categoryForModel(polledModel);
}
