import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LngLat } from "@/mock/data";
import { usePlanner } from "@/shared/usePlanner";
import { BASES, type Base, CORE, type Limits, type Prefs, attr, diff, limitDef, solve, summary } from "./model";

export type DebugAttr = "surface" | "road" | "traffic" | "trail" | "cost";

/**
 * The plan's profile: a base plus this plan's tweaks, and the route the toy engine makes of it.
 * `?demo=1` starts with two added preferences, `?picker=1` with the picker open, `?compare=1`
 * with a second profile on the map.
 */
export function useTuner() {
  const p = usePlanner();
  const [params] = useSearchParams();
  const demo = params.get("demo") === "1";
  const [bases, setBases] = useState<Base[]>(BASES);
  const [baseId, setBaseId] = useState("gravel");
  const base = bases.find((b) => b.id === baseId) as Base;
  const [prefs, setPrefs] = useState<Prefs>(() => (demo ? { ...base.prefs, water: 60 } : { ...base.prefs }));
  const [limits, setLimits] = useState<Limits>(() => (demo ? { ...base.limits, maxGrade: 15 } : { ...base.limits }));
  const [compareId, setCompareId] = useState<string | null>(params.get("compare") === "1" ? "paved" : null);
  const [picker, setPicker] = useState(params.get("picker") === "1");
  const [fresh, setFresh] = useState<string | null>(null);
  const [tunes, setTunes] = useState(0);
  const [cursor, setCursor] = useState<LngLat | null>(null);
  const [dbg, setDbg] = useState<DebugAttr>("surface");
  const bump = () => setTunes((n) => n + 1);

  const setBase = useCallback(
    (id: string) => {
      const b = bases.find((x) => x.id === id);
      if (!b) return;
      setBaseId(id);
      setPrefs({ ...b.prefs });
      setLimits({ ...b.limits });
      setCompareId((c) => (c === id ? null : c));
    },
    [bases],
  );
  const setPref = useCallback((id: string, v: number) => {
    setPrefs((x) => (x[id] === v ? x : { ...x, [id]: v }));
    bump();
  }, []);
  const addPref = useCallback((id: string) => {
    setPrefs((x) => (id in x ? x : { ...x, [id]: attr(id).start }));
    setFresh(id);
    setPicker(false);
    bump();
  }, []);
  const removePref = useCallback((id: string) => {
    if (CORE.includes(id)) return;
    setPrefs((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== id)));
    bump();
  }, []);
  const setLimit = useCallback((id: string, v: number | true | null) => {
    setLimits((x) => (v === null ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== id)) : { ...x, [id]: v }));
    bump();
  }, []);
  const addLimit = useCallback((id: string) => {
    setLimits((x) => ({ ...x, [id]: limitDef(id).param?.start ?? true }));
    setFresh(id);
    setPicker(false);
    bump();
  }, []);
  const reset = useCallback(() => setBase(baseId), [setBase, baseId]);
  const savePreset = useCallback(
    (name: string) => {
      const id = `own-${bases.length}`;
      setBases((bs) => [...bs, { id, name, blurb: `Made from ${base.name}`, prefs: { ...prefs }, limits: { ...limits }, own: true }]);
      setBaseId(id);
    },
    [bases.length, base.name, prefs, limits],
  );

  const route = useMemo(() => solve(prefs, limits), [prefs, limits]);
  const baseRoute = useMemo(() => solve(base.prefs, base.limits), [base]);
  const compare = bases.find((b) => b.id === compareId) ?? null;
  const compareRoute = useMemo(() => (compare ? solve(compare.prefs, compare.limits) : null), [compare]);
  const changes = useMemo(() => diff(base, prefs, limits), [base, prefs, limits]);
  /** Rows on screen: the core ones first, then whatever the base or the user added. */
  const prefIds = useMemo(() => [...CORE, ...Object.keys(prefs).filter((k) => !CORE.includes(k))], [prefs]);
  /** Limits on screen: the active ones, plus base limits that were switched off (so the change stays visible). */
  const limitIds = useMemo(() => [...new Set([...Object.keys(base.limits), ...Object.keys(limits)])], [base, limits]);

  return {
    ...p, bases, base, setBase, prefs, limits, setPref, addPref, removePref, setLimit, addLimit, reset, savePreset,
    route, baseRoute, compare, compareRoute, setCompare: setCompareId, changes, prefIds, limitIds,
    summary: summary(base, changes), moved: route.id !== baseRoute.id,
    picker, setPicker, fresh, cursor, setCursor, dbg, setDbg,
    rerouteMs: 18 + ((tunes * 7) % 23),
  };
}
export type Tuner = ReturnType<typeof useTuner>;
