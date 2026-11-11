/** Writes one ingested activity: row, streams, then pairing. */
import type { ExternalActivity } from "../types.js";
import { pairActivity } from "./pairing.js";
import type { SyncStore } from "./store.js";
import type { IngestResult } from "./types.js";

export async function persistActivity(store: SyncStore, r: IngestResult): Promise<ExternalActivity> {
  const stored = await store.upsertActivity(r.row);
  await store.replaceStreams(stored.id, r.streams);
  return pairActivity(store, stored);
}
