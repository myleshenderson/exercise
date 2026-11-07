import { describe, expect, it } from "vitest";
import {
  catchToolError,
  invalidIdError,
  toolError,
  toolResult,
  validateReps,
  validateSets,
  validateWeight,
} from "./format.js";

describe("toolResult / toolError", () => {
  it("renders data as 2-space-indented JSON text", () => {
    expect(toolResult({ id: "a", n: [1] })).toEqual({
      content: [{ type: "text", text: '{\n  "id": "a",\n  "n": [\n    1\n  ]\n}' }],
    });
  });

  it("wraps a message as an isError text result", () => {
    expect(toolError("nope")).toEqual({ isError: true, content: [{ type: "text", text: "nope" }] });
  });
});

describe("invalidIdError", () => {
  it("accepts a UUID in any case", () => {
    expect(invalidIdError("t", "day_id", "0F8FAD5B-D9CB-469F-A165-70867728950E")).toBeUndefined();
  });

  it("names the tool, parameter and offending value", () => {
    expect(invalidIdError("rename_day_template", "day_id", "Push A")).toEqual(
      toolError('rename_day_template failed: expected a UUID for day_id, got "Push A".'),
    );
  });
});

describe("catchToolError", () => {
  it("passes a successful result through", async () => {
    const ok = toolResult({ ok: true });
    expect(await catchToolError("t", async () => ok)).toBe(ok);
  });

  it.each([
    ["an Error", new Error("boom"), "boom"],
    ["a PostgrestError-like object", { message: "duplicate key", code: "23505" }, "duplicate key"],
    ["a bare string", "oops", "oops"],
  ])("turns %s into '<tool> failed: <message>'", async (_label, thrown, message) => {
    expect(
      await catchToolError("create_program", async () => {
        throw thrown;
      }),
    ).toEqual(toolError(`create_program failed: ${message}`));
  });
});

describe("validators", () => {
  it("validateReps: integers 1..40", () => {
    expect([1, 40].map(validateReps)).toEqual([undefined, undefined]);
    for (const v of [0, 41, 2.5]) expect(validateReps(v)).toBe("must be an integer between 1 and 40.");
  });

  it("validateSets: integers 1..10", () => {
    expect([1, 10].map(validateSets)).toEqual([undefined, undefined]);
    for (const v of [0, 11, 1.5]) expect(validateSets(v)).toBe("must be an integer between 1 and 10.");
  });

  it("validateWeight: 0..500, fractions allowed, NaN rejected", () => {
    expect([0, 22.5, 500].map(validateWeight)).toEqual([undefined, undefined, undefined]);
    for (const v of [-1, 500.5, Number.NaN]) expect(validateWeight(v)).toBe("must be between 0 and 500.");
  });
});
