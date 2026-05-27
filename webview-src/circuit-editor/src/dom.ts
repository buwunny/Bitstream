// Centralised DOM lookups. All elements are guaranteed to exist because the
// host injects the script tag at the bottom of <body>; we still narrow types
// so callers don't have to cast.

function byId<T extends HTMLElement | SVGElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing DOM element #${id}`);
  return el as unknown as T;
}

export const svg = byId<SVGSVGElement>("canvas");
export const viewport = byId<SVGGElement>("viewport");
export const status = byId<HTMLElement>("status");
export const footer = byId<HTMLElement>("footer");
export const zoomLabel = byId<HTMLElement>("zoomLabel");
export const moduleNameInput = byId<HTMLInputElement>("moduleName");
export const moduleListEl = byId<HTMLElement>("moduleList");
export const btnRouting = byId<HTMLButtonElement>("btnRouting");
export const btnSnap = byId<HTMLButtonElement>("btnSnap");
export const colorPicker = byId<HTMLInputElement>("colorPicker");
export const btnClearColor = byId<HTMLButtonElement>("btnClearColor");

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}
