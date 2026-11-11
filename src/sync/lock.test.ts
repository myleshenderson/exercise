// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_LOCK_RENEW_MS,
  SYNC_LOCK_TTL_MS,
  SyncLockBusyError,
  withSyncLock,
  type SyncLockClient,
} from "./lock.js";

interface Row {
  name: string;
  lease_until: string;
  holder: string | null;
}

/**
 * A fake service-role client over the one `sync_lock` row, mirroring the migration's SQL: the
 * two functions compare and stamp with the database clock (`db.now`), and release is the plain
 * `update(...).eq(name).eq(holder)`. Each call applies atomically when awaited.
 */
function fakeClient(db: { now: number; row: Row }) {
  const calls: string[] = [];
  const lease = (ttl: number) => new Date(db.now + ttl * 1000).toISOString();
  const client = {
    rpc(fn: string, args: { p_holder: string; p_ttl_seconds: number }) {
      calls.push(fn);
      const row = db.row;
      let data: boolean;
      if (fn === "acquire_sync_lock") {
        data = Date.parse(row.lease_until) < db.now;
        if (data) Object.assign(row, { lease_until: lease(args.p_ttl_seconds), holder: args.p_holder });
      } else if (fn === "renew_sync_lock") {
        data = row.holder === args.p_holder;
        if (data) row.lease_until = lease(args.p_ttl_seconds);
      } else throw new Error(`unexpected rpc ${fn}`);
      return Promise.resolve({ data, error: null });
    },
    from(table: string) {
      expect(table).toBe("sync_lock");
      return {
        update(values: Partial<Row>) {
          const filters: [string, string][] = [];
          const builder = {
            eq(col: string, v: string) {
              filters.push([col, v]);
              return builder;
            },
            then<R>(resolve: (r: { data: null; error: null }) => R) {
              calls.push("release");
              if (filters.every(([col, v]) => db.row[col as keyof Row] === v)) Object.assign(db.row, values);
              return Promise.resolve(resolve({ data: null, error: null }));
            },
          };
          return builder;
        },
      };
    },
  };
  return { client: client as unknown as SyncLockClient, calls };
}

const T0 = Date.parse("2026-11-11T10:00:00.000Z");
const EPOCH = "1970-01-01T00:00:00.000Z";
const seeded = (now = T0) => ({ now, row: { name: "sync", lease_until: EPOCH, holder: null } as Row });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withSyncLock (AI-659)", () => {
  it("takes the lease for 15 minutes on the database clock, runs fn and releases on success", async () => {
    const db = seeded();
    const { client } = fakeClient(db);
    const fn = vi.fn(async () => {
      expect(db.row.lease_until).toBe(new Date(T0 + SYNC_LOCK_TTL_MS).toISOString());
      expect(db.row.holder).toMatch(/^cron:/);
      return "ok";
    });
    await expect(withSyncLock(client, fn, { label: "cron" })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(db.row).toEqual({ name: "sync", lease_until: EPOCH, holder: null });
  });

  it("refuses a second concurrent acquire without running its fn, and the first releases", async () => {
    const db = seeded();
    const { client } = fakeClient(db);
    const gate = deferred<void>();
    const first = withSyncLock(client, async () => {
      await gate.promise;
      return "first";
    });
    await vi.waitFor(() => expect(db.row.holder).not.toBeNull());
    const firstHolder = db.row.holder;

    db.now = T0 + 1000;
    const secondFn = vi.fn(async () => "second");
    const refused = withSyncLock(client, secondFn);
    await expect(refused).rejects.toBeInstanceOf(SyncLockBusyError);
    await expect(refused).rejects.toThrow("sync already running");
    expect(secondFn).not.toHaveBeenCalled();
    // The refused run does not disturb the holder's lease.
    expect(db.row.holder).toBe(firstHolder);

    gate.resolve();
    await expect(first).resolves.toBe("first");
    expect(db.row.lease_until).toBe(EPOCH);
    await expect(withSyncLock(client, secondFn)).resolves.toBe("second");
  });

  it("releases when fn throws and rethrows fn's error", async () => {
    const db = seeded();
    const { client } = fakeClient(db);
    const boom = new Error("boom");
    await expect(withSyncLock(client, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(db.row).toEqual({ name: "sync", lease_until: EPOCH, holder: null });
    await expect(withSyncLock(client, async () => 1)).resolves.toBe(1);
  });

  it("takes over a lease older than 15 minutes, and the stale holder's release does not free it", async () => {
    const db = seeded();
    const { client } = fakeClient(db);
    const gate = deferred<void>();
    // A holder that stopped renewing (a crashed or killed run).
    const stale = withSyncLock(client, () => gate.promise, { renewMs: 24 * 60 * 60 * 1000 });
    await vi.waitFor(() => expect(db.row.holder).not.toBeNull());
    const staleHolder = db.row.holder;

    // Still live one second before the TTL runs out.
    db.now = T0 + SYNC_LOCK_TTL_MS - 1000;
    await expect(withSyncLock(client, async () => "early")).rejects.toBeInstanceOf(SyncLockBusyError);

    // Past the TTL: taken over.
    db.now = T0 + SYNC_LOCK_TTL_MS + 1000;
    const takeoverGate = deferred<void>();
    const takeover = withSyncLock(client, async () => {
      await takeoverGate.promise;
      return "takeover";
    });
    await vi.waitFor(() => expect(db.row.holder).not.toBe(staleHolder));
    const newHolder = db.row.holder;

    // The stale run finishing must not release the new holder's lease.
    gate.resolve();
    await stale;
    expect(db.row.holder).toBe(newHolder);
    expect(db.row.lease_until).toBe(new Date(db.now + SYNC_LOCK_TTL_MS).toISOString());
    await expect(withSyncLock(client, async () => "third")).rejects.toBeInstanceOf(SyncLockBusyError);

    takeoverGate.resolve();
    await expect(takeover).resolves.toBe("takeover");
    expect(db.row.lease_until).toBe(EPOCH);
  });

  it("renews the lease while fn runs, logs a lost lease, and stops renewing at release", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = seeded();
    const { client, calls } = fakeClient(db);
    const gate = deferred<void>();
    const run = withSyncLock(client, () => gate.promise);
    await vi.waitFor(() => expect(db.row.holder).not.toBeNull());

    db.now = T0 + SYNC_LOCK_RENEW_MS;
    await vi.advanceTimersByTimeAsync(SYNC_LOCK_RENEW_MS);
    expect(db.row.lease_until).toBe(new Date(db.now + SYNC_LOCK_TTL_MS).toISOString());
    expect(log).not.toHaveBeenCalled();

    // Someone took it over (e.g. the database was unreachable past the TTL): logged, not thrown.
    db.row.holder = "cron:other";
    await vi.advanceTimersByTimeAsync(SYNC_LOCK_RENEW_MS);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/^sync lock lost: /);

    gate.resolve();
    await run;
    // The other holder's lease is untouched by this run's release.
    expect(db.row.holder).toBe("cron:other");
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(SYNC_LOCK_RENEW_MS * 3);
    expect(calls.length).toBe(after);
  });

  it("surfaces a database error on acquire without running fn", async () => {
    const client = {
      rpc: () => Promise.resolve({ data: null, error: { message: "function acquire_sync_lock does not exist" } }),
    } as unknown as SyncLockClient;
    const fn = vi.fn(async () => 1);
    await expect(withSyncLock(client, fn)).rejects.toThrow(/sync lock acquire failed: function acquire_sync_lock does not exist/);
    expect(fn).not.toHaveBeenCalled();
  });
});
