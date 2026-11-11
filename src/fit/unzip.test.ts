import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { decodeFit, fitFromZip, FitError } from "./index.js";
import { MAX_FIT_BYTES } from "./unzip.js";
import { BT, data, def, encodeFit } from "./testing/encodeFit.js";

const fit = encodeFit([def(0, 20, [{ num: 253, baseType: BT.uint32 }]), data(0, [1_000_000_000])]);

describe("fitFromZip", () => {
  it("returns the single .fit entry", () => {
    const zip = zipSync({ "123_ACTIVITY.fit": fit, "readme.txt": new Uint8Array([1]) });
    const out = fitFromZip(zip);
    expect(out).toEqual(fit);
    expect(decodeFit(out).records[0].timestamp).toBe(1_631_065_600);
  });

  it("matches the extension case-insensitively", () => {
    expect(fitFromZip(zipSync({ "123_ACTIVITY.FIT": fit }))).toEqual(fit);
  });

  it("throws when the ZIP has no .fit entry", () => {
    const zip = zipSync({ "notes.txt": new Uint8Array([1, 2]) });
    expect(() => fitFromZip(zip)).toThrow(FitError);
    expect(() => fitFromZip(zip)).toThrow(/found 0/);
  });

  it("throws when the ZIP has more than one .fit entry", () => {
    expect(() => fitFromZip(zipSync({ "a.fit": fit, "b.fit": fit }))).toThrow(/found 2/);
  });

  it("throws FitError for bytes that are not a ZIP", () => {
    expect(() => fitFromZip(new Uint8Array([1, 2, 3, 4]))).toThrow(FitError);
  });

  it("ignores macOS resource-fork entries", () => {
    const zip = zipSync({ "123_ACTIVITY.fit": fit, "__MACOSX/._123_ACTIVITY.fit": new Uint8Array([0]) });
    expect(fitFromZip(zip)).toEqual(fit);
  });

  it("refuses a .fit entry larger than the limit (64 MiB by default)", () => {
    expect(MAX_FIT_BYTES).toBe(67108864);
    const zip = zipSync({ "big.fit": new Uint8Array(1001) });
    expect(() => fitFromZip(zip, 1000)).toThrow("big.fit is larger than 1000 bytes");
    expect(fitFromZip(zip, 1001)).toHaveLength(1001);
  });
});
