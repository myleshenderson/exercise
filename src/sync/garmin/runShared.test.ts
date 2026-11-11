import { describe, expect, it } from "vitest";
import { errorMessage } from "./runShared.js";

describe("errorMessage", () => {
  it("returns an Error's message unchanged", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("spells out every PostgrestError field", () => {
    const e = {
      message: "duplicate key value violates unique constraint",
      code: "23505",
      details: "Key (id)=(1) already exists.",
      hint: "Use upsert.",
    };
    expect(errorMessage(e)).toBe(
      "duplicate key value violates unique constraint (code 23505): Key (id)=(1) already exists.. Use upsert.",
    );
  });

  it("returns the message alone when the other fields are absent or empty", () => {
    expect(errorMessage({ message: "only message" })).toBe("only message");
    expect(errorMessage({ message: "m", code: "", details: null, hint: "" })).toBe("m");
  });

  it("serializes a plain object without a message as JSON", () => {
    expect(errorMessage({ status: 500, reason: "x" })).toBe('{"status":500,"reason":"x"}');
  });

  it("JSON-encodes a string", () => {
    expect(errorMessage("plain")).toBe('"plain"');
  });

  it("renders null as null", () => {
    expect(errorMessage(null)).toBe("null");
  });

  it("falls back to String when JSON.stringify fails or yields nothing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorMessage(circular)).toBe("[object Object]");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(10n)).toBe("10");
  });
});
