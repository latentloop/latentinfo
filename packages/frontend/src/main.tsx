import React, { StrictMode, Suspense, useEffect, useState } from "react";
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

function DeferredAgentation() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const idleWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (idleWindow.requestIdleCallback) {
      const id = idleWindow.requestIdleCallback(() => setReady(true), { timeout: 3000 })
      return () => idleWindow.cancelIdleCallback?.(id)
    }
    const id = globalThis.setTimeout(() => setReady(true), 1000)
    return () => globalThis.clearTimeout(id)
  }, [])

  if (!ready) return null
  return (
    <Suspense fallback={null}>
      <Agentation />
    </Suspense>
  )
}

createRoot(document.getElementById("agentation-root")!).render(
  <DeferredAgentation />,
);
