import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/300.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import { App } from "./App";
import { connect, tickAges } from "./ws";
import { loadVoiceConfig, useStore } from "./store";

(window as unknown as { __store: typeof useStore }).__store = useStore; // debugging

document.documentElement.dataset.theme = (() => {
  try {
    return localStorage.getItem("theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch {
    return "dark";
  }
})();
connect();
loadVoiceConfig();
tickAges();
createRoot(document.getElementById("root")!).render(<App />);
