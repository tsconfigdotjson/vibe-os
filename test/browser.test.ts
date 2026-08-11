import { describe, expect, test } from "bun:test";
import {
  archSupported,
  browserServices,
  browserUnits,
  cdpUrlMatches,
  defaultBrowserOptions,
  hermesBrowserSettings,
  memoryHeadroom,
  parseGeometry,
  parseMemInfo,
  portsFromUnits,
  VNC_PASSWORD_LENGTH,
  vncExposure,
  vncPasswordFileFromUnit,
  vncPasswordPath,
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

/**
 * macOS Screen Sharing refuses a server offering no authentication and asks for
 * a password that does not exist, which is the only reason VncAuth is here.
 */
describe("VNC authentication", () => {
  const opts = defaultBrowserOptions("ubuntu", "/home/ubuntu");
  const xvnc = (o: typeof opts) =>
    browserUnits(o).find((u) => u.name === "vibe-os-xvnc.service")?.contents ??
    "";

  test("no password file means no authentication", () => {
    const unit = xvnc(opts);
    expect(unit).toContain("-SecurityTypes None");
    expect(unit).not.toContain("-PasswordFile");
  });

  test("a password file switches the unit to VncAuth", () => {
    const unit = xvnc({
      ...opts,
      vncPasswordFile: "/home/ubuntu/.vibe-os/vncpasswd",
    });
    expect(unit).toContain(
      "-SecurityTypes VncAuth -PasswordFile /home/ubuntu/.vibe-os/vncpasswd",
    );
    expect(unit).not.toContain("-SecurityTypes None");
  });

  /** Authentication is a second layer. It never replaces the loopback bind. */
  test("keeps the loopback bind either way", () => {
    expect(xvnc(opts)).toContain("-localhost");
    expect(xvnc({ ...opts, vncPasswordFile: "/x/y" })).toContain("-localhost");
  });

  test("the password path is under the state directory", () => {
    expect(vncPasswordPath("/home/ubuntu")).toBe(
      "/home/ubuntu/.vibe-os/vncpasswd",
    );
  });

  test("VNC truncates past eight, so that is what is generated", () => {
    expect(VNC_PASSWORD_LENGTH).toBe(8);
  });

  /**
   * install-browser rewrites every unit, so this round trip is what stops a
   * reinstall from silently turning authentication back off.
   */
  describe("vncPasswordFileFromUnit", () => {
    test("reads back the file a generated unit uses", () => {
      const file = "/home/ubuntu/.vibe-os/vncpasswd";
      expect(
        vncPasswordFileFromUnit(xvnc({ ...opts, vncPasswordFile: file })),
      ).toBe(file);
    });

    test("null for a unit with no authentication", () => {
      expect(vncPasswordFileFromUnit(xvnc(opts))).toBeNull();
    });

    test("null when there is no unit at all", () => {
      expect(vncPasswordFileFromUnit(null)).toBeNull();
      expect(vncPasswordFileFromUnit(undefined)).toBeNull();
      expect(vncPasswordFileFromUnit("")).toBeNull();
    });

    /** The hand-edited unit that was on the VPS before this flag existed. */
    test("reads a path out of a unit written by hand", () => {
      const handEdited =
        "ExecStart=/usr/bin/Xtigervnc :99 -geometry 1600x900 -depth 24 \\\n" +
        "  -localhost -SecurityTypes VncAuth -PasswordFile /home/ubuntu/.vibe-os/vncpasswd -rfbport 5900 -AlwaysShared\n";
      expect(vncPasswordFileFromUnit(handEdited)).toBe(
        "/home/ubuntu/.vibe-os/vncpasswd",
      );
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

/**
 * The Hermes side of the browser: what it is told, and whether it took.
 *
 * `connect-hermes` writes these and doctor reads them back, so a disagreement
 * between the two shows up as a box that says it is wired when it is not.
 */
describe("hermesBrowserSettings", () => {
  test("names the port it was given", () => {
    const settings = hermesBrowserSettings(9223);
    expect(settings).toContainEqual({
      key: "browser.cdp_url",
      value: "http://127.0.0.1:9223",
    });
  });

  /** Browser Use mode is the default, but only when the CLI happens to run. */
  test("forces browser-use rather than relying on the default", () => {
    expect(hermesBrowserSettings(9222)).toContainEqual({
      key: "browser.backend",
      value: "browser-use",
    });
  });

  /** What stops a cloud key set later from quietly taking the browser back. */
  test("pins the provider to local", () => {
    expect(hermesBrowserSettings(9222)).toContainEqual({
      key: "browser.cloud_provider",
      value: "local",
    });
  });

  /** Everything written here has to be readable back as connected. */
  test("what it writes is what cdpUrlMatches accepts", () => {
    const url = hermesBrowserSettings(9222).find(
      (s) => s.key === "browser.cdp_url",
    )?.value;
    expect(cdpUrlMatches(url, 9222)).toBe(true);
  });
});

describe("cdpUrlMatches", () => {
  test("the url connect-hermes writes", () => {
    expect(cdpUrlMatches("http://127.0.0.1:9222", 9222)).toBe(true);
  });

  /** Same host, and the form people type by hand. */
  test("localhost is 127.0.0.1", () => {
    expect(cdpUrlMatches("http://localhost:9222", 9222)).toBe(true);
  });

  /** `/browser connect ws://host:port` is the documented spelling. */
  test("a websocket url is the same endpoint", () => {
    expect(cdpUrlMatches("ws://127.0.0.1:9222", 9222)).toBe(true);
  });

  test("a trailing slash makes no difference", () => {
    expect(cdpUrlMatches("http://127.0.0.1:9222/", 9222)).toBe(true);
  });

  test("surrounding whitespace makes no difference", () => {
    expect(cdpUrlMatches("  http://127.0.0.1:9222  ", 9222)).toBe(true);
  });

  test("no scheme is still an endpoint", () => {
    expect(cdpUrlMatches("127.0.0.1:9222", 9222)).toBe(true);
  });

  test("the ipv6 loopback literal", () => {
    expect(cdpUrlMatches("http://[::1]:9222", 9222)).toBe(true);
  });

  test("a different port is a different browser", () => {
    expect(cdpUrlMatches("http://127.0.0.1:9223", 9222)).toBe(false);
  });

  /**
   * Chrome binds the debug port to loopback, so a routable address is some
   * other machine's browser. Reporting that as connected would be a guess.
   */
  test("another host is not this box", () => {
    expect(cdpUrlMatches("http://10.0.0.4:9222", 9222)).toBe(false);
  });

  /**
   * A URL with no port never worked as a CDP endpoint. Inferring 80 from the
   * scheme would report a misconfigured box as connected.
   */
  test("no port is not a match", () => {
    expect(cdpUrlMatches("http://127.0.0.1", 9222)).toBe(false);
  });

  test("nothing configured is not a match", () => {
    expect(cdpUrlMatches(null, 9222)).toBe(false);
    expect(cdpUrlMatches(undefined, 9222)).toBe(false);
    expect(cdpUrlMatches("", 9222)).toBe(false);
    expect(cdpUrlMatches("   ", 9222)).toBe(false);
  });

  test("nonsense is not a match", () => {
    expect(cdpUrlMatches("not a url", 9222)).toBe(false);
    expect(cdpUrlMatches("http://:9222", 9222)).toBe(false);
  });

  /** A port that merely contains the digits is a different port. */
  test("does not match on a substring of the port", () => {
    expect(cdpUrlMatches("http://127.0.0.1:19222", 9222)).toBe(false);
    expect(cdpUrlMatches("http://127.0.0.1:92220", 9222)).toBe(false);
  });

  /** file:// and friends are not endpoints, whatever the rest of it says. */
  test("an unusable scheme is not a match", () => {
    expect(cdpUrlMatches("file://127.0.0.1:9222", 9222)).toBe(false);
  });
});
