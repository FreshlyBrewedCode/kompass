import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { DirectionA } from "./directions/A";
import { DirectionB } from "./directions/B";
import { DirectionC } from "./directions/C";
import { DirectionD } from "./directions/D";
import { Index } from "./Index";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/a" element={<DirectionA />} />
        <Route path="/b" element={<DirectionB />} />
        <Route path="/c" element={<DirectionC />} />
        <Route path="/d" element={<DirectionD />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
