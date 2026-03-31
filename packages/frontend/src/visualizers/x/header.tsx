import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatCount } from "./helpers"
import { FilterBar, type FilterToken, type FilterCategory } from "@/components/filter-bar"
import { SourceSelector, type DataSource } from "@/components/source-selector"

const CATEGORIES: readonly FilterCategory<"text" | "user" | "tag" | "content_date" | "collect_date">[] = [
  { type: "text", label: "Text", hint: "tweet content" },
  { type: "user", label: "User", hint: "name or @handle" },
  { type: "tag", label: "Tag", hint: "AI Safety, Space Tech" },
  { type: "content_date", label: "Content Date", hint: "yesterday, march 15, 2026-03" },
  { type: "collect_date", label: "Collect Date", hint: "3 days ago, last week" },
] as const
const DATE_TYPES = new Set(["content_date", "collect_date"] as const)

interface XHeaderProps {
  dataSource: DataSource
  onDataSourceChange: (v: DataSource) => void
  tokens: FilterToken[]
  onTokensChange: (tokens: FilterToken[]) => void
  onLiveText: (text: string) => void
  dateMode: string
  onDateModeChange: (mode: string) => void
  total: number
  totalUnfiltered: number
  error: string | null
}

export function XHeader({
  dataSource,
  onDataSourceChange,
  tokens,
  onTokensChange,
  onLiveText,
  dateMode,
  onDateModeChange,
  total,
  totalUnfiltered,
  error,
}: XHeaderProps) {
  const displayTotal = totalUnfiltered || total
  const hasFilters = tokens.length > 0

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-muted px-4 py-1.5">
      <div className="flex items-center gap-1.5">
        <SourceSelector value={dataSource} onChange={onDataSourceChange} />
        <div className="flex-1" />
        {error ? (
          <Badge variant="destructive" title={error} className="text-[11px] px-1.5 py-0">
            Load error
          </Badge>
        ) : displayTotal > 0 ? (
          <Badge variant="secondary" className="whitespace-nowrap text-[11px] px-1.5 py-0">
            {hasFilters
              ? formatCount(total) + " / " + formatCount(displayTotal)
              : formatCount(displayTotal)}{" "}
            tweets
          </Badge>
        ) : null}

        <FilterBar
          categories={CATEGORIES}
          tokens={tokens}
          onTokensChange={onTokensChange}
          onLiveText={onLiveText}
          dateTypes={DATE_TYPES}
          inputId="searchInput-data"
          placeholder="Filter tweets..."
          className="min-w-[200px]"
          style={{ width: 280 }}
        />

        <span className="text-[11px] text-muted-foreground whitespace-nowrap">Order:</span>
        <Select value={dateMode} onValueChange={onDateModeChange}>
          <SelectTrigger className="w-[110px] h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="post_date">Tweet Date</SelectItem>
            <SelectItem value="scrape_date">Collect Date</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </header>
  )
}
