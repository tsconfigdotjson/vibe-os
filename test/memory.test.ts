import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { memoryChecks } from "../server/doctor.ts";
import {
  AGENT_BUDGET,
  type BoxMemory,
  capacityWarning,
  effectiveLimits,
  ownScope,
  parseMeminfo,
  parsePressure,
  parseSize,
  scopePrefix,
  sizeToBytes,
} from "../server/memory.ts";
import { createProfile, updateProfile } from "../server/profiles.ts";
import { windowCommand } from "../server/session.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("parseSize", () => {
  const good: [string, string][] = [
    ["2G", "2G"],
    ["2g", "2G"],
    ["2GB", "2G"],
    ["1500M", "1500M"],
    ["1.5G", "1.5G"],
    ["  40% ", "40%"],
    ["100%", "100%"],
    ["infinity", "infinity"],
    ["none", "infinity"],
    ["1048576", "1048576"],
  ];
  for (const [input, out] of good)
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(parseSize(input, "x")).toBe(out);
    });

  test("empty and absent mean not set", () => {
    expect(parseSize("", "x")).toBe(null);
    expect(parseSize("  ", "x")).toBe(null);
    expect(parseSize(undefined, "x")).toBe(null);
    expect(parseSize(null, "x")).toBe(null);
  });

  // Everything here ends up inside a force-command, so anything that is not a
  // size has to be refused, not quoted.
  const bad = [
    "0",
    "0%",
    "101%",
    "40.5%",
    "-1G",
    "2P",
    "lots",
    "2G; rm -rf ~",
    "$(id)",
    "2 G",
  ];
  for (const input of bad)
    test(`refuses ${JSON.stringify(input)}`, () => {
      expect(() => parseSize(input, "x")).toThrow();
    });
});

describe("sizeToBytes", () => {
  test("absolute sizes", () => {
    expect(sizeToBytes("2G", 4 * GB)).toBe(2 * GB);
    expect(sizeToBytes("1.5G", 4 * GB)).toBe(1.5 * GB);
    expect(sizeToBytes("700M", 4 * GB)).toBe(700 * MB);
  });
  test("percentages are of physical memory", () => {
    expect(sizeToBytes("50%", 4 * GB)).toBe(2 * GB);
  });
  test("no limit is null", () => {
    expect(sizeToBytes("infinity", 4 * GB)).toBe(null);
    expect(sizeToBytes(null, 4 * GB)).toBe(null);
  });
});

describe("effectiveLimits", () => {
  const global = { high: "40%", max: "50%", swapMax: "10%" };
  test("the server's when there is no profile", () => {
    expect(effectiveLimits(global, null)).toEqual(global);
  });
  test("a profile overrides one field at a time", () => {
    expect(
      effectiveLimits(global, { memoryHigh: "1G", memoryMax: null }),
    ).toEqual({ high: "1G", max: "50%", swapMax: "10%" });
  });
  test("a profile can set limits the server does not", () => {
    expect(
      effectiveLimits(
        { high: null, max: null, swapMax: null },
        { memoryHigh: null, memoryMax: "2G" },
      ),
    ).toEqual({ high: null, max: "2G", swapMax: null });
  });
});

describe("scopePrefix", () => {
  test("nothing when there are no limits", () => {
    expect(
      scopePrefix({ high: null, max: null, swapMax: null }, "vibe-w-1"),
    ).toBe("");
  });
  test("a scope carrying only the limits that are set", () => {
    const p = scopePrefix({ high: null, max: "2G", swapMax: null }, "vibe-w-1");
    expect(p).toContain("systemd-run --user --scope");
    expect(p).toContain("-p MemoryMax=2G");
    expect(p).not.toContain("MemoryHigh");
    expect(p).not.toContain("MemorySwapMax");
    expect(p.endsWith("-- ")).toBe(true);
  });
});

describe("windowCommand with limits", () => {
  const config = (memory: Config["memory"]) =>
    ({ sessions: true, stateDir: "/var/lib/vibe-os", memory }) as Config;
  const limited = config({ high: "40%", max: "50%", swapMax: "10%" });

  test("starts the session in a scope, with a fallback for no systemd", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", limited) as string;
    expect(cmd).toContain("systemctl --user show-environment");
    // A scope dies with the user manager, which dies with the last login
    // unless the user lingers.
    expect(cmd).toContain("/var/lib/systemd/linger/");
    expect(cmd).toContain("-p MemoryHigh=40%");
    expect(cmd).toContain("-p MemoryMax=50%");
    // Without this a scope at its maximum swaps instead of being killed.
    expect(cmd).toContain("-p MemorySwapMax=10%");
    // Both branches still create the session, marker included: two each, in
    // each of the flock and no-flock copies of the critical section.
    expect(cmd.match(/VIBE_OS_SOCK=/g)?.length).toBe(4);
    expect(cmd.match(/dtach -n /g)?.length).toBe(4);
  });

  test("only the create is scoped; attaching is not", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", limited) as string;
    const attach = cmd.slice(cmd.indexOf("exec dtach -a"));
    expect(attach).not.toContain("systemd-run");
  });

  test("a profile's own limit wins", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", limited, {
      id: "p",
      projectId: "x",
      color: "cyan",
      name: "R",
      harness: "claude",
      command: null,
      args: [],
      prompt: "",
      memoryHigh: null,
      memoryMax: "3G",
      position: 0,
      createdAt: 0,
    }) as string;
    expect(cmd).toContain("-p MemoryMax=3G");
    expect(cmd).toContain("-p MemoryHigh=40%");
  });

  test("no limits, no scope", () => {
    const cmd = windowCommand(
      "vibe-w-1",
      "/tmp",
      config({ high: null, max: null, swapMax: null }),
    ) as string;
    expect(cmd).not.toContain("systemd-run");
  });

  for (const forDisplay of [false, true])
    test(`is valid shell${forDisplay ? " for display" : ""}`, async () => {
      const cmd = windowCommand("vibe-w-1", "/tmp", limited, null, {
        forDisplay,
      }) as string;
      const proc = Bun.spawn(["/bin/sh", "-n"], {
        stdin: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(cmd);
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
    });
});

// Copied from the reference VPS.
const MEMINFO = `MemTotal:        3905536 kB
MemFree:          622592 kB
MemAvailable:    2806784 kB
Buffers:           12345 kB
SwapTotal:       2097148 kB
SwapFree:        1286144 kB
HugePages_Total:       0
`;

describe("/proc parsing", () => {
  test("meminfo, in bytes", () => {
    const m = parseMeminfo(MEMINFO);
    expect(m.MemTotal).toBe(3905536 * 1024);
    expect(m.MemAvailable).toBe(2806784 * 1024);
    expect(m.SwapTotal).toBe(2097148 * 1024);
    // Unitless lines are counts, not kB.
    expect(m.HugePages_Total).toBe(0);
  });

  test("pressure", () => {
    expect(
      parsePressure(
        "some avg10=12.50 avg60=3.00 avg300=0.00 total=1\nfull avg10=4.25 avg60=0.00 avg300=0.00 total=1\n",
      ),
    ).toEqual({ some10: 12.5, full10: 4.25 });
    expect(parsePressure("")).toBe(null);
  });

  test("a scope of its own, under the user manager", () => {
    expect(
      ownScope(
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-p2389501-i2390408.scope\n",
      ),
    ).toBe(
      "/user.slice/user-1000.slice/user@1000.service/app.slice/run-p2389501-i2390408.scope",
    );
  });

  test("the login's session scope is not the window's own", () => {
    expect(
      ownScope("0::/user.slice/user-1000.slice/session-3683.scope\n"),
    ).toBe(null);
    expect(ownScope("")).toBe(null);
  });
});

describe("capacityWarning", () => {
  const box = (over: Partial<BoxMemory> = {}): BoxMemory => ({
    total: 4 * GB,
    available: 3 * GB,
    swapTotal: 2 * GB,
    swapFree: 2 * GB,
    pressure: { some10: 0, full10: 0 },
    ...over,
  });

  test("room to spare", () => {
    expect(capacityWarning(box(), null)).toBe(null);
  });

  test("not enough left for an agent and the reserve", () => {
    expect(capacityWarning(box({ available: AGENT_BUDGET }), null)).toContain(
      "free",
    );
  });

  test("pressure alone is not a reason: a throttled window causes it", () => {
    expect(
      capacityWarning(box({ pressure: { some10: 95, full10: 80 } }), null),
    ).toBe(null);
  });

  test("a small MemoryHigh budgets less than the default", () => {
    const available = AGENT_BUDGET + 0.1 * 4 * GB - 50 * MB;
    expect(capacityWarning(box({ available }), null)).not.toBe(null);
    expect(capacityWarning(box({ available }), "300M")).toBe(null);
  });

  test("nothing to say without /proc", () => {
    expect(capacityWarning(null, null)).toBe(null);
  });
});

describe("doctor memoryChecks", () => {
  const limits = { high: "40%", max: "50%", swapMax: "10%" };
  const scoped = {
    systemd: true,
    linger: true,
    controllers: ["cpu", "memory", "pids"],
  };
  const healthy = { oomd: false, earlyoom: "active" as const, swapTotal: GB };

  test("scoped and watched", () => {
    const [scope, oom] = memoryChecks("vibe", limits, scoped, healthy);
    expect(scope.ok).toBe(true);
    expect(scope.detail).toContain("MemoryMax=50%");
    expect(oom.ok).toBe(true);
  });

  test("no systemd", () => {
    const [scope] = memoryChecks(
      "vibe",
      limits,
      { systemd: false, linger: false, controllers: null },
      healthy,
    );
    expect(scope.ok).toBe(false);
  });

  test("no linger, no limits", () => {
    const [scope] = memoryChecks(
      "vibe",
      limits,
      { ...scoped, linger: false },
      healthy,
    );
    expect(scope.ok).toBe(false);
    expect(scope.fix).toContain("enable-linger vibe");
  });

  test("memory controller not delegated", () => {
    const [scope] = memoryChecks(
      "vibe",
      limits,
      { systemd: true, linger: true, controllers: ["pids"] },
      healthy,
    );
    expect(scope.ok).toBe(false);
    expect(scope.fix).toContain("Delegate=");
  });

  test("swap with no OOM daemon is the combination that thrashes", () => {
    const [, oom] = memoryChecks("vibe", limits, scoped, {
      oomd: false,
      earlyoom: null,
      swapTotal: GB,
    });
    expect(oom.ok).toBe(false);
    expect(oom.detail).toContain("thrashes");
  });

  test("earlyoom installed but stopped", () => {
    const [, oom] = memoryChecks("vibe", limits, scoped, {
      oomd: false,
      earlyoom: "installed",
      swapTotal: 0,
    });
    expect(oom.ok).toBe(false);
    expect(oom.fix).toContain("enable --now earlyoom");
  });
});

describe("profile memory fields", () => {
  const db = openDb(mkdtempSync(path.join(os.tmpdir(), "vibe-os-mem-")));

  test("stored normalised, cleared by an empty string", () => {
    const p = createProfile(db, "proj", {
      name: "Agent",
      memoryHigh: "1gb",
      memoryMax: "50%",
    });
    expect(p.memoryHigh).toBe("1G");
    expect(p.memoryMax).toBe("50%");
    const cleared = updateProfile(db, p.id, { memoryHigh: "" });
    expect(cleared?.memoryHigh).toBe(null);
    expect(cleared?.memoryMax).toBe("50%");
  });

  test("a bad size is refused", () => {
    expect(() =>
      createProfile(db, "proj", { name: "Bad", memoryMax: "$(id)" }),
    ).toThrow();
  });
});
