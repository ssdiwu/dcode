import { createRoot } from "react-dom/client";
import App from "./App";
import { RootBoundary } from "./components/RootBoundary";
import { initSnapshotBridge } from "./store";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <RootBoundary>
    <App />
  </RootBoundary>,
);
initSnapshotBridge();
