import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initThemeSync } from "./lib/theme";
import { I18nProvider } from "./lib/i18n";
import "./index.css";

initThemeSync();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
