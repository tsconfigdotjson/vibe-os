import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { Server } from "bun";
import { Acme } from "./acme.ts";
import { createApi } from "./api.ts";
import { createGate, hostAllowed, hostName, originAllowed } from "./auth.ts";
import {
  type BridgeData,
  bridgeConnections,
  createBridgeHandlers,
} from "./bridge.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { discoverClaude, discoverCursor, discoverHermes } from "./harness.ts";
import { json } from "./http.ts";
import { color, describeError, log } from "./log.ts";
import { ensureWasm, ensureWebRoot } from "./preflight.ts";
import { scanProjects } from "./projects.ts";
import { windowCommand } from "./session.ts";
import {
  discoverHostKey,
  fingerprint,
  requireSshKeygen,
  SshCa,
} from "./ssh-ca.ts";
import { createStaticServer } from "./static.ts";
import { WallpaperStore } from "./wallpapers.ts";

const run = promisify(execFile);

export interface RunningServer {
  port: number;
  close: () => void;
}

/** Ceiling on an HTTP request body, sized for a wallpaper upload. */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/**
 * How long a request may go quiet before Bun hangs up, in seconds.
 *
 * Bun's default is 10, and it counts a request that is still being handled as
 * idle, not just a socket between requests. Creating a workspace fetches origin
 * before it branches, so on a large repo or a slow link the browser got
 * `ERR_EMPTY_RESPONSE` while the server carried on and made the workspace
 * anyway: the one thing here that is slow was the one thing that could not
 * finish. Bun's maximum, because the budget it has to cover is git's own
 * timeouts in projects.ts plus checking out a worktree at the end of them.
 */
const REQUEST_IDLE_TIMEOUT_S = 255;
/** Below this, binding needs root or CAP_NET_BIND_SERVICE. */
const FIRST_UNPRIVILEGED_PORT = 1024;
/** Where we land when port 80 is refused, so a first run still gets a URL. */
const UNPRIVILEGED_FALLBACK_PORT = 8080;

/**
 * The installable-app description Chrome reads before it will offer "Install".
 *
 * `display: standalone` is what drops the browser chrome; without the 192 and
 * 512 icons Chrome declines to offer installation at all. `id` is fixed so that
 * changing `start_url` later updates the installed app rather than creating a
 * second one beside it.
 */
function webManifest(themeColor: string) {
  return {
    id: "/",
    name: "vibe-os",
    short_name: "vibe-os",
    description: "A coding desktop in the browser, on a box you own.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0d1117",
    theme_color: themeColor,
    // PNGs only, and every one of them opaque. `icon.svg` is deliberately
    // absent: it has the rounded corners that suit a favicon and a README, and
    // an installer that fills transparency with white turns those into a white
    // border around a dark icon in the Dock.
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

const UNAUTHORISED_PAGE = `<!doctype html><meta charset="utf-8"><title>vibe-os</title>
<body style="font:14px ui-monospace,monospace;background:#07090d;color:#c8cedb;padding:2rem">
<h1 style="font-weight:600">vibe-os</h1>
<p>This server requires a token. Open the URL printed in the server log.</p></body>`;

/**
 * Addresses a browser can actually reach.
 *
 * `os.hostname()` is the tempting answer and the wrong one — on a VPS it is
 * usually something like "ubuntu-2gb-fsn1" that resolves nowhere, and in a
 * container it is a hex id. Interface addresses are what someone can type.
 */
function reachableHosts(config: Config): string[] {
  if (config.domain) return [config.domain];
  if (config.host !== "0.0.0.0" && config.host !== "::") return [config.host];

  const addresses: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === "IPv4" && !info.internal)
        addresses.push(info.address);
    }
  }
  return addresses.length > 0 ? addresses : [os.hostname()];
}

/**
 * This machine's name on the tailnet, if Tailscale is up.
 *
 * `tailscale serve` passes the browser's Host through, so behind it every
 * request names the box by its MagicDNS name, which nothing else here knows.
 */
async function tailscaleName(): Promise<string | null> {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], {
      timeout: 3_000,
    });
    const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self
      ?.DNSName;
    return name ? hostName(name) : null;
  } catch {
    return null;
  }
}

/**
 * Every name a request may use to reach this server when there is no token.
 *
 * Addresses and `localhost` need no listing; `hostAllowed` takes those as
 * given. A dotted name brings its first label too, since MagicDNS and most
 * LANs answer to the short form.
 */
async function knownHosts(config: Config): Promise<Set<string>> {
  const names = [
    os.hostname(),
    config.domain,
    config.sshAdvertise && hostName(config.sshAdvertise),
    await tailscaleName(),
    ...config.allowedHosts,
  ]
    .filter((n): n is string => Boolean(n))
    .map(hostName);
  return new Set(names.flatMap((n) => [n, n.split(".")[0]]));
}

function banner(
  config: Config,
  port: number,
  urls: string[],
  extras: string[],
): void {
  const line = color.dim("─".repeat(58));
  console.log("");
  console.log(
    `  ${color.bold(color.cyan("vibe-os"))} ${color.dim(`· ${os.hostname()}`)}`,
  );
  console.log(`  ${line}`);
  console.log(`  ${color.bold("open")}      ${color.cyan(urls[0])}`);
  for (const extra of urls.slice(1, 4))
    console.log(`            ${color.dim(extra)}`);
  console.log(
    `  ${color.dim("shell")}     ${config.user}@${config.sshHost}:${config.sshPort}`,
  );
  console.log(
    `  ${color.dim("windows")}   ${config.sessions ? "dtach-backed (survive reload)" : "plain login shell"}`,
  );
  for (const extra of extras) console.log(`  ${color.dim(extra)}`);
  console.log(`  ${line}`);

  if (!config.token) {
    console.log("");
    console.log(
      `  ${color.yellow("!")} ${color.bold("This server is unauthenticated.")}`,
    );
    console.log(
      `    Anyone who can reach ${color.bold(`${config.host}:${port}`)} gets a shell as ${color.bold(config.user)}.`,
    );
    console.log(
      `    Keep it on a private network, or restart with ${color.bold("--token")}.`,
    );
  }
  console.log("");
}

export async function startServer(config: Config): Promise<RunningServer> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await ensureWebRoot(config.webRoot);
  await ensureWasm(config.webRoot);
  await requireSshKeygen();

  // Certificate authority: created once, then trusted by sshd for this user.
  const ca = new SshCa(config.stateDir);
  await ca.ensure();
  const trust = await ca.trustInAuthorizedKeys(os.homedir());
  if (trust === "added") {
    log.ok(`added vibe-os CA to ${os.homedir()}/.ssh/authorized_keys`);
  } else {
    log.debug("vibe-os CA already trusted in authorized_keys");
  }

  const hostKey = await discoverHostKey(config.sshHost, config.sshPort);
  if (hostKey) {
    log.ok(
      `pinned host key ${fingerprint(hostKey)} for ${config.sshHost}:${config.sshPort}`,
    );
  } else {
    log.warn(
      "could not discover the SSH host key — the browser will ask you to confirm it on first connect",
    );
  }

  const wallpapers = new WallpaperStore(config.stateDir);
  await wallpapers.init();

  const db = openDb(config.stateDir);
  // Warm the project list before the first request so the picker is populated
  // on the very first page load rather than one poll later.
  await scanProjects(db, config);

  // Warmed here, deliberately not awaited: asking the Claude binary what it
  // supports costs a few seconds of its startup, and the answer is only needed
  // the first time someone opens the profile editor. Doing it now means it is
  // ready by then; doing it there would make the panel hang on first open.
  void discoverClaude();
  // Hermes is Python and answers three `config get` calls, so it is slower
  // still. Same reasoning, more of it.
  void discoverHermes();
  // Cursor asks its own service for the model list and login state, so this
  // one can wait on the network rather than a binary. Same reasoning again.
  void discoverCursor();

  const gate = createGate(config.token);
  // Only consulted without a token, so only worth the Tailscale probe then.
  const hosts = config.token ? new Set<string>() : await knownHosts(config);
  const serveStatic = createStaticServer(config.webRoot);
  const handleApi = createApi({ config, ca, hostKey, wallpapers, db });
  const bridge = createBridgeHandlers({
    host: config.sshHost,
    port: config.sshPort,
  });
  const acme = config.domain
    ? new Acme({
        domain: config.domain,
        email: config.acmeEmail,
        staging: config.acmeStaging,
        stateDir: config.stateDir,
      })
    : null;

  let tlsReady = false;

  const handle = async (
    req: Request,
    server: Server<BridgeData>,
    secure: boolean,
  ): Promise<Response | undefined> => {
    const url = new URL(req.url);

    // ACME challenges must answer on plain HTTP, unauthenticated, before any
    // redirect — Let's Encrypt will not follow a 302 to a cert we do not have.
    if (!secure && acme) {
      const challenge = acme.handleChallenge(url);
      if (challenge) return challenge;
    }

    if (!secure && tlsReady && config.domain) {
      return Response.redirect(
        `https://${config.domain}${url.pathname}${url.search}`,
        308,
      );
    }

    if (!originAllowed(req)) {
      log.warn(
        `rejected ${req.method} ${url.pathname} from origin ${req.headers.get("origin")}`,
      );
      return new Response("forbidden: cross-origin request\n", {
        status: 403,
      });
    }
    if (!config.token && !hostAllowed(req, hosts)) {
      const name = hostName(req.headers.get("host") ?? "");
      log.warn(
        `rejected a request for host ${JSON.stringify(name)}; if that is this server, add --allowed-host ${name}`,
      );
      return new Response(
        `forbidden: this server does not answer to ${name}\n` +
          `If it should, restart it with --allowed-host ${name}, or with a token.\n`,
        { status: 403 },
      );
    }

    const redirect = gate.consumeTokenParam(req, url, secure);
    if (redirect) return redirect;

    const denied = gate.check(req);

    if (url.pathname === "/websocket") {
      if (denied) return new Response("unauthorized", { status: 401 });
      if (bridge.atCapacity())
        return new Response("too many connections", { status: 503 });

      const data: BridgeData = {
        socket: null,
        peer: server.requestIP(req)?.address ?? "?",
        closed: false,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    if (denied) {
      if (url.pathname.startsWith("/api/")) return json({ error: denied }, 401);
      return new Response(UNAUTHORISED_PAGE, {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Generated rather than a file in public/, because the theme colour is
    // configurable and the whole point of that is telling two installed
    // instances apart.
    if (url.pathname === "/manifest.webmanifest") {
      return Response.json(webManifest(config.themeColor), {
        headers: {
          "content-type": "application/manifest+json",
          // Cheap to fetch and it changes with a flag, so never cache it.
          "cache-control": "no-store",
        },
      });
    }

    const api = await handleApi(req, url);
    if (api) return api;

    const asset = await serveStatic(req, url.pathname);
    if (asset) return asset;

    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

  const makeServer = (
    port: number,
    secure: boolean,
    tls?: { key: string; cert: string },
  ): Server<BridgeData> =>
    Bun.serve<BridgeData>({
      port,
      hostname: config.host,
      ...(tls ? { tls } : {}),
      // Wallpaper uploads are the largest body any route accepts, and this is
      // the ceiling before per-route checks see it. WebSocket framing is a
      // different knob entirely — that is `backpressureLimit` in bridge.ts.
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      idleTimeout: REQUEST_IDLE_TIMEOUT_S,
      development: false,
      async fetch(req, server) {
        try {
          return (await handle(req, server, secure)) as Response;
        } catch (err) {
          log.error(`request failed: ${describeError(err)}`);
          return new Response("internal error\n", { status: 500 });
        }
      },
      websocket: bridge.handlers,
    });

  /**
   * Binds the requested port, falling back rather than dying.
   *
   * Port 80 needs root or CAP_NET_BIND_SERVICE, and on a fresh VPS the user is
   * usually root so it just works. When it does not, exiting with EACCES is a
   * bad experience — come up somewhere reachable and say how to fix it.
   */
  let httpServer: Server<BridgeData>;
  let port = config.port;
  try {
    httpServer = makeServer(config.port, false);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      (code !== "EACCES" && code !== "EPERM") ||
      config.port >= FIRST_UNPRIVILEGED_PORT
    )
      throw err;

    log.warn(
      `cannot bind port ${config.port} as ${os.userInfo().username} (needs root or CAP_NET_BIND_SERVICE)`,
    );
    log.warn(
      `  grant it once:   sudo setcap 'cap_net_bind_service=+ep' $(readlink -f "$(which bun)")`,
    );
    log.warn("  or install the service:   sudo vibe-os install-service");
    port = UNPRIVILEGED_FALLBACK_PORT;
    httpServer = makeServer(port, false);
    log.warn(`listening on ${port} instead of ${config.port}`);
  }

  let httpsServer: Server<BridgeData> | undefined;
  let stopRenewal: (() => void) | undefined;
  const extras: string[] = [];

  if (acme && config.domain) {
    try {
      const material = await acme.obtain();
      httpsServer = makeServer(config.tlsPort, true, material);
      tlsReady = true;
      extras.push(`http://${config.domain} redirects to https`);
      // Certificates last 90 days and this process is meant to run for longer,
      // so expiry has to be re-checked while it runs, not only at boot.
      stopRenewal = acme.watch((renewed) => {
        httpsServer?.stop(true);
        httpsServer = makeServer(config.tlsPort, true, renewed);
        log.ok(`TLS certificate renewed for ${config.domain}`);
      });
    } catch (err) {
      log.error(`TLS setup failed: ${describeError(err)}`);
      log.warn(`continuing on plain HTTP at port ${port}`);
    }
  }

  const query = config.token ? `?token=${config.token}` : "";
  const urls = tlsReady
    ? [
        `https://${config.domain}${config.tlsPort === 443 ? "" : `:${config.tlsPort}`}/${query}`,
      ]
    : reachableHosts(config).map(
        (h) => `http://${h}${port === 80 ? "" : `:${port}`}/${query}`,
      );

  const sample = windowCommand(
    "vibe-<workspace>-1",
    "<worktree>",
    config,
    null,
    { forDisplay: true },
  );
  if (sample) extras.push(`each window runs: ${sample}`);
  extras.push(`state: ${config.stateDir}`);
  extras.push(`runtime: bun ${Bun.version}`);

  banner(config, port, urls, extras);

  return {
    port,
    close() {
      stopRenewal?.();
      httpServer.stop(true);
      httpsServer?.stop(true);
      log.info(`stopped (${bridgeConnections()} bridge connections were open)`);
    },
  };
}
