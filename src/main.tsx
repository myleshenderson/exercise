import React from "react";
import ReactDOM from "react-dom/client";
import { RoutedApp } from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RoutedApp />
  </React.StrictMode>,
);
