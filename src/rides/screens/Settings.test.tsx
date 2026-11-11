import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DataLayer } from "../../data/DataLayer";
import { createMockDataLayer } from "../../data/mock";
import { RideDbProvider } from "../RideDb";
import { createFetchSyncClient, type SyncClient } from "../settings/syncClient";
import { buildRideFixtures, createRideFixtureDb } from "../testing/fixtures";
import Settings from "./Settings";

vi.mock("../../auth/supabase", () => ({
  loadSupabase: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "session-token" } } }) } }),
}));

const NOW = new Date("2026-11-11T17:00:00.000Z");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SYNC_OK = {
  kind: "sync",
  results: [
    { source: "garmin_activities", fetched: 3, upserted: 2, skipped: 1, done: true, earliestAffected: null, error: null },
    { source: "peloton", fetched: 0, upserted: 0, skipped: 0, done: false, earliestAffected: null, error: "Peloton refresh token was rejected" },
  ],
};

function fetchClient(fetch: ReturnType<typeof vi.fn>): SyncClient {
  return createFetchSyncClient({ fetch: fetch as unknown as typeof globalThis.fetch, getAccessToken: async () => "tok" });
}

function renderSettings(db: DataLayer, syncClient?: SyncClient | null) {
  return render(
    <RideDbProvider db={db}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Settings now={NOW} syncClient={syncClient} />
      </MemoryRouter>
    </RideDbProvider>,
  );
}

async function ready() {
  await waitFor(() => expect(document.querySelector('[data-ready="settings"]')).not.toBeNull());
}

const input = (name: string) => screen.getByLabelText(name, { selector: "input,select" }) as HTMLInputElement;
const change = (name: string, value: string) => fireEvent.change(input(name), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("the form shows the stored settings and the current eFTP as a hint", async () => {
  renderSettings(createRideFixtureDb(NOW), null);
  await ready();
  expect(input("Manual FTP")).toHaveValue("250");
  expect(input("Threshold HR")).toHaveValue("168");
  expect(input("Max HR")).toHaveValue("186");
  expect(input("Strength session TSS")).toHaveValue("50");
  expect(input("No-power TSS per hour")).toHaveValue("55");
  expect(input("Units")).toHaveValue("imperial");
  expect(input("Week start")).toHaveValue("monday");
  expect(screen.getByText(/Empty = use eFTP \(currently \d+ W\)/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing changed
});

test("non-positive and empty required values are rejected inline", async () => {
  renderSettings(createRideFixtureDb(NOW), null);
  await ready();
  change("Threshold HR", "0");
  expect(screen.getByText("Must be a positive number")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  change("Threshold HR", "170");
  change("Strength session TSS", "");
  expect(screen.getByText("Required")).toBeInTheDocument();
  change("Strength session TSS", "-5");
  expect(screen.getByText("Must be a positive number")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("a new manual FTP saves only that field, adds a Manual history row and recomputes over passes", async () => {
  const db = createRideFixtureDb(NOW);
  const saveSpy = vi.spyOn(db, "saveAthleteSettings");
  const addSpy = vi.spyOn(db, "addFtpHistoryEntry");
  let finish!: (r: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(200, { kind: "recompute", activities: 500, days: 0, done: false, nextOffset: 500 }))
    .mockReturnValueOnce(new Promise<Response>((r) => (finish = r)));
  renderSettings(db, fetchClient(fetch));
  await ready();

  change("Manual FTP", "262");
  save();
  await screen.findByText("Recomputing…");
  expect(saveSpy).toHaveBeenCalledTimes(1);
  expect(saveSpy).toHaveBeenCalledWith({ manualFtpW: 262 });
  expect(addSpy).toHaveBeenCalledWith({ effectiveFrom: NOW.toISOString(), ftpW: 262, source: "manual", sourceRef: null });

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/api/sync?recompute=all", "/api/sync?recompute=all&offset=500"]);
  expect(fetch.mock.calls[0][1]).toEqual({ method: "POST", headers: { Authorization: "Bearer tok" } });
  await act(async () => finish(json(200, { kind: "recompute", activities: 412, days: 1204, done: true, nextOffset: null })));
  await screen.findByText("Recomputed 912 rides, 1,204 days");

  // History: newest first, the new row on top.
  await waitFor(() => {
    const rows = within(screen.getByRole("table", { name: "FTP history" })).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("262 W");
    expect(rows[0]).toHaveTextContent("Manual");
  });
  const rows = within(screen.getByRole("table", { name: "FTP history" })).getAllByRole("row");
  expect(rows.map((r) => r.textContent)).toEqual([
    expect.stringMatching(/262 WManual$/),
    expect.stringMatching(/250 WManual$/),
    expect.stringMatching(/244 WPeloton test$/),
    expect.stringMatching(/232 WPeloton test$/),
  ]);
});

test("a recompute error is shown verbatim", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(403, { error: "Sync is limited to the owner account" }));
  renderSettings(createRideFixtureDb(NOW), fetchClient(fetch));
  await ready();
  change("Threshold HR", "170");
  save();
  await screen.findByText("Sync is limited to the owner account");
});

test("units and week start alone save without a recompute or a history row", async () => {
  const db = createRideFixtureDb(NOW);
  const saveSpy = vi.spyOn(db, "saveAthleteSettings");
  const addSpy = vi.spyOn(db, "addFtpHistoryEntry");
  const fetch = vi.fn();
  renderSettings(db, fetchClient(fetch));
  await ready();
  change("Units", "metric");
  change("Week start", "sunday");
  save();
  await screen.findByText("Saved");
  expect(saveSpy).toHaveBeenCalledWith({ units: "metric", weekStart: "sunday" });
  expect(addSpy).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByText("Recomputing…")).toBeNull();
});

test("clearing the manual FTP saves null and adds no history row", async () => {
  const db = createRideFixtureDb(NOW);
  const saveSpy = vi.spyOn(db, "saveAthleteSettings");
  const addSpy = vi.spyOn(db, "addFtpHistoryEntry");
  const fetch = vi.fn().mockResolvedValue(json(200, { kind: "recompute", activities: 3, days: 4, done: true, nextOffset: null }));
  renderSettings(db, fetchClient(fetch));
  await ready();
  change("Manual FTP", "");
  save();
  await screen.findByText("Recomputed 3 rides, 4 days");
  expect(saveSpy).toHaveBeenCalledWith({ manualFtpW: null });
  expect(addSpy).not.toHaveBeenCalled();
});

test("sync cards from the fixtures, with the Peloton reconnect prompt and its error in red", async () => {
  renderSettings(createRideFixtureDb(NOW), null);
  await ready();
  const garmin = screen.getByRole("region", { name: "Garmin activities" });
  expect(garmin).toHaveTextContent("1 h ago");
  expect(garmin).toHaveTextContent("4 fetched, 4 upserted");
  expect(garmin).toHaveTextContent("Complete");
  expect(screen.getByRole("region", { name: "Garmin weight" })).toBeInTheDocument();
  const peloton = screen.getByRole("region", { name: "Peloton" });
  expect(peloton).toHaveTextContent("1 day ago"); // last success 26 h ago
  expect(within(peloton).getByText(/invalid_grant/)).toHaveClass("text-red-700");
  expect(within(peloton).getByText("Peloton needs reconnecting: paste new Auth0 tokens into the Vercel env (see docs/ride-sync.md)")).toBeInTheDocument();
  expect(garmin).not.toHaveTextContent("reconnecting");
});

test("no sync rows: No sync has run yet", async () => {
  renderSettings(createMockDataLayer({ rides: { ...buildRideFixtures(NOW), syncState: [] } }), null);
  await ready();
  expect(screen.getByText("No sync has run yet")).toBeInTheDocument();
});

test("Sync now: disabled while running, then each source's counts or error, and the cards reload", async () => {
  const db = createRideFixtureDb(NOW);
  const listSpy = vi.spyOn(db, "listSyncState");
  let finish!: (r: Response) => void;
  const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>((r) => (finish = r)));
  renderSettings(db, fetchClient(fetch));
  await ready();
  const before = listSpy.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  const running = await screen.findByRole("button", { name: "Syncing…" });
  expect(running).toBeDisabled();
  expect(fetch).toHaveBeenCalledWith("/api/sync", { method: "POST", headers: { Authorization: "Bearer tok" } });
  await act(async () => finish(json(200, SYNC_OK)));
  const result = await screen.findByTestId("sync-result");
  expect(result).toHaveTextContent("Garmin activities: 3 fetched, 2 upserted");
  expect(within(result).getByText("Peloton: Peloton refresh token was rejected")).toHaveClass("text-red-700");
  expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThan(before));
});

test("Sync now error: the endpoint's error text verbatim, with a 500's results", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(500, { error: "Garmin login failed", results: [SYNC_OK.results[0]] }))
    .mockResolvedValueOnce(json(401, { error: "Invalid session" }));
  renderSettings(createRideFixtureDb(NOW), fetchClient(fetch));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  const result = await screen.findByTestId("sync-result");
  await within(result).findByText("Garmin login failed");
  expect(result).toHaveTextContent("Garmin activities: 3 fetched, 2 upserted");
  fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
  await screen.findByText("Invalid session");
});

test("Supabase build: Sync now posts with the session's access token through the global fetch", async () => {
  vi.stubEnv("VITE_DATA_BACKEND", "supabase");
  const fetch = vi.fn().mockResolvedValue(json(200, SYNC_OK));
  vi.stubGlobal("fetch", fetch);
  renderSettings(createRideFixtureDb(NOW));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  await screen.findByTestId("sync-result");
  expect(fetch).toHaveBeenCalledWith("/api/sync", { method: "POST", headers: { Authorization: "Bearer session-token" } });
});

test("Starkeep: no Sync now button and no recompute", async () => {
  vi.stubEnv("VITE_DATA_BACKEND", "starkeep");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  renderSettings(createRideFixtureDb(NOW));
  await ready();
  expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  expect(screen.getByText("Sync runs on the Vercel deployment only")).toBeInTheDocument();
  change("Threshold HR", "171");
  save();
  await screen.findByText("Saved");
  expect(screen.queryByText("Recomputing…")).toBeNull();
  expect(screen.getByText("Stored TSS updates when a recompute runs on the Vercel deployment.")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

test("a failed FTP history insert after a stored save is reported and the recompute still runs", async () => {
  const db = createRideFixtureDb(NOW);
  db.addFtpHistoryEntry = () => Promise.reject(new Error("insert refused"));
  const fetch = vi.fn().mockResolvedValue(json(200, { kind: "recompute", activities: 1, days: 2, done: true, nextOffset: null }));
  renderSettings(db, fetchClient(fetch));
  await ready();
  change("Manual FTP", "270");
  save();
  await screen.findByText("Saved, but couldn't add the FTP history row: insert refused");
  await screen.findByText("Recomputed 1 ride, 2 days");
  expect((await db.getAthleteSettings()).manualFtpW).toBe(270);
});

test("Save is disabled while a recompute runs", async () => {
  let finish!: (r: Response) => void;
  const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>((r) => (finish = r)));
  renderSettings(createRideFixtureDb(NOW), fetchClient(fetch));
  await ready();
  change("Threshold HR", "170");
  save();
  await screen.findByText("Recomputing…");
  change("Max HR", "190");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await act(async () => finish(json(200, { kind: "recompute", activities: 1, days: 1, done: true, nextOffset: null })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
});

test("a failed sync-state read still marks the page ready, with the error", async () => {
  const db = createRideFixtureDb(NOW);
  db.listSyncState = () => Promise.reject(new Error("no table"));
  renderSettings(db, null);
  await ready();
  expect(screen.getByText("Couldn't load the sync status: no table")).toBeInTheDocument();
});

test("mock build: Sync now answers the fixture counts", async () => {
  renderSettings(createRideFixtureDb(NOW));
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
  const result = await screen.findByTestId("sync-result", {}, { timeout: 2000 });
  expect(result).toHaveTextContent("Garmin activities: 4 fetched, 4 upserted");
});

test("owner (sync state present): Sync now shows and a save recomputes", async () => {
  const fetch = vi.fn().mockResolvedValue(json(200, { kind: "recompute", activities: 1, days: 1, done: true, nextOffset: null }));
  renderSettings(createRideFixtureDb(NOW), fetchClient(fetch));
  await ready();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
  change("Threshold HR", "170");
  save();
  await screen.findByText("Recomputed 1 ride, 1 day");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("another account (empty sync state): no Sync now and no recompute", async () => {
  const fetch = vi.fn();
  renderSettings(createMockDataLayer({ rides: { ...buildRideFixtures(NOW), syncState: [] } }), fetchClient(fetch));
  await ready();
  expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  expect(screen.queryByText("Sync runs on the Vercel deployment only")).toBeNull();
  change("Threshold HR", "170");
  save();
  await screen.findByText("Saved");
  expect(screen.queryByText("Recomputing…")).toBeNull();
  expect(screen.queryByText("Stored TSS updates when a recompute runs on the Vercel deployment.")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test("while the sync-state read is pending, the sync controls are not rendered", async () => {
  const db = createRideFixtureDb(NOW);
  let answer!: (rows: Awaited<ReturnType<DataLayer["listSyncState"]>>) => void;
  const original = db.listSyncState.bind(db);
  db.listSyncState = () => new Promise((r) => (answer = r));
  renderSettings(db, fetchClient(vi.fn()));
  await screen.findByRole("button", { name: "Save" });
  expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  const rows = await original();
  await act(async () => answer(rows));
  await ready();
  expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
});

test("a failed sync-state read hides Sync now", async () => {
  const db = createRideFixtureDb(NOW);
  db.listSyncState = () => Promise.reject(new Error("no table"));
  renderSettings(db, fetchClient(vi.fn()));
  await ready();
  expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
});

test("the no-power TSS field explains the estimated TSS and the est. chip", async () => {
  renderSettings(createRideFixtureDb(NOW), null);
  await ready();
  expect(
    screen.getByText(/Rides without power or heart rate get an estimated TSS at this rate\. They show an est\. chip\./),
  ).toBeInTheDocument();
});
