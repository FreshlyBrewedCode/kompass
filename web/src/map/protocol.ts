import { addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";

let registered = false;

/** Lets MapLibre read `pmtiles://<url>` sources with HTTP range requests (once per page). */
export function registerPmtiles() {
  if (registered) return;
  registered = true;
  // metadata: the TileJSON (attribution, bounds) comes from the archive
  const protocol = new Protocol({ metadata: true });
  addProtocol("pmtiles", protocol.tile);
}
