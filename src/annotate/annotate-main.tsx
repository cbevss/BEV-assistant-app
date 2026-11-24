import React from "react";
import ReactDOM from "react-dom/client";
import { Annotate } from "./Annotate";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";

ReactDOM.createRoot(document.getElementById("annotate-root")!).render(
  <React.StrictMode>
    <Annotate />
  </React.StrictMode>
);
