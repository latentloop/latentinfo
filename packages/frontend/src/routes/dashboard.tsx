import { createFileRoute } from "@tanstack/react-router";

// Route component is a no-op — the real DashboardPage is rendered by __root.tsx
// via Activity keep-alive.
export const Route = createFileRoute("/dashboard")({
  component: () => null,
});
