import { useSyncExternalStore } from "react";

// The theme follows the system setting (index.html sets the class before the first paint).
const query = () => matchMedia("(prefers-color-scheme: dark)");

function subscribe(onChange: () => void) {
  const mq = query();
  const listener = () => {
    document.documentElement.classList.toggle("dark", mq.matches);
    onChange();
  };
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

/** "dark" or "light", as the system says; re-renders when it changes. */
export function useTheme(): "dark" | "light" {
  return useSyncExternalStore(subscribe, () => (query().matches ? "dark" : "light"));
}
