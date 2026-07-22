// RubyMIK device catalogue (P27) — a data-driven list of the current MikroTik line,
// used to (a) seed the Add-device (provision) port/interface picker and (b) classify
// a device into a category from its RouterOS-reported model.
//
// Ports are declared compactly (counts by type) and expanded to RouterOS-style
// interface names; port[0] is treated as the WAN candidate by the provision flow.

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

interface PortSpec { ether?: number; sfp?: number; sfpPlus?: number; qsfpPlus?: number; wifi?: number }

function expand(p: PortSpec): string[] {
  const out: string[] = [];
  for (let i = 1; i <= (p.ether ?? 0); i++) out.push(`ether${i}`);
  for (let i = 1; i <= (p.sfp ?? 0); i++) out.push(`sfp${i}`);
  for (let i = 1; i <= (p.sfpPlus ?? 0); i++) out.push(`sfp-sfpplus${i}`);
  for (let i = 1; i <= (p.qsfpPlus ?? 0); i++) out.push(`qsfpplus${i}`);
  for (let i = 1; i <= (p.wifi ?? 0); i++) out.push(`wlan${i}`);
  return out;
}

const m = (
  model: string, category: DeviceCategory, spec: PortSpec, bands?: CatalogModel['bands'],
): CatalogModel => ({ model, category, ports: expand(spec), wireless: !!bands?.length, bands });

// The catalogue. Not every RouterOS SKU — a representative sweep of the current line
// across all categories, plus an "Other / not listed" fallback handled in the UI.
export const CATALOG: CatalogModel[] = [
  // ---- Routers: hEX / RB / L009 ----
  m('hEX (RB750Gr3)', 'router', { ether: 5 }),
  m('hEX S (RB760iGS)', 'router', { ether: 5, sfp: 1 }),
  m('hEX PoE (RB960PGS)', 'router', { ether: 5, sfp: 1 }),
  m('hEX refresh (RB750Gr3)', 'router', { ether: 5 }),
  m('E60 / RB E60iUGS', 'router', { ether: 5 }),
  m('L009UiGS-RM', 'router', { ether: 8, sfp: 1 }),
  m('RB2011UiAS-RM', 'router', { ether: 10, sfp: 1 }),
  m('RB3011UiAS-RM', 'router', { ether: 10, sfp: 1 }),
  m('RB4011iGS+', 'router', { ether: 10, sfpPlus: 1 }),
  m('RB5009UG+S+IN', 'router', { ether: 7, sfpPlus: 1 }),
  m('RB5009UPr+S+IN (PoE)', 'router', { ether: 7, sfpPlus: 1 }),
  // ---- Routers: CCR ----
  m('CCR1009-7G-1C-1S+', 'router', { ether: 8, sfpPlus: 1 }),
  m('CCR1036-8G-2S+', 'router', { ether: 8, sfpPlus: 2 }),
  m('CCR1072-1G-8S+', 'router', { ether: 1, sfpPlus: 8 }),
  m('CCR2004-1G-12S+2XS', 'router', { ether: 1, sfpPlus: 12 }),
  m('CCR2004-16G-2S+', 'router', { ether: 16, sfpPlus: 2 }),
  m('CCR2116-12G-4S+', 'router', { ether: 13, sfpPlus: 4 }),
  m('CCR2216-1G-12XS-2XQ', 'router', { ether: 1, sfpPlus: 12, qsfpPlus: 2 }),
  // ---- Routers: hAP (wireless-capable) ----
  m('hAP lite (RB941)', 'router', { ether: 4, wifi: 1 }, ['2GHz']),
  m('hAP ac lite', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ac²', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ac³', 'router', { ether: 5, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ax lite', 'router', { ether: 4, wifi: 1 }, ['2GHz']),
  m('hAP ax²', 'router', { ether: 5, wifi: 2 }, ['2GHz', '5GHz']),
  m('hAP ax³', 'router', { ether: 4, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
  // ---- Routers: LTE / 5G ----
  m('Chateau LTE12', 'router', { ether: 4, wifi: 2 }, ['2GHz', '5GHz']),
  m('Chateau 5G', 'router', { ether: 4, wifi: 2 }, ['2GHz', '5GHz']),
  m('Chateau PRO ax', 'router', { ether: 4, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('LtAP LTE', 'router', { ether: 1, wifi: 1 }, ['2GHz']),
  m('LtAP mini LTE', 'router', { ether: 1, wifi: 1 }, ['2GHz']),
  // ---- Switches: CRS ----
  m('CRS309-1G-8S+', 'switch', { ether: 1, sfpPlus: 8 }),
  m('CRS310-8G+2S+', 'switch', { ether: 8, sfpPlus: 2 }),
  m('CRS312-4C+8XG', 'switch', { ether: 8, sfpPlus: 4 }),
  m('CRS317-1G-16S+', 'switch', { ether: 1, sfpPlus: 16 }),
  m('CRS326-24G-2S+', 'switch', { ether: 24, sfpPlus: 2 }),
  m('CRS328-24P-4S+ (PoE)', 'switch', { ether: 24, sfpPlus: 4 }),
  m('CRS354-48G-4S+2Q+', 'switch', { ether: 48, sfpPlus: 4, qsfpPlus: 2 }),
  m('CRS518-16XS-2XQ', 'switch', { sfpPlus: 16, qsfpPlus: 2 }),
  // ---- Switches: CSS / netPower ----
  m('CSS610-8G-2S+', 'switch', { ether: 8, sfpPlus: 2 }),
  m('CSS326-24G-2S+', 'switch', { ether: 24, sfpPlus: 2 }),
  m('netPower 16P (CRS318-16P-2S+)', 'switch', { ether: 16, sfpPlus: 2 }),
  m('netPower Lite 7R', 'switch', { ether: 5, sfp: 1 }),
  // ---- Access points / wireless CPE ----
  m('cAP ac', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('cAP ax', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('cAP XL ac', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('wAP ac', 'ap', { ether: 2, wifi: 2 }, ['2GHz', '5GHz']),
  m('wAP ax', 'ap', { ether: 1, wifi: 2 }, ['2GHz', '5GHz']),
  m('wAP LR8 / LR9', 'ap', { ether: 1, wifi: 1 }, ['2GHz']),
  m('wAP 60G', 'ap', { ether: 1, wifi: 1 }, ['60GHz']),
  m('mAP lite', 'ap', { ether: 1, wifi: 1 }, ['2GHz']),
  m('Audience', 'ap', { ether: 3, wifi: 3 }, ['2GHz', '5GHz']),
  m('SXT 5 ac', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('LHG 5 ac', 'ap', { ether: 1, wifi: 1 }, ['5GHz']),
  m('NetMetal ax', 'ap', { ether: 1, sfp: 1, wifi: 2 }, ['2GHz', '5GHz']),
];

export const MODEL_COUNT = CATALOG.length;

/** Ordered classifier rules over a RouterOS-reported model / board-name string.
 *  Real board strings are concatenated (e.g. "E60iUGS", "L009UiGS-2HaxD"), so the
 *  tokens match as prefixes (leading word-boundary, NO trailing boundary). */
const RULES: { re: RegExp; cat: DeviceCategory }[] = [
  { re: /\b(CRS|CSS|netPower)/i, cat: 'switch' },
  { re: /\b(cAP|wAP|SXT|LHG|LDF|mANTBox|NetMetal|BaseBox|QRT|DynaDish|nRAY|Cube|Audience|mAP)/i, cat: 'ap' },
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
