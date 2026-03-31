/**
 * Generic Finder-style filter bar with token pills and category dropdown.
 *
 * Typing immediately filters by text (default). The dropdown always shows
 * all filter categories. Selecting a category changes the filter mode
 * and creates a token pill.
 *
 * Each page configures its own categories via props.
 */

import { useState, useRef, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { parseDateRange } from "@/lib/date-parser"
import { Icon } from "@iconify/react"

export interface FilterToken<T extends string = string> {
  id: string
  type: T
  label: string
  value: string
  dateFrom?: string
  dateTo?: string
}

export interface FilterCategory<T extends string = string> {
  type: T
  label: string
  hint: string
}

interface FilterBarProps<T extends string> {
  categories: readonly FilterCategory<T>[]
  tokens: FilterToken<T>[]
  onTokensChange: (tokens: FilterToken<T>[]) => void
  /** Called on every keystroke for immediate text filtering */
  onLiveText?: (text: string) => void
  placeholder?: string
  /** Set of category types that should be parsed as dates via parseDateRange */
  dateTypes?: ReadonlySet<T>
  /** Element ID for the input — used by root Cmd+F handler */
  inputId?: string
  className?: string
  style?: React.CSSProperties
}

let nextId = 0

export function FilterBar<T extends string>({
  categories,
  tokens,
  onTokensChange,
  onLiveText = () => {},
  placeholder,
  dateTypes,
  inputId = "searchInput",
  className,
  style,
}: FilterBarProps<T>) {
  const [inputValue, setInputValue] = useState("")
  const [showDropdown, setShowDropdown] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Show dropdown when there's input text
  const hasInput = inputValue.trim().length > 0

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      setInputValue(val)
      setShowDropdown(val.trim().length > 0)
      setSelectedIdx(0)
      onLiveText(val)
    },
    [onLiveText],
  )

  const selectCategory = useCallback(
    (type: T) => {
      const text = inputValue.trim()
      if (!text) return

      const isDate = dateTypes?.has(type)
      let token: FilterToken<T>

      if (isDate) {
        const dateRange = parseDateRange(text)
        const cat = categories.find((c) => c.type === type)
        token = {
          id: `tok-${++nextId}`,
          type,
          label: `${cat?.label ?? type}: ${dateRange?.label || text}`,
          value: text,
          dateFrom: dateRange?.from.toISOString(),
          dateTo: dateRange?.to.toISOString(),
        }
      } else if (type === "text") {
        token = {
          id: `tok-${++nextId}`,
          type,
          label: `"${text}"`,
          value: text,
        }
      } else {
        const cat = categories.find((c) => c.type === type)
        token = {
          id: `tok-${++nextId}`,
          type,
          label: `${cat?.label ?? type}: ${text}`,
          value: text,
        }
      }

      onTokensChange([...tokens, token])
      setInputValue("")
      setShowDropdown(false)
      onLiveText("")
      inputRef.current?.focus()
    },
    [tokens, onTokensChange, onLiveText, inputValue, categories, dateTypes],
  )

  const removeToken = useCallback(
    (id: string) => {
      onTokensChange(tokens.filter((t) => t.id !== id))
      inputRef.current?.focus()
    },
    [tokens, onTokensChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Backspace" && inputValue === "" && tokens.length > 0) {
        e.preventDefault()
        onTokensChange(tokens.slice(0, -1))
        return
      }
      if (!showDropdown) return
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, categories.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        e.preventDefault()
        selectCategory(categories[selectedIdx]!.type)
      } else if (e.key === "Escape") {
        setShowDropdown(false)
      }
    },
    [inputValue, tokens, showDropdown, selectedIdx, onTokensChange, selectCategory, categories],
  )

  const defaultPlaceholder = tokens.length === 0 ? (placeholder ?? "Filter...") : "Add filter..."

  return (
    <div ref={containerRef} className={cn("relative", className)} style={style}>
      {/* Input container with pills */}
      <div
        className="flex items-center flex-wrap gap-1 bg-background border border-border rounded-md px-2 h-auto min-h-[28px] cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {tokens.map((token) => (
          <span
            key={token.id}
            className="inline-flex items-center gap-0.5 bg-primary/15 text-primary text-[10px] font-medium px-1.5 py-0.5 rounded-sm shrink-0 leading-none"
          >
            {token.label}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                removeToken(token.id)
              }}
              className="ml-0.5 hover:text-foreground"
            >
              <Icon icon="solar:close-circle-bold" width={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          placeholder={defaultPlaceholder}
          autoComplete="off"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-[80px] bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground py-1"
        />
        {tokens.length === 0 && !inputValue ? (
          <kbd className="pointer-events-none text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded border border-border shrink-0">
            ⌘F
          </kbd>
        ) : (tokens.length > 0 || inputValue) ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onTokensChange([])
              setInputValue("")
              setShowDropdown(false)
              onLiveText("")
              inputRef.current?.focus()
            }}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            title="Clear all filters"
          >
            <Icon icon="solar:close-circle-bold" width={14} />
          </button>
        ) : null}
      </div>

      {/* Category dropdown — always shows all options */}
      {showDropdown && hasInput && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-md shadow-lg z-50 py-1 text-xs">
          {categories.map((cat, i) => (
            <button
              key={cat.type}
              type="button"
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
                i === selectedIdx
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => selectCategory(cat.type)}
            >
              <span className="font-medium shrink-0">{cat.label}</span>
              <span className="text-muted-foreground truncate">({cat.hint})</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
