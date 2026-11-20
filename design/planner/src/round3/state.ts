import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTuner } from "@/round2/useTuner";

/**
 * Round 3: ONE state model for every breakpoint. The profile, the route and the map views come from
 * round 2's `useTuner` (unchanged: a base plus this plan's tweaks, the toy engine); this adds what
 * the shell needs on top: which surface is open, which chip is being tuned, and the app's status.
 *
 * URL switches (for screenshots and review): `?state=empty|download|busy|error`,
 * `?sheet=route|profile|layers`, `?chip=<preference id>`, `?hold=<preference id>` (the profile sheet
 * as it looks while that slider is held), `?line=surface`, and round 2's `?demo=1`, `?picker=1`,
 * `?compare=1`, `?layer=debug|explored`, `?theme=light|dark`.
 */
export type Status = "ready" | "empty" | "download" | "busy" | "error";
/** The one large surface that can be open. On the phone it is a bottom sheet; on desktop only `layers` is a popover, the rest is always on screen. */
export type SheetId = "route" | "profile" | "layers" | null;
/** How the route line is drawn on the plain map. */
export type LineBy = "plain" | "surface";

/** The hard limit the error state blames. */
export const ERROR_LIMIT = "pavedOnly";

export function usePlan() {
  const t = useTuner();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<Status>(() => (params.get("state") as Status) || "ready");
  const [sheet, setSheet] = useState<SheetId>(() => (params.get("sheet") as SheetId) || (params.get("hold") ? "profile" : null));
  const [chip, setChip] = useState<string | null>(() => params.get("chip"));
  const [lineBy, setLineBy] = useState<LineBy>(() => (params.get("line") === "surface" ? "surface" : "plain"));
  const [progress, setProgress] = useState(0.46);

  // the error state: a limit that leaves no way through
  const { setLimit, fresh, prefs, limitIds } = t;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, from the URL
  useEffect(() => {
    if (status === "error") setLimit(ERROR_LIMIT, true);
  }, []);
  // the mock download creeps forward and ends in the empty state
  useEffect(() => {
    if (status !== "download" || params.get("still") === "1") return;
    const id = window.setInterval(() => setProgress((x) => Math.min(1, x + 0.004)), 120);
    return () => window.clearInterval(id);
  }, [status, params]);
  useEffect(() => {
    if (status === "download" && progress >= 1) setStatus("empty");
  }, [status, progress]);

  // a preference that was just added opens as a chip, ready to tune
  const seen = useRef<string | null>(null);
  const sheetNow = useRef(sheet);
  sheetNow.current = sheet;
  useEffect(() => {
    if (!fresh || fresh === seen.current) return;
    seen.current = fresh;
    if (fresh in prefs && sheetNow.current === null) setChip(fresh);
  }, [fresh, prefs]);
  // a chip whose preference was removed closes
  const gone = chip !== null && !(chip in prefs) && !limitIds.includes(chip);
  useEffect(() => {
    if (gone) setChip(null);
  }, [gone]);

  const open = useCallback((s: SheetId) => {
    setSheet(s);
    setChip(null);
  }, []);
  const liftLimit = useCallback(() => {
    setLimit(ERROR_LIMIT, null);
    setStatus("ready");
  }, [setLimit]);

  return { ...t, status, setStatus, sheet, open, chip, setChip, lineBy, setLineBy, progress, liftLimit, hold: params.get("hold") };
}
export type Plan = ReturnType<typeof usePlan>;

export type Mode = "phone" | "tablet" | "desk";
/**
 * The breakpoints. They switch the arrangement, not the parts:
 * - phone (< 720 px wide, or less than 560 px high: a phone in landscape): map, summary card, chip strip, agent bar; sheets.
 * - tablet (720 … 1099 px): the route card on the left as on desktop; the profile stays a strip with a side panel.
 * - desk (≥ 1100 px): route card left, profile card right.
 */
export function useMode(): { mode: Mode; w: number; h: number } {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [s, setS] = useState(read);
  useEffect(() => {
    const on = () => setS(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const mode: Mode = s.w < 720 || s.h < 560 ? "phone" : s.w < 1100 ? "tablet" : "desk";
  return { mode, ...s };
}
