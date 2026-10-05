// The one browser.
//
// A single Google Chrome, on a virtual display, running for as long as the box
// does. It exists so a browser extension — Claude in Chrome is the one this was
// built for — has somewhere to live on a machine with no screen, and so you can
// take that browser over from anywhere rather than from one laptop.
//
// Three processes, in a chain, because each needs the one before it:
//
//     Xtigervnc :99      an X server whose framebuffer is also a VNC server
//        └── openbox     a window manager
//            └── chrome  the browser itself
//
// ── Why an X server with VNC built in ────────────────────────────────────────
// The usual recipe is Xvfb plus x11vnc. Xtigervnc is both in one process, which
// removes a daemon and a failure mode, and it resizes the framebuffer on a
// client's request, which Xvfb cannot do without an xrandr dance.
//
// ── Why a window manager ─────────────────────────────────────────────────────
// Without one, nothing can move, resize or stack a window, and every dialog
// Chrome opens outside its own frame lands at 0,0 undecorated.
//
// ── Why not headless, or CDP screencasting ───────────────────────────────────
// Chrome's remote debugging protocol can stream the page and take clicks back,
// with no X server at all. It captures the *page* though, and an extension's
// side panel, toolbar and popups are browser UI, not page content. The whole
// point here is that browser UI, so pixels from a real display are the only
// thing that answers.
//
// The debug port is still opened, on loopback. Not for the view — for the
// watchdog, which is the only cheap way to tell a wedged browser from a
// healthy one.

import os from "node:os";

/** Google publishes no arm64 Linux build of Chrome, and Chromium is not it. */
export const BROWSER_ARCH = "x64";

export interface BrowserOptions {
  /** The unix user the browser runs as. Never root: Chrome refuses. */
  user: string;
  home: string;
  /** X display number. 99 by convention, to stay clear of a real session. */
  display: number;
  geometry: string;
  vncPort: number;
  cdpPort: number;
  /**
   * A systemd OnCalendar expression, or null for no nightly restart.
   *
   * Include the timezone: systemd evaluates a bare time in UTC, and "2am" is
   * being asked for in somebody's actual timezone.
   */
  restartAt: string | null;
  /** Where Chrome's profile lives. Losing it means signing in again. */
  profileDir: string;
  /**
   * A TigerVNC password file, or null for no authentication at all.
   *
   * Null is the default and is not the hole it reads as: the display listens on
   * loopback, so SSH is the authentication step, and anyone who can open that
   * tunnel has a shell here anyway.
   *
   * It is set for one reason. macOS Screen Sharing refuses a server offering no
   * authentication and asks for a password that does not exist, so a box driven
   * from a Mac needs VncAuth to be reachable at all. VNC authentication is
   * DES-based and truncates at 8 characters, which makes it a second layer
   * behind SSH and never the thing keeping the box shut.
   */
  vncPasswordFile: string | null;
}

export const DEFAULT_DISPLAY = 99;
export const DEFAULT_GEOMETRY = "1600x900";
export const DEFAULT_VNC_PORT = 5900;
export const DEFAULT_CDP_PORT = 9222;
/**
 * 2am in the box's own timezone, written out by name. systemd would read a bare
 * time the same way, but naming the zone puts it in the unit and in the install
 * summary, where someone whose night is not the box's can see to change it.
 */
export const defaultRestartAt = () =>
  `*-*-* 02:00:00 ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

/** VNC authentication truncates silently past this, so generate exactly this. */
export const VNC_PASSWORD_LENGTH = 8;

export const vncPasswordPath = (home: string) => `${home}/.vibe-os/vncpasswd`;

export function defaultBrowserOptions(
  user: string,
  home: string,
): BrowserOptions {
  return {
    user,
    home,
    display: DEFAULT_DISPLAY,
    geometry: DEFAULT_GEOMETRY,
    vncPort: DEFAULT_VNC_PORT,
    cdpPort: DEFAULT_CDP_PORT,
    restartAt: defaultRestartAt(),
    profileDir: `${home}/.vibe-os/chrome`,
    vncPasswordFile: null,
  };
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Splits "1600x900".
 *
 * Chrome wants the two numbers separately for --window-size, and a geometry
 * that reaches the unit file malformed is a service that fails to start on
 * every boot rather than an error anyone sees.
 */
export function parseGeometry(geometry: string): Size | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(geometry.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240) return null;
  return { width, height };
}

export type VncExposure = "loopback" | "exposed" | "absent";

/**
 * Where the VNC port is listening, from `ss -ltnH`.
 *
 * This matters more than it looks. The display is served with no VNC password,
 * on the argument that only loopback can reach it and anything on loopback
 * already has a shell. Bound to a real interface, that same argument becomes an
 * unauthenticated desktop, signed in to Claude, for anyone who can route to the
 * box. So the check is not "is VNC running" but "is it only on loopback".
 */
export function vncExposure(ssOutput: string, port: number): VncExposure {
  let found = false;
  for (const line of ssOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // ss -ltnH columns: State Recv-Q Send-Q Local:Port Peer:Port
    const local = fields[3];
    if (!local) continue;
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    if (Number(local.slice(colon + 1)) !== port) continue;
    found = true;
    // Strip the brackets of an IPv6 literal and the %iface of a scoped address.
    const addr = local
      .slice(0, colon)
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .replace(/%.*$/, "");
    const loopback = addr === "::1" || /^127\./.test(addr);
    if (!loopback) return "exposed";
  }
  return found ? "loopback" : "absent";
}

export interface Unit {
  name: string;
  contents: string;
}

/**
 * Where the units are written, named once.
 *
 * `install-browser` writes them and three readers go looking: doctor, the Hermes
 * discovery in `harness.ts`, and `connect-hermes`. They had a path literal each
 * until the third one wanted the same file, which is one copy past the point
 * where they can be trusted to stay in step.
 */
export const UNIT_DIR = "/etc/systemd/system";
export const CHROME_UNIT_PATH = `${UNIT_DIR}/vibe-os-chrome.service`;
export const XVNC_UNIT_PATH = `${UNIT_DIR}/vibe-os-xvnc.service`;

/**
 * The units, in the order they must be written.
 *
 * Returned rather than written so the shape can be tested without a machine to
 * install onto, and so `install-browser` has one place to look for what it is
 * about to put in /etc.
 */
export function browserUnits(opts: BrowserOptions): Unit[] {
  const size = parseGeometry(opts.geometry);
  if (!size) throw new Error(`unusable geometry: ${opts.geometry}`);

  const d = opts.display;
  const security = opts.vncPasswordFile
    ? `-SecurityTypes VncAuth -PasswordFile ${opts.vncPasswordFile}`
    : "-SecurityTypes None";
  const units: Unit[] = [
    {
      name: "vibe-os-xvnc.service",
      contents: `[Unit]
Description=vibe-os virtual display (TigerVNC on :${d})
After=network.target

[Service]
Type=simple
User=${opts.user}
# A killed X server leaves these behind, and the next start refuses the display
# number rather than reusing it. Leading '-' so a first run does not fail here.
ExecStartPre=-/bin/rm -f /tmp/.X${d}-lock /tmp/.X11-unix/X${d}
ExecStart=/usr/bin/Xtigervnc :${d} -geometry ${opts.geometry} -depth 24 \\
  -localhost ${security} -rfbport ${opts.vncPort} -AlwaysShared
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`,
    },
    {
      name: "vibe-os-wm.service",
      contents: `[Unit]
Description=vibe-os window manager (openbox)
Requires=vibe-os-xvnc.service
After=vibe-os-xvnc.service

[Service]
Type=simple
User=${opts.user}
Environment=DISPLAY=:${d}
# After= orders the start and nothing more: it does not wait for the X server to
# begin accepting clients, and openbox exits immediately if it cannot connect.
ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do /usr/bin/xdpyinfo >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1'
ExecStart=/usr/bin/openbox
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`,
    },
    {
      name: "vibe-os-chrome.service",
      contents: `[Unit]
Description=vibe-os browser (Google Chrome)
Requires=vibe-os-wm.service
After=vibe-os-wm.service

[Service]
Type=simple
User=${opts.user}
Environment=DISPLAY=:${d}
Environment=HOME=${opts.home}
# systemd owns the singleton, so a lock left behind by a killed Chrome is always
# stale, and leaving it there costs a start.
ExecStartPre=-/bin/rm -f ${opts.profileDir}/SingletonLock ${opts.profileDir}/SingletonSocket ${opts.profileDir}/SingletonCookie
ExecStart=/usr/bin/google-chrome \\
  --user-data-dir=${opts.profileDir} \\
  --no-first-run --no-default-browser-check \\
  --hide-crash-restore-bubble --disable-session-crashed-bubble \\
  --password-store=basic \\
  --remote-debugging-port=${opts.cdpPort} \\
  --window-position=0,0 --window-size=${size.width},${size.height} \\
  about:blank
Restart=always
RestartSec=5
# Chrome is the main process, deliberately. Wrapping it in dbus-run-session puts
# something else there instead, and that wrapper does not pass SIGTERM on, so
# every stop became a 20-second timeout and a SIGKILL.
#
# Chrome still records exit_type "Crashed" on a SIGTERM stop — it writes
# "Normal" only when quit from its own menu — which is why both crash-restore
# flags above are set rather than trusted to be unnecessary.
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`,
    },
    {
      // Restart=always covers a browser that died. It cannot see one that is
      // running and wedged, which is the failure that actually strands you,
      // because the window keeps rendering whatever it last painted.
      name: "vibe-os-chrome-watchdog.service",
      contents: `[Unit]
Description=vibe-os browser liveness probe

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'curl -sf --max-time 5 http://127.0.0.1:${opts.cdpPort}/json/version >/dev/null || { echo "chrome not answering CDP, restarting"; systemctl restart vibe-os-chrome.service; }'
`,
    },
    {
      name: "vibe-os-chrome-watchdog.timer",
      contents: `[Unit]
Description=probe the vibe-os browser every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
`,
    },
  ];

  if (opts.restartAt) {
    units.push(
      {
        // A restart, not a tab sweep: it returns the memory a day of browsing
        // took as well as the tabs, and the profile carries the sign-in across.
        name: "vibe-os-chrome-restart.service",
        contents: `[Unit]
Description=vibe-os nightly browser restart

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart vibe-os-chrome.service
`,
      },
      {
        name: "vibe-os-chrome-restart.timer",
        contents: `[Unit]
Description=bounce the vibe-os browser nightly

[Timer]
OnCalendar=${opts.restartAt}
# The point is a clean start each night, not catching up on a missed one.
Persistent=false

[Install]
WantedBy=timers.target
`,
      },
    );
  }

  return units;
}

/** The units that should be enabled, in dependency order. */
export function browserServices(opts: BrowserOptions): string[] {
  return [
    "vibe-os-xvnc.service",
    "vibe-os-wm.service",
    "vibe-os-chrome.service",
    "vibe-os-chrome-watchdog.timer",
    ...(opts.restartAt ? ["vibe-os-chrome-restart.timer"] : []),
  ];
}

/**
 * The commands this box is missing.
 *
 * Named separately from the doctor checks because install-browser needs the
 * same answer before it writes a unit that could never start.
 */
export const BROWSER_COMMANDS = [
  {
    command: "Xtigervnc",
    package: "tigervnc-standalone-server",
    why: "the virtual display",
  },
  { command: "openbox", package: "openbox", why: "the window manager" },
  {
    command: "xdpyinfo",
    package: "x11-utils",
    why: "waiting for the display to accept clients",
  },
  {
    command: "google-chrome",
    package: "google-chrome-stable",
    why: "the browser itself",
  },
] as const;

/**
 * Whether this machine could run the browser at all.
 *
 * Chrome for Linux is x86_64 only. Saying so here beats an install that writes
 * five units and then fails to start one of them for a reason nothing explains.
 */
export function archSupported(arch: string = os.arch()): boolean {
  return arch === BROWSER_ARCH;
}

/**
 * The ports an installed unit actually uses.
 *
 * doctor is given flags, not a unit file, and it has no way to know what
 * install-browser was told months ago. Reading them back out of what is on
 * disk is the difference between checking the real ports and checking the
 * defaults while claiming to have checked the real ones.
 */
export function portsFromUnits(units: {
  xvnc?: string | null;
  chrome?: string | null;
}): { vncPort: number; cdpPort: number } {
  const rfb = units.xvnc ? /-rfbport\s+(\d{1,5})\b/.exec(units.xvnc) : null;
  const cdp = units.chrome
    ? /--remote-debugging-port=(\d{1,5})\b/.exec(units.chrome)
    : null;
  return {
    vncPort: rfb ? Number(rfb[1]) : DEFAULT_VNC_PORT,
    cdpPort: cdp ? Number(cdp[1]) : DEFAULT_CDP_PORT,
  };
}

/**
 * The password file an installed unit is already using, if any.
 *
 * Read before writing, so a reinstall cannot quietly turn authentication off on
 * a box that had it. Losing a setting you asked for is bad; losing it silently,
 * on the one command whose whole job is to rewrite these units, is worse.
 */
export function vncPasswordFileFromUnit(
  unit: string | null | undefined,
): string | null {
  if (!unit) return null;
  const match = /-PasswordFile\s+(\S+)/.exec(unit);
  return match ? match[1] : null;
}

/**
 * What Hermes has to be told so its browser tools drive this Chrome.
 *
 * Hermes reads its CDP target from `browser.cdp_url` in `~/.hermes/config.yaml`
 * and offers no flag for it, so this is set once for the box rather than per
 * profile. `browser-use` is named explicitly even though it is already the
 * default, because the default is conditional on the CLI being runnable and a
 * config that says what it means survives someone else reading it.
 *
 * `cloud_provider: local` is what stops a Browserbase or Firecrawl key, set
 * later for something else, from quietly taking the browser back.
 *
 * Returned as pairs rather than written here: they are handed to
 * `hermes config set`, which owns that file and knows where a secret goes.
 */
export function hermesBrowserSettings(
  cdpPort: number,
): { key: string; value: string }[] {
  return [
    { key: "browser.cdp_url", value: `http://127.0.0.1:${cdpPort}` },
    { key: "browser.backend", value: "browser-use" },
    { key: "browser.cloud_provider", value: "local" },
  ];
}

/**
 * Whether a configured `cdp_url` names this box's Chrome.
 *
 * Written by hand as often as by `connect-hermes`, so the comparison is on what
 * the URL means rather than on its spelling: `localhost` and `127.0.0.1` are the
 * same host, and `ws://` and `http://` are the same endpoint to a CDP client.
 * A bare `127.0.0.1:9222` is accepted too, because it is what people type.
 *
 * The port has to be explicit. A URL with no port is not a CDP endpoint that
 * would ever have worked, and inferring 80 from `http://` would report a
 * misconfigured box as connected.
 */
export function cdpUrlMatches(
  configured: string | null | undefined,
  cdpPort: number,
): boolean {
  const raw = configured?.trim();
  if (!raw) return false;
  // A scheme is optional in what people write but not in what URL will parse.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return false;
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) return false;
  if (url.port !== String(cdpPort)) return false;
  // Chrome binds the debug port to loopback, so anything else is a different
  // browser on a different machine and saying "connected" would be a guess.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export interface MemInfo {
  totalKb: number;
  swapKb: number;
}

/** MemTotal and SwapTotal out of /proc/meminfo. */
export function parseMemInfo(text: string): MemInfo | null {
  const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
  if (!total) return null;
  const swap = /^SwapTotal:\s+(\d+)\s+kB/m.exec(text);
  return {
    totalKb: Number(total[1]),
    swapKb: swap ? Number(swap[1]) : 0,
  };
}

/**
 * Whether Chrome has room to run here.
 *
 * Chrome idles around half a gigabyte and grows with every tab. On a small box
 * with no swap the first thing the OOM killer reaps is whatever it finds, which
 * presents as terminal sessions dying for no visible reason rather than as a
 * browser problem. Two gigabytes of headroom, counting swap, is the line.
 */
export function memoryHeadroom(mem: MemInfo): {
  ok: boolean;
  detail: string;
} {
  const gib = (kb: number) => (kb / 1024 / 1024).toFixed(1);
  const totalGib = `${gib(mem.totalKb)}GiB RAM`;
  const swapNote = mem.swapKb === 0 ? "no swap" : `${gib(mem.swapKb)}GiB swap`;
  const headroomKb = mem.totalKb + mem.swapKb;
  return {
    ok: headroomKb >= 4 * 1024 * 1024 || mem.swapKb > 0,
    detail: `${totalGib}, ${swapNote}`,
  };
}
