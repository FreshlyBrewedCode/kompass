// One entry for "a file's bytes become a raw track": FIT is recognised by its signature, GPX by text.
import { isFit, parseFit } from "./fit";
import { parseGpx } from "./gpx";
import type { RawTrack } from "./types";

export function parseTrackFile(name: string, bytes: Uint8Array): RawTrack {
  if (isFit(bytes)) return parseFit(bytes);
  if (/\.fit$/i.test(name)) throw new Error("not a valid FIT file");
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!/<gpx[\s>]/i.test(text) && !/<trkpt[\s>]/i.test(text)) {
    throw new Error("not a GPX or FIT file");
  }
  return parseGpx(text);
}
