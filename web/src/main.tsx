import "./index.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

// `?bench`: the engine benchmark page (docs/engine-web.md), on whatever region is loaded
const BenchPage = lazy(() => import("./bench/bench-page"));
const bench = new URLSearchParams(location.search).has("bench");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {bench ? (
      <Suspense fallback={null}>
        <BenchPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);

// the app shell offline (public/sw.js); not in dev, where Vite serves modules on the fly
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
