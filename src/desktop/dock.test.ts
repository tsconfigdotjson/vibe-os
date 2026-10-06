import { describe, expect, test } from "bun:test";
import { boxLevel, shortBytes, windowLevel } from "./Dock";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe("shortBytes", () => {
  test("megabytes below a gigabyte, one decimal above", () => {
    expect(shortBytes(612 * MB)).toBe("612M");
    expect(shortBytes(1.44 * GB)).toBe("1.4G");
  });
});

describe("windowLevel", () => {
  const limits = { high: 1.6 * GB, max: 2 * GB };
  test("under its high limit", () => {
    expect(windowLevel({ bytes: GB, ...limits })).toBe("ok");
  });
  test("throttled", () => {
    expect(windowLevel({ bytes: 1.7 * GB, ...limits })).toBe("warn");
  });
  test("about to be killed", () => {
    expect(windowLevel({ bytes: 1.9 * GB, ...limits })).toBe("err");
  });
  test("unscoped windows are never coloured", () => {
    expect(windowLevel({ bytes: 3 * GB, high: null, max: null })).toBe("ok");
  });
});

describe("boxLevel", () => {
  const box = { total: 4 * GB, available: 2 * GB };
  test("amber exactly when the server would ask first", () => {
    expect(boxLevel(box, null)).toBe("ok");
    expect(boxLevel(box, "no room")).toBe("warn");
  });
  test("red under a tenth of RAM, whatever the warning", () => {
    expect(boxLevel({ total: 4 * GB, available: 300 * MB }, null)).toBe("err");
  });
});
