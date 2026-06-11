import { describe, it, expect } from "vitest";
import { sessionChunks } from "./grouping.js";

/** Build a WhatsApp-style name for session `pfx` ("08.39") and seconds. */
const wa = (pfx: string, sec: string, copy?: number) =>
  `WhatsApp Image 2026-06-08 at ${pfx}.${sec}${copy ? ` (${copy})` : ""}.jpeg`;

describe("sessionChunks", () => {
  it("splits a day at photo-session boundaries (the real upload shape)", () => {
    const names = [
      wa("08.39", "25"),
      wa("08.39", "25", 1),
      wa("08.39", "26"),
      wa("09.11", "09"),
      wa("09.11", "10"),
      wa("10.10", "38"),
    ];
    expect(sessionChunks(names)).toEqual([[0, 1, 2], [3, 4], [5]]);
  });

  it("keeps seconds-level differences inside one session", () => {
    const names = [wa("15.05", "54"), wa("15.05", "58", 3), wa("15.05", "59")];
    expect(sessionChunks(names)).toEqual([[0, 1, 2]]);
  });

  it("lets an unparseable name ride with the current chunk (adjacency)", () => {
    const names = [wa("08.39", "25"), "IMG_0001.jpeg", wa("08.39", "26"), wa("09.11", "09")];
    expect(sessionChunks(names)).toEqual([[0, 1, 2], [3]]);
  });

  it("degrades to even fixed-size chunks when nothing parses", () => {
    const names = Array.from({ length: 50 }, (_, i) => `IMG_${i}.jpeg`);
    const chunks = sessionChunks(names, 24);
    expect(chunks.length).toBe(3); // ceil(50/24) = 3 parts
    expect(chunks.flat()).toEqual(names.map((_, i) => i)); // order + coverage
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(24);
    // near-even: sizes differ by at most 1
    const sizes = chunks.map((c) => c.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("hard-splits one oversized session", () => {
    const names = Array.from({ length: 30 }, (_, i) =>
      wa("11.13", String(40 + (i % 20)).padStart(2, "0"), i),
    );
    const chunks = sessionChunks(names, 24);
    expect(chunks.length).toBe(2);
    expect(chunks.flat()).toHaveLength(30);
  });

  it("covers every index exactly once on the real 9-session day", () => {
    const sessions = ["08.39", "09.11", "10.10", "11.13", "13.42", "14.03", "15.05", "15.24", "15.42"];
    const names = sessions.flatMap((p, s) =>
      Array.from({ length: s % 2 === 0 ? 11 : 7 }, (_, i) => wa(p, String(10 + i), i)),
    );
    const chunks = sessionChunks(names);
    expect(chunks.length).toBe(9);
    expect(chunks.flat()).toEqual(names.map((_, i) => i));
  });

  it("returns nothing for an empty stack", () => {
    expect(sessionChunks([])).toEqual([]);
  });
});
