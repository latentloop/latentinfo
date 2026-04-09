import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Icon } from "@iconify/react";
import { BrowserIcon } from "@/components/browser-icon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CollectorStatus {
  id: string;
  documentCount: number;
  lastCollectionTime: string | null;
}

interface StatusResponse {
  totalDocuments?: number;
  lastCollectionTime?: string | null;
  collectors?: CollectorStatus[];
}

interface BrowserSession {
  sessionName: string;
  pid: number;
  browserName: string;
  appPath: string;
  profilePath: string;
  startedAt: string;
  alive: boolean;
  cdpPort: number | null;
  attached: boolean;
  connectionError: string | null;
}

interface BrowserEntry {
  name: string;
  version: string;
}

interface AppSettings {
  autoAttach: boolean;
  browsers: BrowserEntry[];
  remoteDebuggingAutoAllow?: boolean;
  logLevel?: string;
}

interface CollectorConfig {
  enabled?: boolean;
  freshMinutes?: number;
  freshUnit?: "sec" | "min";
  auto_detect?: Record<string, boolean>;
}

interface CollectorInfo {
  id: string;
  description: string;
  urlPatterns: string[];
  config: CollectorConfig;
}

interface JobTriggers {
  schedule?: number[];
  events?: string[];
}

interface JobLastRun {
  id: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

interface JobManualRun {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

interface JobInfo {
  id: string;
  description: string;
  triggers: JobTriggers;
  config: Record<string, unknown>;
  eventEnabled: boolean;
  promptPath: string | null;
  lastRun?: JobLastRun;
  lastManualRun?: JobManualRun;
}

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

// Module-level caches so data survives unmount/remount on route switch
const _overviewCache: {
  status: StatusResponse | null;
  sessions: BrowserSession[];
  collectors: CollectorInfo[];
  jobs: JobInfo[];
  browsers: { name: string }[];
} = { status: null, sessions: [], collectors: [], jobs: [], browsers: [] };

const _settingsCache: { settings: AppSettings | null } = { settings: null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorten an absolute path for display: replace homedir prefix with ~. */
function shortenPath(path: string): string {
  const home = window.electronAPI?.homedir;
  if (!home || !path) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

/** Extract a display domain from a collector's URL patterns (e.g. "x.com"). */
function collectorDomain(c: CollectorInfo): string | null {
  try {
    const url = c.urlPatterns[0]?.replace(/\*/g, "example") ?? "";
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Overview sub-view (status + sessions)
// ---------------------------------------------------------------------------

function OverviewView() {
  const [status, setStatus] = useState<StatusResponse | null>(_overviewCache.status);
  const [sessions, setSessions] = useState<BrowserSession[]>(_overviewCache.sessions);
  const [error, setError] = useState<string | null>(null);
  const [collectors, setCollectors] = useState<CollectorInfo[]>(_overviewCache.collectors);
  const [jobs, setJobs] = useState<JobInfo[]>(_overviewCache.jobs);
  const [browsers, setBrowsers] = useState<{ name: string }[]>(_overviewCache.browsers);
  const [selectedBrowser, setSelectedBrowser] = useState(() => _overviewCache.browsers[0]?.name ?? "");
  const [launching, setLaunching] = useState(false);
  const [attachErrors, setAttachErrors] = useState<Record<string, string>>({});
  const refreshSessions = useCallback(() => {
    fetch("/api/v1/sessions")
      .then((r) => {
        if (!r.ok) throw new Error(`Sessions API returned ${r.status}`);
        return r.json();
      })
      .then((data: { sessions: BrowserSession[] }) => {
        setSessions(data.sessions);
        _overviewCache.sessions = data.sessions;
      })
      .catch(() => {});
  }, []);

  const refreshJobs = useCallback(() => {
    fetch("/api/v1/jobs")
      .then((r) => {
        if (!r.ok) throw new Error(`Jobs API returned ${r.status}`);
        return r.json();
      })
      .then((data: { jobs: JobInfo[] }) => {
        setJobs(data.jobs);
        _overviewCache.jobs = data.jobs;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/v1/status")
      .then((r) => {
        if (!r.ok) throw new Error(`Status API returned ${r.status}`);
        return r.json();
      })
      .then((data: StatusResponse) => { setStatus(data); _overviewCache.status = data; })
      .catch((e) => setError(e.message ?? "Failed to load status"));

    fetch("/api/v1/collectors")
      .then((r) => {
        if (!r.ok) throw new Error(`Collectors API returned ${r.status}`);
        return r.json();
      })
      .then((data: { collectors: CollectorInfo[] }) => { setCollectors(data.collectors); _overviewCache.collectors = data.collectors; })
      .catch(() => {});

    fetch("/api/v1/settings")
      .then((r) => r.json())
      .then((data: { browsers?: { name: string }[] }) => {
        const b = data.browsers ?? [];
        setBrowsers(b);
        _overviewCache.browsers = b;
        if (b.length > 0) setSelectedBrowser(b[0]!.name);
      })
      .catch(() => {});

    refreshSessions();
    refreshJobs();
    const onSessionChanged = () => refreshSessions();
    const onJobsUpdated = () => refreshJobs();
    window.addEventListener("sse:session-changed", onSessionChanged);
    window.addEventListener("sse:jobs-updated", onJobsUpdated);
    return () => { window.removeEventListener("sse:session-changed", onSessionChanged); window.removeEventListener("sse:jobs-updated", onJobsUpdated); };
  }, [refreshSessions, refreshJobs]);

  const handleLaunch = useCallback(() => {
    if (!selectedBrowser || launching) return;
    setLaunching(true);
    fetch("/api/v1/sessions/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserName: selectedBrowser }),
    })
      .then(() => {
        setTimeout(() => {
          refreshSessions();
          setLaunching(false);
        }, 2000);
      })
      .catch(() => setLaunching(false));
  }, [selectedBrowser, launching, refreshSessions]);

  const handleAttach = useCallback(
    (session: BrowserSession) => {
      setAttachErrors((prev) => { const next = { ...prev }; delete next[session.sessionName]; return next; });
      fetch("/api/v1/sessions/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionName: session.sessionName }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const fallback =
              r.status === 502 || r.status === 503
                ? "Backend is not reachable — it may still be starting up. Try again in a few seconds."
                : r.status === 404
                  ? "Browser session is no longer available. Try refreshing the session list."
                  : `Connection failed (HTTP ${r.status}). Check that the backend is running.`;
            const data = await r.json().catch(() => ({ error: fallback }));
            setAttachErrors((prev) => ({ ...prev, [session.sessionName]: data.error ?? fallback }));
          }
          refreshSessions();
        })
        .catch(() => {
          setAttachErrors((prev) => ({ ...prev, [session.sessionName]: "Could not reach the backend — check that it is running and try again." }));
        });
    },
    [refreshSessions],
  );

  const handleDetach = useCallback(
    (session: BrowserSession) => {
      fetch("/api/v1/sessions/detach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionName: session.sessionName }),
      })
        .then(() => refreshSessions())
        .catch(() => {});
    },
    [refreshSessions],
  );

  const handleCollectorConfigChange = useCallback(
    (collectorId: string, config: CollectorConfig) => {
      // Optimistic update
      setCollectors((prev) => {
        const updated = prev.map((c) =>
          c.id === collectorId ? { ...c, config } : c,
        );
        _overviewCache.collectors = updated;
        return updated;
      });
      // Persist via settings
      fetch("/api/v1/settings")
        .then((r) => r.json())
        .then((current: { collectors?: Record<string, CollectorConfig> }) => {
          const merged = { collectors: { ...current.collectors, [collectorId]: config } };
          return fetch("/api/v1/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(merged),
          });
        })
        .then(() => { toast.success("Settings saved") })
        .catch(() => { toast.error("Failed to save settings") });
    },
    [],
  );

  if (error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load overview: {error}
      </div>
    );
  }

  if (!status) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  const aliveSessions = sessions.filter((s) => s.alive);

  return (
    <>
      {/* Sessions */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-lg font-semibold text-foreground whitespace-nowrap">New Session</span>
        <Select value={selectedBrowser} onValueChange={setSelectedBrowser}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Select browser">
              {browsers.find((b) => b.name === selectedBrowser)?.name ?? "Select browser"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {browsers.map((b) => (
              <SelectItem key={b.name} value={b.name}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={handleLaunch} disabled={launching || !selectedBrowser}>
          <Icon icon="solar:play-bold" className="h-3.5 w-3.5 mr-1" />
          {launching ? "Launching..." : "Start"}
        </Button>
      </div>

      <div className="border border-border rounded-lg overflow-hidden mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Browser</TableHead>
              <TableHead>PID</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Session</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {aliveSessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  No sessions — start a browser above.
                </TableCell>
              </TableRow>
            ) : (
              aliveSessions.map((session) => {
                const errorMsg = attachErrors[session.sessionName] || session.connectionError;
                return (
                  <TableRow key={session.sessionName}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <BrowserIcon
                          appPath={session.appPath}
                          width={18}
                          height={18}
                          alt=""
                          className="rounded-sm shrink-0"
                        />
                        <code className="text-xs text-muted-foreground whitespace-nowrap">
                          {shortenPath(session.appPath)}
                        </code>
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <code>{session.pid}</code>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatTime(session.startedAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <code>{session.sessionName}</code>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-3 text-sm text-muted-foreground whitespace-nowrap">
                        {session.cdpPort && <>CDP Port: {session.cdpPort}</>}
                        {session.attached ? (
                          <span className="inline-flex items-center gap-1 text-sm text-green-500">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            Connected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-sm text-red-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
                            Disconnected
                          </span>
                        )}
                        {session.attached ? (
                          <Button variant="destructive" size="sm" className="h-6 px-2 text-xs" onClick={() => handleDetach(session)}>
                            <Icon icon="solar:link-broken-bold" className="h-3 w-3 mr-1" />
                            Disconnect
                          </Button>
                        ) : (
                          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => handleAttach(session)}>
                            <Icon icon="solar:plug-circle-bold" className="h-4 w-4 mr-1" />
                            Connect
                          </Button>
                        )}
                      </span>
                      {errorMsg && !session.attached && (
                        <div className="w-0 min-w-full mt-1.5">
                        <div className="flex items-start gap-1.5 text-xs text-red-400">
                          <Icon icon="solar:danger-triangle-bold" className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                          <span>
                            {errorMsg.split("chrome://inspect").map((part, i, arr) =>
                              i < arr.length - 1 ? (
                                <span key={i}>
                                  {part}
                                  <button
                                    type="button"
                                    className="inline underline underline-offset-2 hover:opacity-80 cursor-pointer"
                                    onClick={() => { navigator.clipboard.writeText("chrome://inspect"); toast.success("Copied chrome://inspect to clipboard"); }}
                                  >chrome://inspect</button>
                                  <button
                                    type="button"
                                    className="inline-flex items-center ml-0.5 align-middle opacity-60 hover:opacity-100"
                                    title="Copy chrome://inspect"
                                    onClick={() => { navigator.clipboard.writeText("chrome://inspect"); toast.success("Copied chrome://inspect to clipboard"); }}
                                  >
                                    <Icon icon="solar:copy-line-duotone" className="h-3 w-3" />
                                  </button>
                                </span>
                              ) : (
                                <span key={i}>{part}</span>
                              ),
                            )}
                          </span>
                        </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Collectors */}
      <h2 className="text-lg font-semibold text-foreground mb-3">Collectors</h2>
      <div className="border border-border rounded-lg overflow-hidden mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Config</TableHead>
              <TableHead className="text-right">Enabled</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collectors.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  No collectors found
                </TableCell>
              </TableRow>
            ) : (
              collectors.map((c) => (
                <CollectorRow key={c.id} collector={c} onConfigChange={handleCollectorConfigChange} />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Jobs */}
      <h2 className="text-lg font-semibold text-foreground mb-3">Jobs</h2>
      <div className="border border-border rounded-lg overflow-hidden mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Config</TableHead>
              <TableHead>Run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                  No jobs found
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <JobRow key={job.id} job={job} onRunComplete={refreshJobs} cdpConnected={sessions.some((s) => s.attached)} />
              ))
            )}
          </TableBody>
        </Table>
      </div>

    </>
  );
}

// ---------------------------------------------------------------------------
// Collector row
// ---------------------------------------------------------------------------

function AutoDetectToggle({ collectorId, config, onConfigChange }: {
  collectorId: string;
  config: CollectorConfig;
  onConfigChange: (id: string, config: CollectorConfig) => void;
}) {
  const autoDetect = config.auto_detect;
  const xArticleEnabled = autoDetect?.x_article === true; // default false

  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className="font-bold text-foreground">Auto Clip</span>
      <label className="inline-flex items-center gap-2 text-muted-foreground">
        <span className="whitespace-nowrap">X article</span>
        <Switch
          checked={xArticleEnabled}
          onCheckedChange={(checked) => {
            const newAutoDetect = { ...(autoDetect ?? {}), x_article: checked, x_article_graphql: false };
            onConfigChange(collectorId, { ...config, auto_detect: newAutoDetect });
          }}
        />
      </label>
    </div>
  );
}

function CollectorRow({ collector: c, onConfigChange }: {
  collector: CollectorInfo;
  onConfigChange: (id: string, config: CollectorConfig) => void;
}) {
  const [enabled, setEnabled] = useState(c.config.enabled !== false);
  const domain = collectorDomain(c);
  const unit = c.config.freshUnit ?? "sec";
  const freshMin = c.config.freshMinutes ?? 0.5;
  // Derive display value from stored minutes
  const displayValue = unit === "sec" ? Math.round(freshMin * 60) : freshMin;

  const handleValueChange = (raw: string) => {
    const n = parseFloat(raw) || 0;
    const minutes = unit === "sec" ? Math.max(0, n) / 60 : Math.max(0, n);
    onConfigChange(c.id, { ...c.config, freshMinutes: minutes, freshUnit: unit });
  };

  const handleUnitChange = (newUnit: "sec" | "min") => {
    // Keep the same display number, just reinterpret it in the new unit
    const minutes = newUnit === "sec" ? displayValue / 60 : displayValue;
    onConfigChange(c.id, { ...c.config, freshMinutes: Math.max(0, minutes), freshUnit: newUnit });
  };

  return (
    <TableRow>
      <TableCell>
        <span className="inline-flex items-center gap-2">
          {domain ? (
            <img
              src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
              width={16}
              height={16}
              alt=""
              className="rounded-sm shrink-0"
            />
          ) : (
            <span className="inline-flex items-center justify-center w-4 h-4 text-xs shrink-0">&#9986;</span>
          )}
          <code className="text-xs">{c.id}</code>
        </span>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {c.description || ""}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {c.urlPatterns.join(", ")}
      </TableCell>
      <TableCell>
        {c.id === "web_clip" && (
          <AutoDetectToggle collectorId={c.id} config={c.config} onConfigChange={onConfigChange} />
        )}
        {c.config.freshMinutes != null ? (
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">DOWN key skip tweets collected older than</span>
            <div className="inline-flex items-center rounded-md border border-border overflow-hidden h-8">
              <button
                type="button"
                onClick={() => {
                  const step = unit === "sec" ? 1 : 0.5;
                  handleValueChange(String(Math.max(0, displayValue - step)));
                }}
                className="px-2 h-full text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors border-r border-border"
              >
                −
              </button>
              <input
                type="text"
                inputMode="decimal"
                value={displayValue}
                onChange={(e) => handleValueChange(e.target.value)}
                className="w-12 h-full text-center text-xs bg-transparent text-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  const step = unit === "sec" ? 1 : 0.5;
                  handleValueChange(String(displayValue + step));
                }}
                className="px-2 h-full text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors border-l border-border"
              >
                +
              </button>
            </div>
            <div className="inline-flex rounded-md border border-border overflow-hidden h-8">
              <button
                type="button"
                onClick={() => handleUnitChange("sec")}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  unit === "sec"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-muted"
                }`}
              >
                sec
              </button>
              <button
                type="button"
                onClick={() => handleUnitChange("min")}
                className={`px-2.5 py-1 text-xs transition-colors border-l border-border ${
                  unit === "min"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-muted"
                }`}
              >
                min
              </button>
            </div>
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => {
            setEnabled(checked);
            onConfigChange(c.id, { ...c.config, enabled: checked });
          }}
          title={enabled ? "Collector enabled" : "Collector disabled"}
        />
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

function JobConfigCell({ job, onSave }: { job: JobInfo; onSave: () => void }) {
  const [endpoint, setEndpoint] = useState((job.config.endpoint as string) || "http://127.0.0.1:1234/v1/chat/completions");
  const [model, setModel] = useState((job.config.model as string) || "qwen3.5-4b");
  const defaultDownloadDir = job.id === "web_clip_markdown" ? "~/.latent_info/downloads/web_clips" : `~/.latent_info/downloads/${job.id}`;
  const [downloadDir, setDownloadDir] = useState((job.config.download_dir as string) || defaultDownloadDir);
  const [enableTex, setEnableTex] = useState(!!job.config.enable_tex);
  const [enableHfMarkdown, setEnableHfMarkdown] = useState(!!job.config.enable_hf_markdown);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveConfig = useCallback((updates: Record<string, unknown>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const config = { ...job.config, ...updates };
      fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })
        .then(() => onSave())
        .catch(() => {});
    }, 500);
  }, [job.id, job.config, onSave]);

  // x_tag: LLM config (endpoint, model, prompt)
  if (job.id === "x_tag") {
    return (
      <div className="flex flex-col gap-1.5 text-xs whitespace-nowrap">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap w-16">Endpoint</span>
          <input
            type="text"
            value={endpoint}
            placeholder="http://127.0.0.1:1234/v1/chat/completions"
            onChange={(e) => { setEndpoint(e.target.value); saveConfig({ endpoint: e.target.value }); }}
            className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap w-16">Model</span>
          <input
            type="text"
            value={model}
            placeholder="qwen3.5-4b"
            onChange={(e) => { setModel(e.target.value); saveConfig({ model: e.target.value }); }}
            className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
          />
        </label>
        {job.promptPath && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground whitespace-nowrap w-16">Prompt</span>
            <code className="text-[11px] text-muted-foreground truncate">{shortenPath(job.promptPath!)}</code>
            <button
              type="button"
              onClick={() => window.electronAPI?.showInFolder(job.promptPath!)}
              className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 p-1 rounded border border-border"
              title="Open in Finder"
            >
              <Icon icon="solar:square-arrow-right-up-bold" width={14} />
            </button>
          </div>
        )}
      </div>
    );
  }

  // arxiv_dl: download directory + tex toggle config
  if (job.id === "arxiv_dl") {
    return (
      <div className="flex flex-col gap-1.5 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap">Download Dir</span>
          <input
            type="text"
            value={downloadDir}
            placeholder="~/.latent_info/downloads/arxiv_dl"
            onChange={(e) => { setDownloadDir(e.target.value); saveConfig({ download_dir: e.target.value }); }}
            className="flex-1 min-w-0 bg-transparent border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
          />
          <button
            type="button"
            onClick={() => window.electronAPI?.openPath(downloadDir)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 p-1 rounded border border-border"
            title="Open in Finder"
          >
            <Icon icon="solar:square-arrow-right-up-bold" width={14} />
          </button>
          <button
            type="button"
            onClick={async () => {
              const dir = await window.electronAPI?.openDirectory(downloadDir || undefined);
              if (dir) { setDownloadDir(dir); saveConfig({ download_dir: dir }); }
            }}
            className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 p-1 rounded border border-border"
            title="Choose folder"
          >
            <Icon icon="solar:folder-open-bold" width={14} />
          </button>
        </div>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap">Download TeX</span>
          <Switch
            checked={enableTex}
            onCheckedChange={(checked) => { setEnableTex(checked); saveConfig({ enable_tex: checked }); }}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap">HuggingFace markdown</span>
          <Switch
            checked={enableHfMarkdown}
            onCheckedChange={(checked) => { setEnableHfMarkdown(checked); saveConfig({ enable_hf_markdown: checked }); }}
          />
        </label>
      </div>
    );
  }

  // web_clip_markdown: download directory config
  if (job.id === "web_clip_markdown") {
    return (
      <div className="flex flex-col gap-1.5 text-xs whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-nowrap w-20">Download Dir</span>
          <input
            type="text"
            value={downloadDir}
            placeholder={defaultDownloadDir}
            onChange={(e) => { setDownloadDir(e.target.value); saveConfig({ download_dir: e.target.value }); }}
            className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
          />
          <button
            type="button"
            onClick={() => window.electronAPI?.openPath(downloadDir)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 p-1 rounded border border-border"
            title="Open in Finder"
          >
            <Icon icon="solar:square-arrow-right-up-bold" width={14} />
          </button>
          <button
            type="button"
            onClick={async () => {
              const dir = await window.electronAPI?.openDirectory(downloadDir || undefined);
              if (dir) { setDownloadDir(dir); saveConfig({ download_dir: dir }); }
            }}
            className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0 p-1 rounded border border-border"
            title="Choose folder"
          >
            <Icon icon="solar:folder-open-bold" width={14} />
          </button>
        </div>
      </div>
    );
  }

  return <span className="text-xs text-muted-foreground">{"\u2014"}</span>;
}

function JobRow({ job, onRunComplete, cdpConnected }: { job: JobInfo; onRunComplete: () => void; cdpConnected: boolean }) {
  const [running, setRunning] = useState(false);
  const [eventEnabled, setEventEnabled] = useState(job.eventEnabled === true);
  // Re-sync when backend data changes (e.g. polling, SSE refresh)
  useEffect(() => { setEventEnabled(job.eventEnabled === true); }, [job.eventEnabled]);
  const [tweetModalOpen, setTweetModalOpen] = useState(false);
  const [tweetUrls, setTweetUrls] = useState("");
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [arxivModalOpen, setArxivModalOpen] = useState(false);
  const [arxivUrls, setArxivUrls] = useState("");
  const [arxivConfirmModalOpen, setArxivConfirmModalOpen] = useState(false);
  const [arxivMissingIds, setArxivMissingIds] = useState<string[]>([]);
  const [articleModalOpen, setArticleModalOpen] = useState(false);
  const [articleUrls, setArticleUrls] = useState("");

  // Clear running state when a new completed run arrives via SSE
  const lastRunRef = useRef(job.lastManualRun?.id);
  useEffect(() => {
    if (job.lastManualRun?.id !== lastRunRef.current) {
      lastRunRef.current = job.lastManualRun?.id;
      if (running && job.lastManualRun?.status !== "running") {
        setRunning(false);
      }
    }
  }, [job.lastManualRun?.id, job.lastManualRun?.status, running]);

  const handleRun = useCallback(() => {
    if (running) return;
    // x_tag: show modal instead of immediate run
    if (job.id === "x_tag") {
      if (!cdpConnected) {
        toast.error("No browser connected");
        return;
      }
      setTweetModalOpen(true);
      return;
    }
    // arxiv_dl: show modal for paper URL input
    if (job.id === "arxiv_dl") {
      setArxivModalOpen(true);
      return;
    }
    // web_clip_markdown: show modal for tweet IDs to process
    if (job.id === "web_clip_markdown") {
      if (!cdpConnected) {
        toast.error("No browser connected");
        return;
      }
      setArticleModalOpen(true);
      return;
    }
    setRunning(true);
    fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/run`, { method: "POST" })
      .catch(() => { setRunning(false); toast.error("Failed to start job"); });
  }, [job.id, running, cdpConnected]);

  const handleTweetConfirm = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/v1/x/check-tweets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: tweetUrls }),
      });
      const data = await res.json() as { found: string[]; missing: string[] };

      if (data.missing.length > 0) {
        // Some tweets not in DB — show collect confirmation
        setMissingIds(data.missing);
        setTweetModalOpen(false);
        setConfirmModalOpen(true);
      } else if (data.found.length > 0) {
        // All tweets in DB — run x_tag targeting them
        setTweetModalOpen(false);
        setRunning(true);
        toast.success(`Tagging ${data.found.length} tweets`);
        fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tweetIds: data.found }),
        })
          .catch(() => { setRunning(false); toast.error("Failed to start tagging job"); });
        setTweetUrls("");
      } else {
        toast.error("No valid tweet IDs found in input");
      }
    } catch {
      toast.error("Failed to check tweets");
    } finally {
      setChecking(false);
    }
  }, [tweetUrls, job.id, onRunComplete]);

  const handleOpenPages = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/x/open-tweets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tweetIds: missingIds }),
      });
      const data = await res.json() as { ok: boolean; opened: number; error?: string };
      if (data.ok) {
        toast.success(`Opened ${data.opened} tweet pages for collection`);
      } else {
        toast.error(data.error || "Failed to open pages");
      }
    } catch {
      toast.error("Failed to open pages");
    }
    setConfirmModalOpen(false);
    setMissingIds([]);
    setTweetUrls("");
  }, [missingIds]);

  // arxiv_dl: check papers and either run or prompt to collect
  const handleArxivConfirm = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/v1/arxiv/check-papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: arxivUrls }),
      });
      const data = await res.json() as { found: string[]; missing: string[] };

      if (data.missing.length > 0) {
        setArxivMissingIds(data.missing);
        setArxivModalOpen(false);
        setArxivConfirmModalOpen(true);
      } else if (data.found.length > 0) {
        setArxivModalOpen(false);
        setRunning(true);
        toast.success(`Downloading ${data.found.length} paper${data.found.length > 1 ? "s" : ""}`);
        fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ arxiv_ids: data.found }),
        })
          .catch(() => setRunning(false));
        setArxivUrls("");
      } else {
        toast.error("No valid arxiv IDs found in input");
      }
    } catch {
      toast.error("Failed to check papers");
    } finally {
      setChecking(false);
    }
  }, [arxivUrls, job.id]);

  const handleArxivOpenPages = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/arxiv/open-papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arxivIds: arxivMissingIds }),
      });
      const data = await res.json() as { ok: boolean; opened: number; error?: string };
      if (data.ok) {
        toast.success(`Opened ${data.opened} arxiv page${data.opened > 1 ? "s" : ""} for collection`);
      } else {
        toast.error(data.error || "Failed to open pages");
      }
    } catch {
      toast.error("Failed to open pages");
    }
    setArxivConfirmModalOpen(false);
    setArxivMissingIds([]);
    setArxivUrls("");
  }, [arxivMissingIds]);

  // web_clip_markdown: process articles for given tweet IDs or doc IDs
  const handleArticleConfirm = useCallback(async () => {
    // Parse lines, strip quotes and whitespace
    const lines = articleUrls
      .split(/[\n,]+/)
      .map((l) => l.trim().replace(/^["']+|["']+$/g, ""))
      .filter(Boolean);

    // Separate direct IDs (e.g. "x:123456", "x_article:abc123") from URLs/bare tweet IDs
    const directDocIds: string[] = [];
    const urlLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("x:") || line.startsWith("x_article:")) {
        directDocIds.push(line);
      } else {
        urlLines.push(line);
      }
    }

    setChecking(true);
    try {
      let resolvedDocIds = [...directDocIds];

      // Resolve URLs/bare tweet IDs via check-tweets API
      if (urlLines.length > 0) {
        const res = await fetch("/api/v1/x/check-tweets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: urlLines.join("\n") }),
        });
        const data = await res.json() as { found: string[]; missing: string[] };
        resolvedDocIds.push(...data.found.map((id: string) => `x:${id}`));

        if (data.missing.length > 0 && resolvedDocIds.length === 0) {
          toast.error(`${data.missing.length} tweet${data.missing.length > 1 ? "s" : ""} not collected yet. Visit the tweet pages first.`);
          return;
        }
      }

      if (resolvedDocIds.length > 0) {
        setArticleModalOpen(false);
        setRunning(true);
        toast.success(`Processing ${resolvedDocIds.length} article${resolvedDocIds.length > 1 ? "s" : ""}`);
        fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docIds: resolvedDocIds }),
        })
          .catch(() => setRunning(false));
        setArticleUrls("");
      } else {
        toast.error("No valid tweet IDs found in input");
      }
    } catch {
      toast.error("Failed to check tweets");
    } finally {
      setChecking(false);
    }
  }, [articleUrls, job.id]);

  // Format triggers
  const triggerParts: string[] = [];
  if (job.triggers.schedule && job.triggers.schedule.length > 0) {
    for (const ms of job.triggers.schedule) {
      const min = Math.round(ms / 60000);
      triggerParts.push(min >= 60 ? `Every ${min / 60}h` : `Every ${min}m`);
    }
  }
  if (job.triggers.events && job.triggers.events.length > 0) {
    for (const e of job.triggers.events) {
      triggerParts.push(`Event ${e}`);
    }
  }

  // Status badge
  const status = job.lastRun?.status;
  const statusColor = status === "success" ? "text-green-500" : status === "error" ? "text-red-400" : status === "running" ? "text-yellow-500" : "text-muted-foreground";
  const statusDotColor = status === "success" ? "bg-green-500" : status === "error" ? "bg-red-400" : status === "running" ? "bg-yellow-500" : "bg-muted-foreground";

  return (
    <TableRow>
      <TableCell>
        <a href={`/jobs?job=${encodeURIComponent(job.id)}`} className="text-sm font-medium text-primary hover:underline">
          {job.id}
        </a>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {job.description || "\u2014"}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {triggerParts.length > 0 ? (
          <div className="flex items-center gap-2">
            <Switch
              checked={eventEnabled}
              onCheckedChange={(checked) => {
                setEventEnabled(checked);
                const config = { ...job.config, event_enabled: checked };
                fetch(`/api/v1/jobs/${encodeURIComponent(job.id)}/config`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(config),
                })
                  .then(() => onRunComplete())
                  .catch(() => {});
              }}
              title={eventEnabled ? "Event trigger enabled" : "Event trigger disabled"}
            />
            <span>
              {triggerParts.map((part, i) => {
                const eventMatch = part.match(/^Event (.+)$/)
                if (eventMatch) {
                  return (
                    <span key={i}>
                      {i > 0 && ", "}
                      <span className="text-primary font-medium">Event</span> {eventMatch[1]}
                    </span>
                  )
                }
                return <span key={i}>{i > 0 && ", "}{part}</span>
              })}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">{"\u2014"}</span>
        )}
      </TableCell>
      <TableCell>
        <JobConfigCell job={job} onSave={onRunComplete} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <Button size="sm" className="h-6 px-2 text-xs w-fit" onClick={handleRun} disabled={running}>
            <Icon icon="solar:play-bold" className="h-3 w-3 mr-1" />
            {running ? "Running..." : "Manual Run"}
          </Button>
          {job.lastManualRun ? (
            <a
              href={`/jobs?runId=${encodeURIComponent(job.lastManualRun.id)}`}
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded hover:bg-muted transition-colors whitespace-nowrap"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                job.lastManualRun.status === "success" ? "bg-green-500"
                  : job.lastManualRun.status === "error" ? "bg-red-400"
                  : job.lastManualRun.status === "running" ? "bg-yellow-500"
                  : "bg-muted-foreground"
              }`} />
              <span className={
                job.lastManualRun.status === "success" ? "text-green-500"
                  : job.lastManualRun.status === "error" ? "text-red-400"
                  : job.lastManualRun.status === "running" ? "text-yellow-500"
                  : "text-muted-foreground"
              }>{job.lastManualRun.status}</span>
              <code className="text-muted-foreground font-mono text-[10px]">{job.lastManualRun.id.slice(0, 12)}</code>
              <span className="text-muted-foreground">
                {new Date(job.lastManualRun.startedAt).toLocaleTimeString()}
              </span>
            </a>
          ) : (
            <span className="text-[11px] text-muted-foreground">No manual runs</span>
          )}
        </div>
      </TableCell>

      {/* Tweet URL input modal (x_tag only) */}
      {job.id === "x_tag" && (
        <>
          <Dialog open={tweetModalOpen} onOpenChange={(open) => { setTweetModalOpen(open); if (!open) setTweetUrls(""); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Provide tweet URLs</DialogTitle>
                <DialogDescription>
                  Enter tweet URLs or IDs to process. One per line.
                </DialogDescription>
              </DialogHeader>
              <Textarea
                value={tweetUrls}
                onChange={(e) => setTweetUrls(e.target.value)}
                placeholder={"https://x.com/user/status/1234567890\nhttps://twitter.com/user/status/9876543210\n1234567890"}
                rows={6}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => { setTweetModalOpen(false); setTweetUrls(""); }}>
                  Cancel
                </Button>
                <Button onClick={handleTweetConfirm} disabled={!tweetUrls.trim() || checking}>
                  {checking ? "Checking..." : "Confirm"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={confirmModalOpen} onOpenChange={(open) => { setConfirmModalOpen(open); if (!open) { setMissingIds([]); setTweetUrls(""); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Collect tweets first</DialogTitle>
                <DialogDescription>
                  {missingIds.length} tweet{missingIds.length > 1 ? "s are" : " is"} not yet collected.
                  This will open web pages to collect info for those tweets.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setConfirmModalOpen(false); setMissingIds([]); setTweetUrls(""); }}>
                  Cancel
                </Button>
                <Button onClick={handleOpenPages}>
                  Open pages
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Arxiv paper input modal (arxiv_dl only) */}
      {job.id === "arxiv_dl" && (
        <>
          <Dialog open={arxivModalOpen} onOpenChange={(open) => { setArxivModalOpen(open); if (!open) setArxivUrls(""); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Download arxiv papers</DialogTitle>
                <DialogDescription>
                  Enter arxiv paper URLs or IDs to download. One per line.
                </DialogDescription>
              </DialogHeader>
              <Textarea
                value={arxivUrls}
                onChange={(e) => setArxivUrls(e.target.value)}
                placeholder={"https://arxiv.org/abs/2301.07041\n2302.12345\nhttps://arxiv.org/pdf/2303.00001v2"}
                rows={6}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => { setArxivModalOpen(false); setArxivUrls(""); }}>
                  Cancel
                </Button>
                <Button onClick={handleArxivConfirm} disabled={!arxivUrls.trim() || checking}>
                  {checking ? "Checking..." : "Confirm"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={arxivConfirmModalOpen} onOpenChange={(open) => { setArxivConfirmModalOpen(open); if (!open) { setArxivMissingIds([]); setArxivUrls(""); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Collect papers first</DialogTitle>
                <DialogDescription>
                  {arxivMissingIds.length} paper{arxivMissingIds.length > 1 ? "s are" : " is"} not yet collected.
                  This will open arxiv pages to collect metadata for those papers.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setArxivConfirmModalOpen(false); setArxivMissingIds([]); setArxivUrls(""); }}>
                  Cancel
                </Button>
                <Button onClick={handleArxivOpenPages}>
                  Open pages
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* Article processing modal (web_clip_markdown only) */}
      {job.id === "web_clip_markdown" && (
        <Dialog open={articleModalOpen} onOpenChange={(open) => { setArticleModalOpen(open); if (!open) setArticleUrls(""); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Process web clips</DialogTitle>
              <DialogDescription>
                Enter tweet URLs or IDs to process. One per line.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={articleUrls}
              onChange={(e) => setArticleUrls(e.target.value)}
              placeholder={"https://x.com/user/status/1234567890\nx:1234567890\nx_article:b0ecfc8c50b9\n1234567890"}
              rows={6}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => { setArticleModalOpen(false); setArticleUrls(""); }}>
                Cancel
              </Button>
              <Button onClick={handleArticleConfirm} disabled={!articleUrls.trim() || checking}>
                {checking ? "Checking..." : "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </TableRow>
  );
}


// ---------------------------------------------------------------------------
// Settings sub-view
// ---------------------------------------------------------------------------

function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(_settingsCache.settings);

  useEffect(() => {
    fetch("/api/v1/settings")
      .then((r) => {
        if (!r.ok) throw new Error(`Settings API returned ${r.status}`);
        return r.json();
      })
      .then((data: AppSettings) => {
        const s = { ...data, browsers: data.browsers ?? [] };
        setSettings(s);
        _settingsCache.settings = s;
      })
      .catch(() => {});
  }, []);

  const updateSettings = useCallback(
    (update: Partial<AppSettings>) => {
      if (!settings) return;
      const merged = { ...settings, ...update };
      setSettings(merged);
      _settingsCache.settings = merged;
      fetch("/api/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      }).catch(() => {});
    },
    [settings],
  );

  if (!settings) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <>
      {/* Browser */}
      <h2 className="text-lg font-semibold text-foreground mb-3">Browser</h2>
      <div className="border border-border rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">
              Auto Attach
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Automatically connect to detected browser sessions on startup
            </div>
          </div>
          <Switch
            checked={settings.autoAttach ?? false}
            onCheckedChange={(enabled) =>
              updateSettings({ autoAttach: enabled })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">
              Remote Debugging Auto Allow
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Automatically dismiss browser remote debugging prompts
            </div>
          </div>
          <Switch
            checked={settings.remoteDebuggingAutoAllow ?? false}
            onCheckedChange={(enabled) =>
              updateSettings({ remoteDebuggingAutoAllow: enabled })
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-yellow-400">
            <Icon icon="solar:danger-circle-bold" className="shrink-0 text-sm" />
            <span className="text-xs leading-relaxed">
              This feature requires macOS Accessibility permission. Grant access to this app (or the terminal running it) in System Settings &gt; Privacy &amp; Security &gt; Accessibility.
            </span>
          </div>
          <Button
            size="sm"
            className="shrink-0 h-6 px-2 text-xs"
            onClick={() =>
              fetch("/api/v1/open-accessibility-settings", { method: "POST" }).catch(() => {})
            }
          >
            <Icon icon="solar:square-arrow-right-up-bold" className="h-4 w-4 mr-1" />
            Open Accessibility Settings
          </Button>
        </div>
      </div>

      {/* Development */}
      <h2 className="text-lg font-semibold text-foreground mb-3 mt-8">Development</h2>
      <div className="border border-border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">Log Level</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Controls backend logging verbosity. Changes apply on next backend restart.
            </div>
          </div>
          <Select
            value={settings.logLevel ?? "warn"}
            onValueChange={(level) => updateSettings({ logLevel: level })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page — Tabs for Overview and Settings
// ---------------------------------------------------------------------------

export function DashboardPage() {
  return (
    <div className="relative p-6 max-w-7xl mx-auto">
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
          <OverviewView />
        </TabsContent>
        <TabsContent value="settings" forceMount className="data-[state=inactive]:hidden">
          <SettingsView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
