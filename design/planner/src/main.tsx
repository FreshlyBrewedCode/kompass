import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { DirectionA } from "./directions/A";
import { DirectionB } from "./directions/B";
import { DirectionC } from "./directions/C";
import { DirectionD } from "./directions/D";
import { Index } from "./Index";
import { C1 } from "./round2/C1";
import { C2 } from "./round2/C2";
import { C3 } from "./round2/C3";
import { Final } from "./round3/Final";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/a" element={<DirectionA />} />
        <Route path="/b" element={<DirectionB />} />
        <Route path="/c" element={<DirectionC />} />
        <Route path="/d" element={<DirectionD />} />
        <Route path="/c1" element={<C1 />} />
        <Route path="/c2" element={<C2 />} />
        <Route path="/c3" element={<C3 />} />
        <Route path="/final" element={<Final />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
