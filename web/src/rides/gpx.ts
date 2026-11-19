// A small GPX reader for tracks: every <trkpt lat lon> with its <ele> and <time>, across all
// <trk>/<trkseg>. A scanner over the text, no DOM (DOMParser does not exist in workers) and no
// dependency: GPX written by Komoot, Garmin, Strava and the like is regular enough, and the scan
// tolerates what is not (namespaces on child tags, comments, CDATA names, missing elevations,
// self-closing points). Waypoints and routes are not rides and are ignored.
import type { RawTrack } from "./types";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeText(raw: string): string {
  const text = raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      return ENTITIES[body.toLowerCase()] ?? whole;
    })
    .trim();
}

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** ISO 8601 date-time → ms since the epoch (no zone = UTC, as GPX says); `NaN` if it is not one. */
export function parseIsoTime(text: string): number {
  const m = ISO.exec(text.trim());
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  if (frac) ms += Math.round(Number(`0.${frac}`) * 1000);
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0);
    ms -= sign * offset * 60_000;
  }
  return ms;
}

function attribute(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? Number((m[1] ?? m[2]) as string) : Number.NaN;
}

/** The text of the first `<tag>…</tag>` (a namespace prefix allowed) inside `body`, or null. */
function childText(body: string, tag: string): string | null {
  const open = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>`, "i").exec(body);
  if (!open) return null;
  const from = open.index + open[0].length;
  const close = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`, "i").exec(body.slice(from));
  return close ? body.slice(from, from + close.index) : null;
}

/** Parses GPX text into a raw track. Throws a readable error if there is no track. */
export function parseGpx(source: string): RawTrack {
  const text = source.includes("<!--") ? source.replace(/<!--[\s\S]*?-->/g, "") : source;
  const track: RawTrack = { lat: [], lon: [], time: [], ele: [], name: null, sport: null };
  // the track's own name and type sit before its first segment
  const firstTrk = text.search(/<trk[\s>]/);
  if (firstTrk >= 0) {
    const firstPoint = text.indexOf("<trkpt", firstTrk);
    const head = text.slice(firstTrk, firstPoint >= 0 ? firstPoint : undefined);
    const name = childText(head, "name");
    const type = childText(head, "type");
    track.name = name ? decodeText(name) || null : null;
    track.sport = type ? decodeText(type) || null : null;
  }

  let pos = 0;
  for (;;) {
    const start = text.indexOf("<trkpt", pos);
    if (start < 0) break;
    const tagEnd = text.indexOf(">", start);
    if (tagEnd < 0) break;
    const attrs = text.slice(start + 6, tagEnd);
    let body = "";
    pos = tagEnd + 1;
    if (!attrs.endsWith("/")) {
      const close = text.indexOf("</trkpt", pos);
      if (close < 0) break;
      body = text.slice(pos, close);
      pos = close + 7;
    }
    const lat = attribute(attrs, "lat");
    const lon = attribute(attrs, "lon");
    if (Number.isNaN(lat) && Number.isNaN(lon)) continue;
    const ele = childText(body, "ele");
    const time = childText(body, "time");
    track.lat.push(lat);
    track.lon.push(lon);
    track.ele.push(ele === null ? Number.NaN : Number(ele.trim()));
    track.time.push(time === null ? Number.NaN : parseIsoTime(decodeText(time)));
  }
  if (track.lat.length === 0) throw new Error("no track points found (is this a GPX track?)");
  return track;
}
