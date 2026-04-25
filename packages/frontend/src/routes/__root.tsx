import { createRootRoute, Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import React, { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { queryClient } from "@/lib/query-client";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { TabContext, type AppTab } from "@/lib/tab-context";
import type { DataSource } from "@/components/source-selector";
import { Toaster } from "@/components/ui/sonner";
const DashboardPage = React.lazy(() => import("./-dashboard.page").then(m => ({ default: m.DashboardPage })));
const XPage = React.lazy(() => import("./-data.page").then(m => ({ default: m.XPage })));
const ReaderPage = React.lazy(() => import("./-reader.page").then(m => ({ default: m.ReaderPage })));
const ArxivPage = React.lazy(() => import("@/visualizers/arxiv/page").then(m => ({ default: m.ArxivPage })));
const GithubPage = React.lazy(() => import("@/visualizers/github/page").then(m => ({ default: m.GithubPage })));
const JobRunsPage = React.lazy(() => import("./-jobs.page").then(m => ({ default: m.JobRunsPage })));

const TAB_BAR_HEIGHT = "2.75rem";
const LazyFallback = <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading...</div>;

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: "solar:widget-5-bold" },
  { to: "/data", label: "Data", icon: "solar:global-bold" },
  { to: "/reader", label: "Reader", icon: "solar:book-bold" },
  { to: "/jobs", label: "Job Run", icon: "solar:clock-circle-bold" },
] as const;

function ShortcutBadge({ n }: { n: number }) {
  return (
    <kbd className="ml-auto inline-flex items-center gap-0.5 shrink-0 rounded bg-muted/60 px-1 py-px text-[10px] font-mono text-muted-foreground/70 leading-none">
      <span className="text-[11px]">&#8984;</span>{n}
    </kbd>
  );
}

function isDataSource(value: string | null): value is DataSource {
  return value === "x" || value === "arxiv" || value === "github";
}

function DataSourceSwitcher({ source, onSourceChange }: { source: DataSource; onSourceChange: (v: DataSource) => void }) {
  if (source === "arxiv") {
    return <ArxivPage dataSource={source} onDataSourceChange={onSourceChange} />;
  }
  if (source === "github") {
    return <GithubPage dataSource={source} onDataSourceChange={onSourceChange} />;
  }
  return <XPage dataSource={source} onDataSourceChange={onSourceChange} />;
}

function RootLayout() {
  const matches = useMatches();
  const pathname = matches[matches.length - 1]?.pathname ?? "/";
  const navigate = useNavigate();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const [dataSource, setDataSource] = useState<DataSource>(() => {
    if (typeof localStorage === "undefined") return "x";
    const stored = localStorage.getItem("latent_dataSource");
    return isDataSource(stored) ? stored : "x";
  });

  const [tabs, setTabs] = useState<AppTab[]>([]);
  const [activeTabId, setActiveTabIdRaw] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const setActiveTabId = useCallback((idOrFn: string | null | ((prev: string | null) => string | null)) => {
    setActiveTabIdRaw((prev) => {
      const next = typeof idOrFn === "function" ? idOrFn(prev) : idOrFn;
      activeTabIdRef.current = next;
      return next;
    });
  }, []);

  const openTab = useCallback((id: string, label: string, route: string, params?: Record<string, string | number>) => {
    const qs = params && Object.keys(params).length > 0
      ? "?" + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")
      : "";
    const url = `/app/${encodeURIComponent(route)}/${qs}`;
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === id);
      if (existing) {
        if (qs && existing.url !== url) {
          return prev.map((t) => t.id === id ? { ...t, url } : t);
        }
        setActiveTabId(id);
        return prev;
      }
      return [...prev, { id, label, url }];
    });
    setActiveTabId(id);
  }, [setActiveTabId]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setActiveTabId((prev) => prev === id ? null : prev);
  }, [setActiveTabId]);

  // Shared SSE connection — UI events via window, data events via QueryClient invalidation
  useEffect(() => {
    const es = new EventSource("/api/v1/events");
    es.addEventListener("open-app", (e) => {
      try {
        const data = JSON.parse(e.data) as { route: string; label?: string; params?: Record<string, string | number> };
        openTab(data.route, data.label || data.route, data.route, data.params);
        setTimeout(() => {
          const iframe = document.querySelector(
            `iframe[data-tab-id="${data.route}"]`,
          ) as HTMLIFrameElement | null;
          iframe?.contentWindow?.postMessage(
            { type: "lwe:open-app", route: data.route, params: data.params || {} },
            "*",
          );
        }, 100);
      } catch { /* ignore malformed events */ }
    });
    es.addEventListener("data-changed", (e) => {
      window.dispatchEvent(new CustomEvent("sse:data-changed", { detail: e.data }));
    });
    es.addEventListener("jobs-updated", () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    });
    es.addEventListener("session-changed", () => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    });
    es.addEventListener("settings-changed", () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    });
    es.onerror = () => {
      // Reconnect gap — re-fetch all active queries to recover any missed updates
      queryClient.invalidateQueries({ refetchType: "active" });
    };
    return () => es.close();
  }, [openTab]);

  const cycleTab = useCallback((direction: 1 | -1) => {
    const navIds = NAV_ITEMS.map((_, i) => `nav-${i}`);
    const appIds = tabsRef.current.map((t) => t.id);
    const allIds = [...navIds, ...appIds];
    const currentId = activeTabIdRef.current;
    let curIdx: number;
    if (currentId === null) {
      // Find which nav item matches the current pathname
      const navIdx = NAV_ITEMS.findIndex((item) => pathnameRef.current.startsWith(item.to));
      curIdx = navIdx >= 0 ? navIdx : 0;
    } else {
      curIdx = allIds.indexOf(currentId);
      if (curIdx < 0) curIdx = 0;
    }
    const next = (curIdx + direction + allIds.length) % allIds.length;
    const nextId = allIds[next]!;
    if (nextId.startsWith("nav-")) {
      const idx = parseInt(nextId.slice(4), 10);
      setActiveTabId(null);
      navigate({ to: NAV_ITEMS[idx]!.to });
    } else {
      setActiveTabId(nextId);
    }
  }, [navigate, setActiveTabId]);

  const handleShortcut = useCallback((e: KeyboardEvent) => {
    // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }

    if (!e.metaKey) return;

    const totalSlots = NAV_ITEMS.length + tabsRef.current.length;

    // Cmd+1..9: switch to specific tab
    if (e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      const n = parseInt(e.key, 10);
      if (n <= NAV_ITEMS.length) {
        setActiveTabId(null);
        navigate({ to: NAV_ITEMS[n - 1]!.to });
      } else {
        const idx = n - NAV_ITEMS.length - 1;
        const t = tabsRef.current;
        if (idx >= 0 && idx < t.length) {
          setActiveTabId(t[idx]!.id);
        }
      }
      return;
    }

    // Cmd+F: focus search
    if (e.key === "f") {
      if (activeTabIdRef.current) {
        e.preventDefault();
        try {
          const iframe = document.querySelector(
            `iframe[data-tab-id="${activeTabIdRef.current}"]`,
          ) as HTMLIFrameElement | null;
          iframe?.contentWindow?.postMessage({ type: "lwe:focus-search" }, "*");
        } catch { /* cross-origin */ }
      } else {
        // Resolve the correct filter input ID based on the active page
        const path = window.location.pathname
        let inputId: string
        if (path.startsWith("/reader")) inputId = "searchInput-reader"
        else if (path.startsWith("/jobs")) inputId = "searchInput-jobs"
        else inputId = "searchInput-data"
        const search = document.getElementById("search") ?? document.getElementById(inputId);
        if (search) {
          e.preventDefault();
          (search as HTMLElement).focus();
        }
      }
      return;
    }

    // Cmd+R: reload active app tab iframe
    if (e.key === "r" && activeTabIdRef.current) {
      e.preventDefault();
      try {
        const iframe = document.querySelector(
          `iframe[data-tab-id="${activeTabIdRef.current}"]`,
        ) as HTMLIFrameElement | null;
        if (iframe?.contentWindow) iframe.contentWindow.location.reload();
      } catch { /* cross-origin */ }
      return;
    }

    // Cmd+W: close active app tab
    if (e.key === "w" && activeTabIdRef.current) {
      e.preventDefault();
      const id = activeTabIdRef.current;
      setTabs((prev) => prev.filter((t) => t.id !== id));
      setActiveTabId(null);
    }
  }, [navigate, cycleTab, setActiveTabId]);

  useEffect(() => {
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [handleShortcut]);

  // Re-focus window on alt-tab back
  useEffect(() => {
    const handler = () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
        const id = activeTabIdRef.current;
        if (id) {
          const iframe = document.querySelector(`iframe[data-tab-id="${id}"]`) as HTMLIFrameElement | null;
          if (iframe?.contentWindow) { iframe.contentWindow.focus(); return; }
        }
        window.focus();
      }, 50);
    };
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, []);

  // ResizeObserver for iframes
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const iframe = entry.target as HTMLIFrameElement;
        try {
          iframe.contentWindow?.dispatchEvent(new Event("resize"));
        } catch { /* cross-origin */ }
      }
    });
    for (const iframe of document.querySelectorAll<HTMLIFrameElement>("iframe[data-tab-id]")) {
      observer.observe(iframe);
    }
    return () => observer.disconnect();
  }, [tabs]);

  // Forward shortcuts from iframe windows
  const handleIframeLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    try {
      const iframe = e.target as HTMLIFrameElement;
      const iframeWin = iframe.contentWindow;
      if (!iframeWin) return;
      iframeWin.addEventListener("keydown", (ev) => {
        const ke = ev as KeyboardEvent;
        if (ke.ctrlKey && ke.key === "Tab") {
          ke.preventDefault();
          cycleTab(ke.shiftKey ? -1 : 1);
          return;
        }
        if (!ke.metaKey) return;
        if (ke.key >= "1" && ke.key <= "9") { ke.preventDefault(); handleShortcut(ke); return; }
        if (ke.key === "w") { ke.preventDefault(); handleShortcut(ke); }
      });
    } catch { /* cross-origin */ }
  }, [handleShortcut, cycleTab]);

  const showingAppTab = activeTabId !== null;
  const tabBase = "group flex items-center gap-2 h-8 mt-auto px-3 text-xs font-medium rounded-t-md border border-b-0 transition-colors";
  const tabActive = "bg-background text-foreground border-border -mb-px relative z-10 shadow-[inset_0_2px_0_var(--ring)]";
  const tabInactive = "text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/50";
  const renderMainPage = () => {
    if (pathname.startsWith("/data")) {
      return (
        <DataSourceSwitcher
          source={dataSource}
          onSourceChange={(v) => {
            setDataSource(v);
            localStorage.setItem("latent_dataSource", v);
          }}
        />
      );
    }
    if (pathname.startsWith("/reader")) return <ReaderPage />;
    if (pathname.startsWith("/jobs")) return <JobRunsPage />;
    return <DashboardPage />;
  };

  return (
    <QueryClientProvider client={queryClient}>
    <TabContext.Provider value={{ openTab }}>
      <Toaster />
      <div className="flex flex-col h-screen">
        {/* Tab bar */}
        <nav
          className="flex items-end gap-px bg-card border-b border-border pl-20 pr-4 pt-2 shrink-0 app-drag-region"
          style={{ height: TAB_BAR_HEIGHT }}
        >
          {/* Nav items */}
          {NAV_ITEMS.map((item, i) => {
            const isActive =
              !showingAppTab &&
              (pathname === item.to ||
                pathname.startsWith(item.to + "/") ||
                (item.to === "/dashboard" && pathname === "/"));

            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setActiveTabId(null)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                  isActive
                    ? "border-ring text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted",
                )}
              >
                <Icon icon={item.icon} className="size-4" />
                <span>{item.label}</span>
                <ShortcutBadge n={i + 1} />
              </Link>
            );
          })}

          {/* App tabs */}
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              className={cn(tabBase, "max-w-[14rem]", activeTabId === tab.id ? tabActive : tabInactive)}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span className="truncate">{tab.label}</span>
              <span className="ml-auto relative size-5 shrink-0">
                {i < 7 && (
                  <span className="absolute inset-0 flex items-center justify-center group-hover:opacity-0 transition-opacity">
                    <ShortcutBadge n={NAV_ITEMS.length + i + 1} />
                  </span>
                )}
                <span
                  className="absolute inset-0 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                >
                  <Icon icon="solar:close-circle-bold" className="size-3" />
                </span>
              </span>
            </button>
          ))}
        </nav>

        {/* Content area */}
        <div className="flex-1 relative min-h-0">
          {/* Hidden Outlet keeps TanStack Router's rendering cycle functional */}
          <div className="hidden"><Outlet /></div>
          {!showingAppTab && (
            <main className="absolute inset-0 overflow-y-auto">
              <Suspense fallback={LazyFallback}>
                {renderMainPage()}
              </Suspense>
            </main>
          )}

          {/* App tab iframes */}
          {tabs.map((tab) => (
            <iframe
              key={tab.id}
              data-tab-id={tab.id}
              src={tab.url}
              onLoad={handleIframeLoad}
              className={cn(
                "absolute inset-0 w-full h-full border-0",
                activeTabId !== tab.id && "invisible pointer-events-none",
              )}
            />
          ))}
        </div>
      </div>
    </TabContext.Provider>
    </QueryClientProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});
