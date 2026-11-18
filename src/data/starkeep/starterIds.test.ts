import { expect, test } from "vitest";
import { starterDayId, starterExerciseId, starterLinkId, uuidV5 } from "./starterIds";

test("uuidV5 matches RFC 9562 (the DNS namespace's www.example.com)", async () => {
  expect(await uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
});

test("starter ids are stable, distinct per kind, and uuid-shaped", async () => {
  const ids = [await starterExerciseId("leg-press"), await starterDayId("leg-press"), await starterLinkId("leg-day", "leg-press")];
  expect(new Set(ids).size).toBe(3);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await starterExerciseId("leg-press")).toBe(ids[0]);
});
