// Region data is loaded at run time from a data URL; nothing about a region is compiled into the app.
import { type Manifest, ManifestError, parseManifest } from "./manifest";

/** Where the region data lives unless told otherwise: `data/` next to the app (works from any sub-path). */
export const DEFAULT_DATA_URL = "./data/";

/**
 * The data URL as an absolute URL ending in a slash. Order: the `?data=` query parameter, the
 * `VITE_KOMPASS_DATA_URL` build variable, then the default; relative values resolve against `base`.
 */
export function resolveDataUrl(
  search: string,
  base: string,
  env: string | undefined = import.meta.env?.VITE_KOMPASS_DATA_URL,
): string {
  const fromQuery = new URLSearchParams(search).get("data");
  const raw = fromQuery || env || DEFAULT_DATA_URL;
  const url = new URL(raw, base).href;
  return url.endsWith("/") ? url : `${url}/`;
}

/** A file next to the manifest, as an absolute URL. */
export function dataFileUrl(dataUrl: string, file: string): string {
  return new URL(file, dataUrl).href;
}

export type RegionState =
  | { status: "loading" }
  /** no data there: the app shows the empty state */
  | { status: "empty"; dataUrl: string }
  | { status: "error"; dataUrl: string; message: string }
  | { status: "ready"; dataUrl: string; manifest: Manifest };

/** Fetches and checks `<dataUrl>manifest.json`. Never throws: every failure is a state. */
export async function loadRegion(dataUrl: string, fetchFn: typeof fetch = fetch): Promise<RegionState> {
  let response: Response;
  try {
    response = await fetchFn(dataFileUrl(dataUrl, "manifest.json"), { cache: "no-cache" });
  } catch (error) {
    return { status: "error", dataUrl, message: `Could not reach the region data (${String(error)})` };
  }
  // a missing file, or a host that answers every unknown path with its index page: no data there
  if (
    response.status === 404 ||
    (response.ok && response.headers.get("content-type")?.includes("text/html"))
  ) {
    return { status: "empty", dataUrl };
  }
  if (!response.ok) {
    return { status: "error", dataUrl, message: `The region manifest answered ${response.status}` };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: "error", dataUrl, message: "The region manifest is not valid JSON" };
  }
  try {
    return { status: "ready", dataUrl, manifest: parseManifest(json) };
  } catch (error) {
    if (error instanceof ManifestError) return { status: "error", dataUrl, message: error.message };
    throw error;
  }
}
