import { describe, expect, it } from "vitest";
import { parseCsvRecords } from "./csv.js";

describe("parseCsvRecords (shared)", () => {
  it("keeps commas inside quoted fields", () => {
    expect(parseCsvRecords('a,"b,c",d\n')).toEqual([["a", "b,c", "d"]]);
  });

  it("keeps CRLF, LF and CR inside quoted fields", () => {
    expect(parseCsvRecords('"x\r\ny","p\nq","r\rs"\r\n1,2,3')).toEqual([
      ["x\r\ny", "p\nq", "r\rs"],
      ["1", "2", "3"],
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvRecords('"say ""hi""",""""\n')).toEqual([['say "hi"', '"']]);
  });

  it("ends records on CRLF, LF or a lone CR and drops a leading BOM", () => {
    expect(parseCsvRecords("﻿a\r\nb\nc\rd")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("skips a blank or whitespace-only line, but keeps a record of empty fields", () => {
    expect(parseCsvRecords("h1,h2\n\n   \r\n\t\n,\n1,2\n \n")).toEqual([
      ["h1", "h2"],
      ["", ""],
      ["1", "2"],
    ]);
  });

  it("keeps a quoted field that is only whitespace when the record has other fields", () => {
    expect(parseCsvRecords('" ",x')).toEqual([[" ", "x"]]);
  });

  it("returns nothing for empty input", () => {
    expect(parseCsvRecords("")).toEqual([]);
    expect(parseCsvRecords("﻿")).toEqual([]);
  });
});
