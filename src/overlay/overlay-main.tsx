import React from "react";
import ReactDOM from "react-dom/client";
import { Overlay } from "./Overlay";
import { useSettings, followSettingsBroadcasts } from "@/state/settings";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@/styles.css";

useSettings.getState().init();
followSettingsBroadcasts();

ReactDOM.createRoot(document.getElementById("overlay-root")!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>
);
