import { createFileRoute } from "@tanstack/react-router"

// Route component is a no-op — the real XPage is rendered by __root.tsx
// via Activity keep-alive. The hidden Outlet in __root.tsx needs this
// to keep TanStack Router's rendering cycle functional.
export const Route = createFileRoute("/data")({
  component: () => null,
})
