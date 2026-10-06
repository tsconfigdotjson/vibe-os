import { describe, expect, test } from "bun:test";
import {
  countBlanks,
  fillBlanks,
  fillPrompt,
  parsePrompt,
} from "../shared/blanks.ts";

describe("parsePrompt", () => {
  test("a prompt with no braces is one text segment", () => {
    expect(parsePrompt("review the ticket")).toEqual([
      { type: "text", value: "review the ticket", key: "t0" },
    ]);
  });

  test("splits literal runs from blanks", () => {
    const segments = parsePrompt("review {{ticket}} for {{owner}}");
    expect(segments.map((s) => s.type)).toEqual([
      "text",
      "blank",
      "text",
      "blank",
    ]);
    expect(segments.map((s) => s.value)).toEqual([
      "review ",
      "ticket",
      " for ",
      "owner",
    ]);
  });

  test("numbers blanks in order, from zero", () => {
    const blanks = parsePrompt("{{a}} {{b}} {{c}}").filter(
      (s) => s.type === "blank",
    );
    expect(blanks.map((b) => b.index)).toEqual([0, 1, 2]);
  });

  test("two blanks with the same label stay separate fields", () => {
    const blanks = parsePrompt("{{file}} and {{file}}").filter(
      (s) => s.type === "blank",
    );
    expect(blanks).toHaveLength(2);
    expect(blanks[0].index).not.toBe(blanks[1].index);
  });

  test("keys are unique across a prompt", () => {
    // They are React keys for a list rendered from this array.
    const segments = parsePrompt("a {{x}} b {{x}} c {{x}}");
    const keys = segments.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("keys are stable across repeated parses", () => {
    const prompt = "review {{ticket}} for {{owner}}";
    expect(parsePrompt(prompt).map((s) => s.key)).toEqual(
      parsePrompt(prompt).map((s) => s.key),
    );
  });

  test("trims the label but not the surrounding text", () => {
    const [, blank] = parsePrompt("x {{  spaced  }}");
    expect(blank.value).toBe("spaced");
  });

  test("ignores a blank spanning a newline", () => {
    expect(parsePrompt("{{a\nb}}").every((s) => s.type === "text")).toBe(true);
  });

  test("ignores an over-long label", () => {
    const long = "z".repeat(61);
    expect(parsePrompt(`{{${long}}}`).every((s) => s.type === "text")).toBe(
      true,
    );
  });
});

describe("countBlanks", () => {
  test("agrees with parsePrompt", () => {
    for (const prompt of [
      "none here",
      "{{one}}",
      "{{a}} {{b}} {{c}}",
      "{{a\nb}}",
    ]) {
      const parsed = parsePrompt(prompt).filter((s) => s.type === "blank");
      expect(countBlanks(prompt)).toBe(parsed.length);
    }
  });
});

describe("fillPrompt", () => {
  test("substitutes by index", () => {
    expect(fillPrompt("review {{ticket}}", { 0: "VO-12" })).toBe(
      "review VO-12",
    );
  });

  test("falls back to the label so the sentence still reads", () => {
    expect(fillPrompt("review {{ticket}} now", {})).toBe("review ticket now");
    expect(fillPrompt("review {{ticket}} now", { 0: "   " })).toBe(
      "review ticket now",
    );
  });

  test("trims what was typed", () => {
    expect(fillPrompt("{{a}}", { 0: "  x  " })).toBe("x");
  });

  test("fills repeated labels independently", () => {
    expect(fillPrompt("{{file}} and {{file}}", { 0: "a.ts", 1: "b.ts" })).toBe(
      "a.ts and b.ts",
    );
  });

  /**
   * fillPrompt and parsePrompt walk the same regex and must agree on how many
   * blanks there are, or the values land against the wrong fields.
   */
  test("indices line up with what parsePrompt handed the band", () => {
    const prompt = "a {{one}} b {{two}} c";
    const values: Record<number, string> = {};
    for (const s of parsePrompt(prompt)) {
      if (s.type === "blank") values[s.index] = `<${s.value}>`;
    }
    expect(fillPrompt(prompt, values)).toBe("a <one> b <two> c");
  });
});

describe("fillBlanks", () => {
  test("fills every blank with a label, and reports nothing amiss", () => {
    expect(
      fillBlanks("review {{ticket}} then {{ticket}}", { ticket: "#4" }),
    ).toEqual({ text: "review #4 then #4", missing: [], unknown: [] });
  });

  test("reports labels left empty and labels the prompt lacks", () => {
    expect(fillBlanks("{{a}} and {{b}}", { a: " ", c: "x" })).toEqual({
      text: "a and b",
      missing: ["a", "b"],
      unknown: ["c"],
    });
  });
});
