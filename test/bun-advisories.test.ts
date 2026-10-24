import { describe, expect, test } from "bun:test";
import { affecting, affects } from "../scripts/bun-advisories.ts";

describe("affects", () => {
  test("a bounded range", () => {
    expect(affects(">= 1.0.21, < 1.4.4", "1.3.10")).toBe(true);
    expect(affects(">= 1.0.21, < 1.4.4", "1.4.4")).toBe(false);
    expect(affects(">= 1.0.21, < 1.4.4", "1.0.20")).toBe(false);
  });

  test("an open range", () => {
    expect(affects("< 1.4.4", "0.8.1")).toBe(true);
    expect(affects("< 1.4.4", "1.10.0")).toBe(false);
  });

  test("an exact version", () => {
    expect(affects("= 1.2.0", "1.2.0")).toBe(true);
    expect(affects("1.2.0", "1.2.1")).toBe(false);
  });

  test("an unreadable range throws rather than reading as safe", () => {
    expect(() => affects("~1.2", "1.2.0")).toThrow();
  });
});

describe("affecting", () => {
  const advisories = [
    {
      ghsa_id: "GHSA-cf8x-9m69-3gg3",
      state: "published",
      vulnerabilities: [
        {
          package: { name: "bun" },
          vulnerable_version_range: ">= 1.3.14, < 1.4.4",
        },
      ],
    },
    {
      ghsa_id: "GHSA-663w-cv8g-jj2p",
      state: "published",
      vulnerabilities: [
        {
          package: { name: "bun" },
          vulnerable_version_range: ">= 1.0.21, < 1.4.4",
        },
      ],
    },
    {
      ghsa_id: "GHSA-0000-0000-0000",
      state: "withdrawn",
      vulnerabilities: [
        { package: { name: "bun" }, vulnerable_version_range: "< 9.0.0" },
      ],
    },
  ];

  test("lists the published advisories that cover the version", () => {
    expect(affecting(advisories, "1.3.10")).toEqual(["GHSA-663w-cv8g-jj2p"]);
    expect(affecting(advisories, "1.4.0")).toEqual([
      "GHSA-663w-cv8g-jj2p",
      "GHSA-cf8x-9m69-3gg3",
    ]);
    expect(affecting(advisories, "1.4.4")).toEqual([]);
  });
});
