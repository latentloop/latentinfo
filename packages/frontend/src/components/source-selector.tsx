/**
 * Data source selector — shadcn Select with favicons in dropdown items.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type DataSource = "x" | "arxiv"

const SOURCES: { value: DataSource; label: string; domain: string }[] = [
  { value: "x", label: "x", domain: "x.com" },
  { value: "arxiv", label: "arxiv", domain: "arxiv.org" },
]

interface SourceSelectorProps {
  value: DataSource
  onChange: (v: DataSource) => void
}

export function SourceSelector({ value, onChange }: SourceSelectorProps) {
  const current = SOURCES.find((s) => s.value === value) ?? SOURCES[0]!

  return (
    <Select value={value} onValueChange={(v) => onChange(v as DataSource)}>
      <SelectTrigger className="h-7 w-auto gap-1.5 text-xs font-medium border-0 bg-transparent px-1.5 focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SOURCES.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            <span className="inline-flex items-center gap-2">
              <img
                src={`https://www.google.com/s2/favicons?domain=${s.domain}&sz=32`}
                width={14}
                height={14}
                alt=""
                className="rounded-sm shrink-0"
              />
              <span>{s.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
