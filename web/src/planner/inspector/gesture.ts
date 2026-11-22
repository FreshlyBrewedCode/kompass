// The long press that opens the inspector on a touch screen (docs/planner.md, "Taps"): one finger held
// still for about half a second. Moving it (a pan), a second finger (a pinch) or lifting it early
// cancels. The click or `contextmenu` a browser may send after a long press belongs to it, so it does
// not also add a waypoint (`swallows`). Timers and the clock are injected for the tests.

export type Point = { x: number; y: number };

export const LONG_PRESS_MS = 500;
/** How far (px) the finger may drift before the press counts as a pan. */
export const LONG_PRESS_SLOP = 10;
/** How long after a long press a click or context menu is still its echo. */
const ECHO_MS = 800;

type Timers = {
  set: (run: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
  now: () => number;
};

const REAL: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export class LongPress {
  readonly #fire: (p: Point) => void;
  readonly #timers: Timers;
  readonly #ms: number;
  #start: Point | null = null;
  #timer: unknown = null;
  #firedAt = Number.NEGATIVE_INFINITY;

  constructor(fire: (p: Point) => void, options: { ms?: number; timers?: Timers } = {}) {
    this.#fire = fire;
    this.#ms = options.ms ?? LONG_PRESS_MS;
    this.#timers = options.timers ?? REAL;
  }

  /** Fingers down (all touches on the surface now). */
  down(touches: readonly Point[]) {
    this.cancel();
    const p = touches[0];
    if (touches.length !== 1 || !p) return;
    this.#start = p;
    this.#timer = this.#timers.set(() => {
      this.#timer = null;
      const at = this.#start;
      this.#start = null;
      if (!at) return;
      this.#firedAt = this.#timers.now();
      this.#fire(at);
    }, this.#ms);
  }

  move(touches: readonly Point[]) {
    const s = this.#start;
    const p = touches[0];
    if (!s) return;
    if (touches.length !== 1 || !p || Math.hypot(p.x - s.x, p.y - s.y) > LONG_PRESS_SLOP) this.cancel();
  }

  /** Fingers up (or the gesture was taken over by the browser). */
  up() {
    this.cancel();
  }

  cancel() {
    if (this.#timer !== null) this.#timers.clear(this.#timer);
    this.#timer = null;
    this.#start = null;
  }

  /** Whether a click or context menu now is the echo of a long press that just fired. */
  swallows(): boolean {
    return this.#timers.now() - this.#firedAt < ECHO_MS;
  }
}
