import React from "react";
import ReactDOM from "react-dom/client";
import { Overlay } from "./Overlay";
import { useSettings, followSettingsBroadcasts } from "@/state/settings";
import "@/styles.css";

useSettings.getState().init();
followSettingsBroadcasts();

ReactDOM.createRoot(document.getElementById("overlay-root")!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>
);
