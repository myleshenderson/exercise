import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DAY_MS } from "../../metrics/dates";
import type { AthleteSettings, FtpHistoryEntry, FtpSource, SyncSource, SyncState } from "../../types";
import { useAthleteSettings } from "../hooks";
import { useRideDb } from "../RideDb";
import { eftpOf } from "../settings/ftp";
import { defaultSyncClient, type RecomputeResult, type SyncClient, type SyncRunResult } from "../settings/syncClient";
import { Card } from "../stats/Card";
import { useLoad } from "../stats/useLoad";

const SOURCE_LABELS: Record<SyncSource | "strava_export", string> = {
  garmin_activities: "Garmin activities",
  garmin_weight: "Garmin weight",
  peloton: "Peloton",
  strava_export: "Strava export",
};

const FTP_SOURCE_LABELS: Record<FtpSource, string> = {
  manual: "Manual",
  peloton_test: "Peloton test",
  peloton_manual: "Peloton manual",
  estimated: "Estimated",
};

const RECONNECT =
  "Peloton needs reconnecting: paste new Auth0 tokens into the Vercel env (see docs/ride-sync.md)";

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** "just now" / "12 min ago" / "3 h ago" / "2 days ago". */
function relative(iso: string, nowMs: number): string {
  const s = Math.round((nowMs - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function absolute(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

// ---------------------------------------------------------------------------
// Form

type NumericField = "manualFtpW" | "lthrBpm" | "maxHrBpm" | "strengthSessionTss" | "noPowerTssPerHour";

interface FormState {
  manualFtpW: string;
  lthrBpm: string;
  maxHrBpm: string;
  strengthSessionTss: string;
  noPowerTssPerHour: string;
  units: AthleteSettings["units"];
  weekStart: AthleteSettings["weekStart"];
}

/** Empty is allowed (null) for these; the TSS defaults must hold a value. */
const NULLABLE: Record<NumericField, boolean> = {
  manualFtpW: true,
  lthrBpm: true,
  maxHrBpm: true,
  strengthSessionTss: false,
  noPowerTssPerHour: false,
};

/** Fields whose change alters stored TSS and so the daily load. */
const RECOMPUTE_FIELDS: readonly (keyof AthleteSettings)[] = ["manualFtpW", "lthrBpm", "strengthSessionTss", "noPowerTssPerHour"];

function formOf(s: AthleteSettings): FormState {
  const str = (v: number | null) => (v === null ? "" : String(v));
  return {
    manualFtpW: str(s.manualFtpW),
    lthrBpm: str(s.lthrBpm),
    maxHrBpm: str(s.maxHrBpm),
    strengthSessionTss: str(s.strengthSessionTss),
    noPowerTssPerHour: str(s.noPowerTssPerHour),
    units: s.units,
    weekStart: s.weekStart,
  };
}

type Parsed = { ok: true; value: number | null } | { ok: false; error: string };

function parseField(text: string, nullable: boolean): Parsed {
  const t = text.trim();
  if (t === "") return nullable ? { ok: true, value: null } : { ok: false, error: "Required" };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Must be a positive number" };
  return { ok: true, value: n };
}

/** The patch of changed fields, or the per-field errors. */
function diff(form: FormState, current: AthleteSettings): { patch: Partial<AthleteSettings>; errors: Partial<Record<NumericField, string>> } {
  const patch: Partial<AthleteSettings> = {};
  const errors: Partial<Record<NumericField, string>> = {};
  for (const f of Object.keys(NULLABLE) as NumericField[]) {
    const p = parseField(form[f], NULLABLE[f]);
    if (!p.ok) errors[f] = p.error;
    else if (p.value !== current[f]) (patch as Record<string, number | null>)[f] = p.value;
  }
  if (form.units !== current.units) patch.units = form.units;
  if (form.weekStart !== current.weekStart) patch.weekStart = form.weekStart;
  return { patch, errors };
}

// ---------------------------------------------------------------------------
// Screen

type Run<T> = { status: "idle" } | { status: "running" } | { status: "done"; value: T } | { status: "error"; message: string; results?: SyncRunResult[] | null };

function errorOf(e: unknown): { message: string; results: SyncRunResult[] | null } {
  const message = e instanceof Error ? e.message : String(e);
  const results = (e as { results?: unknown } | null)?.results;
  return { message, results: Array.isArray(results) ? (results as SyncRunResult[]) : null };
}

/**
 * Settings (AI-652): the inputs every TSS depends on, the FTP history, sync status and Sync now.
 * `syncClient` overrides the build's client (`null` = none, as on Starkeep).
 */
export default function Settings({ now, syncClient }: { now?: Date; syncClient?: SyncClient | null }) {
  const db = useRideDb();
  const client = useMemo(() => (syncClient === undefined ? defaultSyncClient(db) : syncClient), [db, syncClient]);
  const { settings, loaded, error: settingsError, save } = useAthleteSettings();
  const [fallbackNow] = useState(() => Date.now());
  const nowMs = now?.getTime() ?? fallbackNow;

  // FTP history and sync state reload after a save or a sync: bumping the key makes a new loader.
  const [historyKey, setHistoryKey] = useState(0);
  const [syncKey, setSyncKey] = useState(0);
  // A sync can import a Peloton FTP test, so syncKey reloads the history too.
  const loadHistory = useCallback(() => {
    return db.listFtpHistory();
  }, [db, historyKey, syncKey]);
  const loadSync = useCallback(() => {
    return db.listSyncState();
  }, [db, syncKey]);
  const loadEftp = useCallback(async () => {
    // A sync brings in rides, so syncKey reloads the eFTP hint too.
    const rides = await db.listExternalActivities({ from: new Date(nowMs - 92 * DAY_MS).toISOString(), to: new Date(nowMs).toISOString() });
    return eftpOf(rides, new Date(nowMs));
  }, [db, nowMs, syncKey]);
  const history = useLoad(loadHistory);
  const sync = useLoad(loadSync);
  const eftpState = useLoad(loadEftp);
  const eftpW = eftpState.status === "ready" ? eftpState.data : null;

  // A sync card keeps showing its last rows while reloading, so the page does not jump.
  const [syncRows, setSyncRows] = useState<SyncState[] | null>(null);
  useEffect(() => {
    if (sync.status === "ready") setSyncRows(sync.data);
  }, [sync]);
  const [historyRows, setHistoryRows] = useState<FtpHistoryEntry[] | null>(null);
  useEffect(() => {
    if (history.status === "ready") setHistoryRows(history.data);
  }, [history]);

  // Sync and recompute are owner-only on the server; the owner's sync_state rows exist after the
  // first backfill and another account sees none under RLS, so rows mark the owner (AI-669).
  // Until the read answers (or if it fails) the controls stay hidden.
  const owner = syncRows !== null && syncRows.length > 0;

  // Ready once every read has answered, an error included, so the error state can be captured too.
  const ready =
    loaded && (historyRows !== null || history.status === "error") && (syncRows !== null || sync.status === "error") && eftpState.status !== "loading";

  return (
    <div className="space-y-4 p-4" data-ready={ready ? "settings" : undefined}>
      <h1 className="text-2xl font-bold">Settings</h1>
      {settingsError && <p className="text-sm text-red-700">Couldn't load your settings: {settingsError.message}</p>}
      {loaded ? (
        <SettingsForm
          settings={settings}
          eftpW={eftpW}
          client={client}
          owner={owner}
          save={save}
          addFtp={async (ftpW) => {
            await db.addFtpHistoryEntry({ effectiveFrom: new Date(now?.getTime() ?? Date.now()).toISOString(), ftpW, source: "manual", sourceRef: null });
            setHistoryKey((k) => k + 1);
          }}
        />
      ) : (
        <p className="text-sm text-gray-500">Loading…</p>
      )}
      <Card title="FTP history">
        {history.status === "error" && <p className="text-sm text-red-700">Couldn't load the FTP history: {history.message}</p>}
        {historyRows !== null && <FtpHistory rows={historyRows} />}
      </Card>
      <SyncSection
        rows={syncRows}
        loadError={sync.status === "error" ? sync.message : null}
        nowMs={nowMs}
        client={client}
        owner={owner}
        onSynced={() => setSyncKey((k) => k + 1)}
      />
    </div>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-gray-700">{label}</span>
      <div className="mt-1">{children}</div>
      {error ? <span className="text-xs text-red-700">{error}</span> : hint ? <span className="text-xs text-gray-500">{hint}</span> : null}
    </label>
  );
}

function SettingsForm({
  settings,
  eftpW,
  client,
  owner,
  save,
  addFtp,
}: {
  settings: AthleteSettings;
  eftpW: number | null;
  client: SyncClient | null;
  /** The account owns the sync (has sync_state rows); only then does a save recompute. */
  owner: boolean;
  save(patch: Partial<AthleteSettings>): Promise<AthleteSettings>;
  addFtp(ftpW: number): Promise<void>;
}) {
  // Mounted once the settings have loaded; after a save the form takes the stored row. It does not
  // follow later re-reads, so a refresh landing mid-edit never wipes what the user is typing.
  const [form, setForm] = useState<FormState>(() => formOf(settings));
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ kind: "saved" } | { kind: "failed" | "historyFailed"; message: string } | null>(null);
  const [recompute, setRecompute] = useState<Run<RecomputeResult> | { status: "manual" }>({ status: "idle" });

  const { patch, errors } = diff(form, settings);
  const invalid = Object.keys(errors).length > 0;
  const changed = Object.keys(patch).length > 0;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaveState(null);
  };

  const recomputing = recompute.status === "running";
  const needsRecompute = RECOMPUTE_FIELDS.some((f) => f in patch);

  const onSave = async () => {
    if (invalid || !changed || saving || recomputing) return;
    setSaving(true);
    setSaveState(null);
    try {
      const stored = await save(patch);
      setForm(formOf(stored));
    } catch (e) {
      setSaveState({ kind: "failed", message: errorOf(e).message });
      setSaving(false);
      return;
    }
    // The settings are stored: a failed history insert is reported but does not stop the recompute.
    let historyError: string | null = null;
    if (typeof patch.manualFtpW === "number") {
      try {
        await addFtp(patch.manualFtpW);
      } catch (e) {
        historyError = errorOf(e).message;
      }
    }
    setSaveState(historyError === null ? { kind: "saved" } : { kind: "historyFailed", message: historyError });
    setSaving(false);
    if (!needsRecompute) return;
    if (!client) {
      setRecompute({ status: "manual" });
      return;
    }
    // Another account: the server refuses the recompute, so none is attempted.
    if (!owner) return;
    setRecompute({ status: "running" });
    try {
      setRecompute({ status: "done", value: await client.recompute() });
    } catch (e) {
      setRecompute({ status: "error", message: errorOf(e).message });
    }
  };

  const numeric = (f: NumericField, label: string, unit: string, hint?: ReactNode) => (
    <Field label={label} error={errors[f]} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          aria-label={label}
          inputMode="decimal"
          value={form[f]}
          onChange={(e) => set(f, e.target.value)}
          aria-invalid={errors[f] ? true : undefined}
          className={`w-28 rounded-md border px-2 py-1 tabular-nums ${errors[f] ? "border-red-500" : ""}`}
        />
        <span className="text-xs text-gray-500">{unit}</span>
      </div>
    </Field>
  );

  return (
    <Card title="Training inputs">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        {numeric(
          "manualFtpW",
          "Manual FTP",
          "W",
          eftpW === null ? "Empty = use eFTP (no eFTP yet: no 20-minute power in 90 days)" : `Empty = use eFTP (currently ${Math.round(eftpW)} W)`,
        )}
        {numeric("lthrBpm", "Threshold HR", "bpm")}
        {numeric("maxHrBpm", "Max HR", "bpm")}
        {numeric("strengthSessionTss", "Strength session TSS", "TSS", "Default 50")}
        {numeric("noPowerTssPerHour", "No-power TSS per hour", "TSS/h", "Default 55. Rides without power or heart rate get an estimated TSS at this rate. They show an est. chip.")}
        <Field label="Units">
          <select aria-label="Units" value={form.units} onChange={(e) => set("units", e.target.value as FormState["units"])} className="rounded-md border px-2 py-1">
            <option value="imperial">Imperial</option>
            <option value="metric">Metric</option>
          </select>
        </Field>
        <Field label="Week start">
          <select
            aria-label="Week start"
            value={form.weekStart}
            onChange={(e) => set("weekStart", e.target.value as FormState["weekStart"])}
            className="rounded-md border px-2 py-1"
          >
            <option value="monday">Monday</option>
            <option value="sunday">Sunday</option>
          </select>
        </Field>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={invalid || !changed || saving || recomputing} className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            {saving ? "Saving…" : "Save"}
          </button>
          {saveState?.kind === "saved" && <span className="text-sm text-green-700">Saved</span>}
          {saveState?.kind === "failed" && <span className="text-sm text-red-700">Couldn't save: {saveState.message}</span>}
          {saveState?.kind === "historyFailed" && (
            <span className="text-sm text-red-700">Saved, but couldn't add the FTP history row: {saveState.message}</span>
          )}
        </div>
        <div role="status" className="text-sm">
          {recompute.status === "running" && <span className="text-gray-600">Recomputing…</span>}
          {recompute.status === "done" && (
            <span className="text-green-700">
              Recomputed {plural(recompute.value.activities, "ride")}, {plural(recompute.value.days, "day")}
            </span>
          )}
          {recompute.status === "error" && <span className="text-red-700">{recompute.message}</span>}
          {recompute.status === "manual" && (
            <span className="text-gray-600">Stored TSS updates when a recompute runs on the Vercel deployment.</span>
          )}
        </div>
      </form>
    </Card>
  );
}

function FtpHistory({ rows }: { rows: FtpHistoryEntry[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">No FTP history yet.</p>;
  const sorted = [...rows].sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));
  return (
    <table className="w-full text-sm" aria-label="FTP history">
      <tbody>
        {sorted.map((r) => (
          <tr key={r.id} data-ftp={r.id} className="border-t first:border-t-0 tabular-nums">
            <td className="py-1">{new Date(r.effectiveFrom).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
            <td className="py-1 text-right font-medium">{Math.round(r.ftpW)} W</td>
            <td className="py-1 text-right text-gray-600">{FTP_SOURCE_LABELS[r.source] ?? r.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Sync

function SyncSection({
  rows,
  loadError,
  nowMs,
  client,
  owner,
  onSynced,
}: {
  rows: SyncState[] | null;
  loadError: string | null;
  nowMs: number;
  client: SyncClient | null;
  /** Sync now shows only for the owner account (it has sync_state rows). */
  owner: boolean;
  onSynced(): void;
}) {
  const [run, setRun] = useState<Run<SyncRunResult[]>>({ status: "idle" });

  const syncNow = async () => {
    if (!client) return;
    setRun({ status: "running" });
    try {
      setRun({ status: "done", value: await client.sync() });
    } catch (e) {
      const { message, results } = errorOf(e);
      setRun({ status: "error", message, results });
    } finally {
      onSynced();
    }
  };

  const results = run.status === "done" ? run.value : run.status === "error" ? (run.results ?? []) : [];

  return (
    <Card
      title="Sync"
      action={
        client &&
        owner && (
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={run.status === "running"}
            className="rounded-md border px-3 py-1 text-sm font-medium disabled:opacity-40"
          >
            {run.status === "running" ? "Syncing…" : "Sync now"}
          </button>
        )
      }
    >
      {!client && <p className="mb-2 text-sm text-gray-600">Sync runs on the Vercel deployment only</p>}
      {(run.status === "done" || run.status === "error") && (
        <div className="mb-3 space-y-1 text-sm" data-testid="sync-result">
          {run.status === "error" && <p className="text-red-700">{run.message}</p>}
          {results.map((r) => (
            <p key={r.source} data-result={r.source} className={r.error ? "text-red-700" : "text-gray-700"}>
              {SOURCE_LABELS[r.source] ?? r.source}: {r.error ?? `${count(r.fetched)} fetched, ${count(r.upserted)} upserted`}
            </p>
          ))}
        </div>
      )}
      {loadError && <p className="text-sm text-red-700">Couldn't load the sync status: {loadError}</p>}
      {rows !== null && rows.length === 0 && <p className="text-sm text-gray-500">No sync has run yet</p>}
      {rows !== null && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r) => (
            <SyncCard key={r.source} row={r} nowMs={nowMs} />
          ))}
        </div>
      )}
    </Card>
  );
}

function When({ iso, nowMs }: { iso: string | null; nowMs: number }) {
  if (iso === null) return <>never</>;
  return (
    <>
      {relative(iso, nowMs)} <span className="text-gray-500">({absolute(iso)})</span>
    </>
  );
}

function SyncCard({ row, nowMs }: { row: SyncState; nowMs: number }) {
  return (
    <section aria-label={SOURCE_LABELS[row.source] ?? row.source} data-sync={row.source} className="rounded-lg border p-2 text-sm">
      <h3 className="font-medium">{SOURCE_LABELS[row.source] ?? row.source}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-gray-700">
        <dt className="text-gray-500">Last run</dt>
        <dd>
          <When iso={row.lastRunAt} nowMs={nowMs} />
        </dd>
        <dt className="text-gray-500">Last success</dt>
        <dd>
          <When iso={row.lastSuccessAt} nowMs={nowMs} />
        </dd>
        <dt className="text-gray-500">Items</dt>
        <dd>
          {count(row.itemsFetched)} fetched, {count(row.itemsUpserted)} upserted
        </dd>
        <dt className="text-gray-500">Backfill</dt>
        <dd>{row.backfillComplete ? "Complete" : "In progress"}</dd>
      </dl>
      {row.lastError && <p className="mt-1 text-xs text-red-700">{row.lastError}</p>}
      {row.authStatus === "reconnect_required" && <p className="mt-1 text-xs font-medium text-red-700">{RECONNECT}</p>}
    </section>
  );
}
