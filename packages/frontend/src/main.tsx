import React, { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import "@/lib/icons";
import "@/styles/global.css";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 30_000,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

// Render Agentation into a separate DOM root so Radix UI's aria-hidden
// on #root siblings doesn't trap focus inside the agentation overlay.
const Agentation = React.lazy(() => import("agentation").then(m => ({ default: m.Agentation })));
createRoot(document.getElementById("agentation-root")!).render(
  <Suspense fallback={null}>
    <Agentation />
  </Suspense>,
);
