/**
 * Ids for the Starkeep starter rows (`src/data/seed.ts`), the same on every
 * surface and for every user.
 *
 * Two surfaces that seed one user before they sync write the same rows, so
 * sync keeps one copy, and an `ifAbsent` insert leaves a row the user already
 * edited or deleted alone. The ids are UUIDv5 (RFC 9562) under a namespace of
 * Exercise's own, so they keep the uuid shape the rest of the app's ids have.
 * Every user's rows are scoped by the platform, so one id under two users
 * names two rows.
 */

/** Exercise's UUIDv5 namespace for starter rows. Never change it: the ids are stored. */
export const STARTER_NAMESPACE = "b4c261da-f9e1-4622-a45c-b89e5ed934ec";

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** The UUIDv5 of `name` under `namespace`. */
export async function uuidV5(name: string, namespace: string = STARTER_NAMESPACE): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidBytes(namespace));
  input.set(nameBytes, 16);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const starterExerciseId = (slug: string) => uuidV5(`exercise:${slug}`);
export const starterDayId = (slug: string) => uuidV5(`day:${slug}`);
export const starterLinkId = (daySlug: string, exerciseSlug: string) => uuidV5(`link:${daySlug}:${exerciseSlug}`);
