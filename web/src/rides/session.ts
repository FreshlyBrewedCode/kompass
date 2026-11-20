// The app's one ride library session: the ride worker, started on first use, and its state.

import { startRides } from "./client";
import { RidesState } from "./state";

let state: RidesState | null = null;

export function ridesState(): RidesState {
  state ??= new RidesState(startRides());
  return state;
}
