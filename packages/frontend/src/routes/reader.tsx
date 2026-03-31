import { createFileRoute } from "@tanstack/react-router"

// Route component is a no-op — the real ReaderPage is rendered by __root.tsx
// via Activity keep-alive.
export const Route = createFileRoute("/reader")({
  component: () => null,
})
