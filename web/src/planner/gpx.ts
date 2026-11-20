// GPX export of the planned route: one `<trk>` with elevations (what bike computers and Komoot
// import), and the waypoints as `<wpt>`. No timestamps: it is a plan, not a ride.
import type { RouteResult } from "@/engine/generated/types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The route as GPX 1.1 text. `points`: the waypoints as named on screen. */
export function routeToGpx(
  result: RouteResult,
  name: string,
  points: readonly { lon: number; lat: number; name: string }[] = [],
): string {
  const g = result.geometry;
  const coords = g?.coordinates ?? [];
  const ele = g?.elevation_m;
  const trkpts = coords.map(([lon, lat], i) => {
    const e = ele?.[i];
    const inner = e === undefined ? "" : `<ele>${e.toFixed(1)}</ele>`;
    return `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${inner}</trkpt>`;
  });
  const wpts = points.map(
    (p) => `<wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><name>${esc(p.name)}</name></wpt>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Kompass" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${esc(name)}</name></metadata>`,
    ...wpts,
    `<trk><name>${esc(name)}</name><type>cycling</type><trkseg>`,
    ...trkpts,
    "</trkseg></trk>",
    "</gpx>",
    "",
  ].join("\n");
}

export function gpxFilename(now: Date = new Date()): string {
  return `kompass-route-${now.toISOString().slice(0, 10)}.gpx`;
}

/**
 * Hands the GPX to the user. On a touch device with the share sheet (iOS Safari, also standalone),
 * the share sheet: "Save to Files" or straight into the bike computer's app. Elsewhere a download.
 */
export async function exportGpx(
  text: string,
  filename: string,
): Promise<"shared" | "downloaded" | "cancelled"> {
  const blob = new Blob([text], { type: "application/gpx+xml" });
  const file =
    typeof File === "undefined" ? null : new File([blob], filename, { type: "application/gpx+xml" });
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  if (file && coarse && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if ((error as Error).name === "AbortError") return "cancelled";
      // fall through to the download
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}
