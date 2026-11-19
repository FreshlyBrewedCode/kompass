import { describe, expect, test } from "bun:test";
import { ExploredStore } from "../src/history/explored-store";
import { APPLY_CHUNK, ExploredLayer } from "../src/map/explored-layer";
import { distanceToLine, distanceToSegment } from "../src/map/inspect";
import { loadRegion, resolveDataUrl } from "../src/map/region";

class FakeMap {
  state = new Map<number, Record<string, unknown>>();
  removedAll = 0;
  setFeatureState(target: { id?: string | number }, state: Record<string, unknown>) {
    this.state.set(target.id as number, state);
  }
  removeFeatureState(target: { id?: string | number }) {
    if (target.id === undefined) {
      this.removedAll++;
      this.state.clear();
    } else this.state.delete(target.id as number);
  }
}
const setup = () => {
  const map = new FakeMap();
  const store = new ExploredStore();
  const layer = new ExploredLayer(map as never, store, "edges");
  return { map, store, layer };
};

describe("ExploredStore", () => {
  test("setRidden takes ids or a map with info, replaces, and notifies", () => {
    const store = new ExploredStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.setRidden([3, 5, 5]);
    expect([...store.edges.keys()]).toEqual([3, 5]);
    expect(store.edges.get(3)).toEqual({ count: 1, lastRidden: 0 });
    store.setRidden(new Map([[7, { count: 4, lastRidden: 99 }]]));
    expect([...store.edges.keys()]).toEqual([7]);
    expect(store.size).toBe(1);
    store.clear();
    store.clear(); // already empty: no extra notification
    expect(calls).toBe(3);
    expect(store.version).toBe(3);
    off();
    store.setRidden([1]);
    expect(calls).toBe(3);
  });
});

describe("ExploredLayer", () => {
  test("mirrors the store into feature state: adds, removes, clears", async () => {
    const { map, store, layer } = setup();
    await layer.reapply();
    store.setRidden(
      new Map([
        [1, { count: 2, lastRidden: 0 }],
        [2, { count: 1, lastRidden: 0 }],
      ]),
    );
    await layer.sync();
    expect(map.state.get(1)).toEqual({ ridden: true, count: 2 });
    store.setRidden([2, 3]);
    await layer.sync();
    expect([...map.state.keys()].sort()).toEqual([2, 3]);
    store.clear();
    await layer.sync();
    expect(map.state.size).toBe(0);
    expect(map.removedAll).toBe(1);
  });

  test("applies nothing while suspended; reapply puts everything back (a new style drops the state)", async () => {
    const { map, store, layer } = setup();
    await layer.reapply();
    store.setRidden([1, 2]);
    await layer.sync();
    layer.suspend();
    map.state.clear(); // the old style went away
    store.setRidden([1, 2, 3]);
    await layer.sync();
    expect(map.state.size).toBe(0);
    await layer.reapply();
    expect([...map.state.keys()].sort()).toEqual([1, 2, 3]);
  });

  test("a big set is applied in chunks, yielding between them, and reports", async () => {
    const { map, store, layer } = setup();
    await layer.reapply();
    let report: { edges: number } | undefined;
    layer.onApplied = (r) => {
      report = r;
    };
    const n = APPLY_CHUNK * 2 + 10;
    store.setRidden(Array.from({ length: n }, (_, i) => i));
    await layer.sync();
    expect(map.state.size).toBe(n);
    expect(report?.edges).toBe(n);
  });

  test("a change during an apply wins", async () => {
    const { map, store, layer } = setup();
    await layer.reapply();
    store.setRidden(Array.from({ length: APPLY_CHUNK * 3 }, (_, i) => i));
    const first = layer.sync();
    store.setRidden([1_000_000]);
    await Promise.all([first, layer.sync()]);
    expect([...map.state.keys()]).toEqual([1_000_000]);
  });
});

describe("inspect geometry", () => {
  test("distance to a segment and a polyline", () => {
    expect(distanceToSegment([5, 3], [0, 0], [10, 0])).toBe(3);
    expect(distanceToSegment([-4, 3], [0, 0], [10, 0])).toBe(5); // beyond the end: to the end point
    expect(
      distanceToLine(
        [5, 5],
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      ),
    ).toBe(5);
    expect(distanceToLine([3, 4], [[0, 0]])).toBe(5);
  });
});

describe("resolveDataUrl", () => {
  const base = "https://host.test/kompass/";
  test("defaults to ./data/ next to the app, so it works from a sub-path", () => {
    expect(resolveDataUrl("", base, undefined)).toBe("https://host.test/kompass/data/");
  });
  test("?data= beats the build variable; a trailing slash is added", () => {
    expect(resolveDataUrl("?data=/other/place", base, "./env/")).toBe("https://host.test/other/place/");
    expect(resolveDataUrl("", base, "./env/")).toBe("https://host.test/kompass/env/");
  });
});

describe("loadRegion", () => {
  const reply = (body: string, init: ResponseInit = {}) =>
    (async () => new Response(body, init)) as unknown as typeof fetch;
  const url = "https://host.test/data/";

  test("a missing manifest, or an index page in its place, is the empty state", async () => {
    expect((await loadRegion(url, reply("", { status: 404 }))).status).toBe("empty");
    const html = reply("<html>", { headers: { "content-type": "text/html" } });
    expect((await loadRegion(url, html)).status).toBe("empty");
  });

  test("a broken manifest is an error that says what is wrong", async () => {
    const state = await loadRegion(url, reply('{"schemaVersion": 1}'));
    expect(state).toMatchObject({ status: "error" });
    expect((state as { message: string }).message).toContain("builtAt");
    expect((await loadRegion(url, reply("{nope"))).status).toBe("error");
    expect((await loadRegion(url, reply("", { status: 500 }))).status).toBe("error");
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect((await loadRegion(url, offline)).status).toBe("error");
  });
});
