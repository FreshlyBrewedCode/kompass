import { Link } from "react-router-dom";
import { Mark } from "@/shared/viz";

const DIRECTIONS = [
  { l: "a", name: "Field sheet", model: "Bottom sheet · sliders", text: "A printed topo sheet with a card you pull up over it. Route, profile and layers are three tabs of one sheet; on desktop route sits left and the profile right." },
  { l: "b", name: "Mixer", model: "Fixed split · faders · timeline", text: "An instrument panel. The profile is a mixing desk with two decks to A/B routes; the route is a timeline with one lane per attribute." },
  { l: "c", name: "Sentence", model: "Full map · floating cards · words", text: "The map is the app. The profile is a sentence you can read and nudge, comparisons come back as a trade-off, and the agent bar edits the same sentence." },
  { l: "d", name: "Rose", model: "Tab bar · candidates · compass rose", text: "Compare first: every profile is a candidate route on the map and you pick a line. A profile is a shape on a compass rose, two profiles are two shapes." },
];
const STATES = [["Planning", "view=plan"], ["Profile & compare", "view=profile"], ["Attribute map", "view=layers&layer=debug"], ["Explored map", "view=layers&layer=explored"]];

const ROUND2 = [
  { l: "c1", name: "Sheet", model: "Bottom sheet · full list · search-first picker", text: "One sheet with three detents carries route, profile and map views. While you hold a slider the sheet clears away and leaves only that row, with the base profile's route as a ghost on the map." },
  { l: "c2", name: "Strip", model: "Chip strip · one slider at a time · chip picker", text: "The map keeps the screen. Every active preference is a chip above the agent bar; tap one and a single slider opens. What the tweaks did shows as numbers next to the totals." },
  { l: "c3", name: "Bench", model: "Fixed split · dense rows · category grid", text: "Nothing floats: map on top, the timeline as the seam, every slider on one line below. What the tweaks did comes back as a sentence." },
];
const STATES2 = [["Planning", "view=plan"], ["Profile, two added", "view=profile&demo=1"], ["Picker", "view=profile&demo=1&picker=1"], ["Compare", "view=profile&compare=1"], ["Attribute map", "view=layers&layer=debug"], ["Explored map", "view=layers&layer=explored"]];

const FINAL = [["Planning", "demo=0"], ["Chip slider", "demo=1&chip=water"], ["Whole profile", "demo=1&sheet=profile"], ["Picker", "demo=1&picker=1"], ["Route details", "demo=1&sheet=route"], ["Compare", "compare=1"], ["Attribute layer", "sheet=layers&layer=debug"], ["Explored", "layer=explored"], ["Empty", "state=empty"], ["Downloading", "state=download"], ["Engine busy", "state=busy"], ["No route", "state=error"]];

export function Index() {
  return (
    <div className="min-h-full bg-neutral-50 px-5 py-10 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2.5"><Mark size={28} accent="#e4572e" /><h1 className="text-2xl font-semibold tracking-tight">Kompass planner · design rounds</h1></div>
        <p className="mt-2 max-w-xl text-sm text-neutral-500">Four directions for the responsive planner. Mock data, real stack. Each one works at phone and desktop width; resize the window or open it on the phone. Add <code>&amp;theme=dark</code> or <code>&amp;theme=light</code> to force a theme.</p>
        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-neutral-500">Round 3 · the consolidated design</h2>
        <div className="mt-3 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
          <Link to="/final" className="flex items-baseline gap-3"><span className="text-3xl font-semibold uppercase">Final</span><span className="text-lg font-semibold">Strip on the phone, cards on desktop</span></Link>
          <div className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">One set of parts · one state model · monotone chrome</div>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">The reference the planner shell is built from: docs/design/planner.md. Resize the window to walk through phone, tablet and desktop.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FINAL.map(([label, q]) => <a key={q} href={`/final?${q}`} className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">{label}</a>)}
          </div>
        </div>
        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-neutral-500">Round 2 · three takes on C “Sentence”, now with sliders</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {ROUND2.map((d) => (
            <div key={d.l} className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
              <Link to={`/${d.l}`} className="flex items-baseline gap-3"><span className="text-3xl font-semibold uppercase">{d.l}</span><span className="text-lg font-semibold">{d.name}</span></Link>
              <div className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">{d.model}</div>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{d.text}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {STATES2.map(([label, q]) => <a key={q} href={`/${d.l}?${q}`} className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">{label}</a>)}
              </div>
            </div>
          ))}
        </div>
        <h2 className="mt-10 text-sm font-semibold uppercase tracking-wider text-neutral-500">Round 1 · four directions</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {DIRECTIONS.map((d) => (
            <div key={d.l} className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
              <Link to={`/${d.l}`} className="flex items-baseline gap-3">
                <span className="text-3xl font-semibold uppercase">{d.l}</span>
                <span className="text-lg font-semibold">{d.name}</span>
              </Link>
              <div className="mt-1 text-xs font-medium uppercase tracking-wider text-neutral-500">{d.model}</div>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{d.text}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {STATES.map(([label, q]) => <a key={q} href={`/${d.l}?${q}`} className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">{label}</a>)}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-8 text-xs text-neutral-500">Map: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors. Route geometry from BRouter. The “ridden” tracks are routed, not recorded.</p>
      </div>
    </div>
  );
}
