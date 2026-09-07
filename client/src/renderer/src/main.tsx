import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { installMotionTokens } from "./workbench/motion";

const container = document.getElementById("root");
if (!container) throw new Error("#root missing in renderer index.html");
installMotionTokens(document.documentElement);
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
