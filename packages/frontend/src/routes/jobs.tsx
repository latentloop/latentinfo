import { createFileRoute } from "@tanstack/react-router"

type SearchParams = { job?: string }

export const Route = createFileRoute("/jobs")({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    job: typeof search.job === "string" ? search.job : undefined,
  }),
  component: () => null,
})
