import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

/**
 * Registered only so the browser will offer to install this as an app.
 *
 * `public/sw.js` caches nothing and says why. Registration is deliberately
 * fire-and-forget and never blocks the app: a browser that refuses — an
 * insecure origin, a disabled worker, private browsing — should still get a
 * working desktop, just without the install option.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
