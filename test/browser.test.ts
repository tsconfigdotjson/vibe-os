import { describe, expect, test } from "bun:test";
import {
  archSupported,
  browserServices,
  browserUnits,
  defaultBrowserOptions,
  memoryHeadroom,
  parseGeometry,
  parseMemInfo,
  portsFromUnits,
  vncExposure,
} from "../server/browser.ts";

/**
 * The listener fixtures are `ss -ltnH` copied from the VPS with the browser
 * running. The exposed case is the same output with the bind address changed,
 * which is exactly what getting -localhost wrong produces.
 */
const SS_LOOPBACK = `LISTEN 0      4096                    127.0.0.54:53    0.0.0.0:*
LISTEN 0      5                        127.0.0.1:5900  0.0.0.0:*
LISTEN 0      4096                 127.0.0.53%lo:53    0.0.0.0:*
LISTEN 0      5                            [::1]:5900     [::]:*
LISTEN 0      4096                 100.96.101.46:32799 0.0.0.0:*
`;

const SS_EXPOSED = `LISTEN 0      5                          0.0.0.0:5900  0.0.0.0:*
LISTEN 0      5                             [::]:5900     [::]:*
`;

/** Loopback on v4 but every interface on v6 is still exposed. */
const SS_HALF_EXPOSED = `LISTEN 0      5                        127.0.0.1:5900  0.0.0.0:*
LISTEN 0      5                             [::]:5900     [::]:*
`;

const SS_TAILNET_ONLY = `LISTEN 0      5                    100.96.101.46:5900  0.0.0.0:*
`;

const SS_NO_VNC = `LISTEN 0      4096                    127.0.0.54:53    0.0.0.0:*
LISTEN 0      128                        0.0.0.0:22    0.0.0.0:*
`;

describe("vncExposure", () => {
  test("loopback on both families", () => {
    expect(vncExposure(SS_LOOPBACK, 5900)).toBe("loopback");
  });

  test("wildcard is exposed", () => {
    expect(vncExposure(SS_EXPOSED, 5900)).toBe("exposed");
  });

  test("one exposed listener is enough to be exposed", () => {
    expect(vncExposure(SS_HALF_EXPOSED, 5900)).toBe("exposed");
  });

  /**
   * A tailnet address is not loopback. Reaching the desktop needs the tailnet
   * *and* nothing else, and this check does not get to assume the firewall.
   */
  test("a tailnet address counts as exposed", () => {
    expect(vncExposure(SS_TAILNET_ONLY, 5900)).toBe("exposed");
  });

  test("absent when nothing holds the port", () => {
    expect(vncExposure(SS_NO_VNC, 5900)).toBe("absent");
  });

  /** 5900 in a peer column or another port's address must not count. */
  test("does not match a port that merely contains the digits", () => {
    expect(vncExposure("LISTEN 0 5 127.0.0.1:15900 0.0.0.0:*\n", 5900)).toBe(
      "absent",
    );
  });

  test("ignores blank and short lines", () => {
    expect(vncExposure("\n\nLISTEN 0 5\n", 5900)).toBe("absent");
  });
});

describe("parseGeometry", () => {
  test("splits a normal geometry", () => {
    expect(parseGeometry("1600x900")).toEqual({ width: 1600, height: 900 });
  });

  test("tolerates surrounding space", () => {
    expect(parseGeometry(" 1920x1080 ")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  test.each(["", "1600", "1600*900", "x900", "1600x", "abcxdef", "16x9"])(
    "rejects %p",
    (bad) => {
      expect(parseGeometry(bad)).toBeNull();
    },
  );

  /** Shell metacharacters must never survive into an ExecStart line. */
  test("rejects anything with a shell metacharacter", () => {
    expect(parseGeometry("1600x900; rm -rf /")).toBeNull();
    expect(parseGeometry("1600x900 --foo")).toBeNull();
  });
});

describe("browserUnits", () => {
  const opts = defaultBrowserOptions("ubuntu", "/home/ubuntu");

  test("writes every unit the services list expects to enable", () => {
    const names = new Set(browserUnits(opts).map((u) => u.name));
    for (const service of browserServices(opts)) {
      expect(names.has(service)).toBe(true);
    }
  });

  test("binds VNC to loopback only", () => {
    const xvnc = browserUnits(opts).find(
      (u) => u.name === "vibe-os-xvnc.service",
    );
    expect(xvnc?.contents).toContain("-localhost");
    expect(xvnc?.contents).toContain("-rfbport 5900");
  });

  /**
   * The debug port is a shell-equivalent hole in the wrong hands: it can read
   * every cookie in the profile. It must never be told to accept a peer.
   */
  test("never opens the debug port beyond loopback", () => {
    const chrome = browserUnits(opts).find(
      (u) => u.name === "vibe-os-chrome.service",
    );
    expect(chrome?.contents).toContain("--remote-debugging-port=9222");
    expect(chrome?.contents).not.toContain("--remote-debugging-address");
  });

  test("never disables the sandbox", () => {
    for (const unit of browserUnits(opts)) {
      expect(unit.contents).not.toContain("--no-sandbox");
    }
  });

  test("runs as the given user, never root", () => {
    const chrome = browserUnits(opts).find(
      (u) => u.name === "vibe-os-chrome.service",
    );
    expect(chrome?.contents).toContain("User=ubuntu");
  });

  test("splits geometry into Chrome's two numbers", () => {
    const units = browserUnits({ ...opts, geometry: "1920x1080" });
    const chrome = units.find((u) => u.name === "vibe-os-chrome.service");
    expect(chrome?.contents).toContain("--window-size=1920,1080");
    const xvnc = units.find((u) => u.name === "vibe-os-xvnc.service");
    expect(xvnc?.contents).toContain("-geometry 1920x1080");
  });

  /**
   * systemd resolves ${...} itself and fails the whole unit on one it does not
   * know, which is how the first version of this broke: the geometry was left
   * for a shell that never ran.
   */
  test("leaves no shell-style expansion for systemd to choke on", () => {
    for (const unit of browserUnits(opts)) {
      expect(unit.contents).not.toMatch(/\$\{[A-Za-z_]/);
    }
  });

  test("a bad geometry throws instead of writing a unit that cannot start", () => {
    expect(() => browserUnits({ ...opts, geometry: "huge" })).toThrow();
  });

  test("the nightly timer carries a timezone", () => {
    const timer = browserUnits(opts).find(
      (u) => u.name === "vibe-os-chrome-restart.timer",
    );
    expect(timer?.contents).toContain("OnCalendar=");
    // A bare time would be evaluated as UTC, silently, and fire at the wrong hour.
    expect(timer?.contents).toMatch(/OnCalendar=.*[A-Za-z]+\/[A-Za-z_]+/);
  });

  test("no nightly restart means no timer and no service for it", () => {
    const units = browserUnits({ ...opts, restartAt: null });
    const names = units.map((u) => u.name);
    expect(names).not.toContain("vibe-os-chrome-restart.timer");
    expect(names).not.toContain("vibe-os-chrome-restart.service");
    expect(browserServices({ ...opts, restartAt: null })).not.toContain(
      "vibe-os-chrome-restart.timer",
    );
  });

  test("the profile directory is what Chrome is pointed at", () => {
    const units = browserUnits({
      ...opts,
      profileDir: "/var/lib/vibe-os/chrome",
    });
    const chrome = units.find((u) => u.name === "vibe-os-chrome.service");
    expect(chrome?.contents).toContain(
      "--user-data-dir=/var/lib/vibe-os/chrome",
    );
    expect(chrome?.contents).toContain("/var/lib/vibe-os/chrome/SingletonLock");
  });

  test("display number reaches every unit that needs it", () => {
    const units = browserUnits({ ...opts, display: 7 });
    const xvnc = units.find((u) => u.name === "vibe-os-xvnc.service");
    const wm = units.find((u) => u.name === "vibe-os-wm.service");
    const chrome = units.find((u) => u.name === "vibe-os-chrome.service");
    expect(xvnc?.contents).toContain("Xtigervnc :7 ");
    expect(xvnc?.contents).toContain("/tmp/.X7-lock");
    expect(wm?.contents).toContain("Environment=DISPLAY=:7");
    expect(chrome?.contents).toContain("Environment=DISPLAY=:7");
  });
});

describe("archSupported", () => {
  test("x64 only — Google ships no arm64 Chrome for Linux", () => {
    expect(archSupported("x64")).toBe(true);
    expect(archSupported("arm64")).toBe(false);
  });
});

/**
 * doctor is handed flags, never the unit file, so it has no other way to learn
 * what install-browser was told. Reading the generated units back is the point:
 * these two functions have to stay agreed, and a round trip is what proves it.
 */
describe("portsFromUnits", () => {
  const opts = defaultBrowserOptions("ubuntu", "/home/ubuntu");
  const unitText = (o: typeof opts, name: string) =>
    browserUnits(o).find((u) => u.name === name)?.contents ?? null;

  test("round-trips the defaults", () => {
    expect(
      portsFromUnits({
        xvnc: unitText(opts, "vibe-os-xvnc.service"),
        chrome: unitText(opts, "vibe-os-chrome.service"),
      }),
    ).toEqual({ vncPort: 5900, cdpPort: 9222 });
  });

  test("round-trips ports that are not the defaults", () => {
    const custom = { ...opts, vncPort: 5999, cdpPort: 9333 };
    expect(
      portsFromUnits({
        xvnc: unitText(custom, "vibe-os-xvnc.service"),
        chrome: unitText(custom, "vibe-os-chrome.service"),
      }),
    ).toEqual({ vncPort: 5999, cdpPort: 9333 });
  });

  test("falls back to the defaults when no unit is installed", () => {
    expect(portsFromUnits({ xvnc: null, chrome: null })).toEqual({
      vncPort: 5900,
      cdpPort: 9222,
    });
  });

  test("ignores a unit it cannot find the port in", () => {
    expect(portsFromUnits({ xvnc: "[Unit]\nDescription=x\n" })).toEqual({
      vncPort: 5900,
      cdpPort: 9222,
    });
  });
});

describe("parseMemInfo", () => {
  /** Verbatim from the VPS, before a swapfile was added. */
  const NO_SWAP = `MemTotal:        3910576 kB
MemFree:          425152 kB
MemAvailable:    2966420 kB
Buffers:           38208 kB
SwapCached:            0 kB
SwapTotal:             0 kB
SwapFree:              0 kB
`;

  const WITH_SWAP = NO_SWAP.replace(
    "SwapTotal:             0 kB",
    "SwapTotal:       2097148 kB",
  );

  test("reads total and swap", () => {
    expect(parseMemInfo(NO_SWAP)).toEqual({ totalKb: 3910576, swapKb: 0 });
    expect(parseMemInfo(WITH_SWAP)).toEqual({
      totalKb: 3910576,
      swapKb: 2097148,
    });
  });

  test("null when the file is not meminfo", () => {
    expect(parseMemInfo("")).toBeNull();
    expect(parseMemInfo("nothing useful\n")).toBeNull();
  });

  /** SwapCached and SwapFree both start with "Swap" and are not SwapTotal. */
  test("does not confuse SwapCached for SwapTotal", () => {
    expect(parseMemInfo(NO_SWAP)?.swapKb).toBe(0);
  });

  test("flags the box that has no headroom", () => {
    const bare = parseMemInfo(NO_SWAP);
    expect(bare).not.toBeNull();
    if (bare) expect(memoryHeadroom(bare).ok).toBe(false);

    const swapped = parseMemInfo(WITH_SWAP);
    expect(swapped).not.toBeNull();
    if (swapped) expect(memoryHeadroom(swapped).ok).toBe(true);
  });

  test("a large box passes without swap", () => {
    expect(memoryHeadroom({ totalKb: 16 * 1024 * 1024, swapKb: 0 }).ok).toBe(
      true,
    );
  });
});
