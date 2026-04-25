import { createFileRoute } from "@tanstack/react-router"

// Route component is a no-op — the root layout renders the active page directly.
export const Route = createFileRoute("/reader")({
  component: () => null,
})
