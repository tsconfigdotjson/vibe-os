import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { Server } from 'bun';

import type { Config } from './config.ts';
import { log, color } from './log.ts';
import { SshCa, discoverHostKey, fingerprint, requireSshKeygen } from './ssh-ca.ts';
import { createStaticServer } from './static.ts';
import { createApi } from './api.ts';
import { windowCommand } from './session.ts';
import { attachInfo, attachScript, publicOrigin, publicHost } from './attach.ts';
import { discoverClaude } from './harness.ts';
import { createBridgeHandlers, originAllowed, bridgeConnections, type BridgeData } from './bridge.ts';
import { createGate } from './auth.ts';
import { ensureWasm, ensureWebRoot } from './preflight.ts';
import { Acme } from './acme.ts';
import { WallpaperStore } from './wallpapers.ts';
import { openDb } from './db.ts';
import { scanProjects } from './projects.ts';

export interface RunningServer {
  port: number;
  close: () => void;
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
  if (config.host !== '0.0.0.0' && config.host !== '::') return [config.host];

  const addresses: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses.length > 0 ? addresses : [os.hostname()];
}

function banner(config: Config, port: number, urls: string[], extras: string[]): void {
  const line = color.dim('─'.repeat(58));
  console.log('');
  console.log(`  ${color.bold(color.cyan('vibe-os'))} ${color.dim(`· ${os.hostname()}`)}`);
  console.log(`  ${line}`);
  console.log(`  ${color.bold('open')}      ${color.cyan(urls[0])}`);
  for (const extra of urls.slice(1, 4)) console.log(`            ${color.dim(extra)}`);
  console.log(`  ${color.dim('shell')}     ${config.user}@${config.sshHost}:${config.sshPort}`);
  console.log(`  ${color.dim('windows')}   ${config.sessions ? 'dtach-backed (survive reload)' : 'plain login shell'}`);
  for (const extra of extras) console.log(`  ${color.dim(extra)}`);
  console.log(`  ${line}`);

  if (!config.token) {
    console.log('');
    console.log(`  ${color.yellow('!')} ${color.bold('This server is unauthenticated.')}`);
    console.log(
      `    Anyone who can reach ${color.bold(`${config.host}:${port}`)} gets a shell as ${color.bold(config.user)}.`,
    );
    console.log(`    Keep it on a private network, or restart with ${color.bold('--token')}.`);
  }
  console.log('');
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
  if (trust === 'added') {
    log.ok(`added vibe-os CA to ${os.homedir()}/.ssh/authorized_keys`);
  } else {
    log.debug('vibe-os CA already trusted in authorized_keys');
  }

  const hostKey = await discoverHostKey(config.sshHost, config.sshPort);
  if (hostKey) {
    log.ok(`pinned host key ${fingerprint(hostKey)} for ${config.sshHost}:${config.sshPort}`);
  } else {
    log.warn('could not discover the SSH host key — the browser will ask you to confirm it on first connect');
  }

  const wallpapers = new WallpaperStore(config.stateDir);
  await wallpapers.init();

  const db = openDb(config.stateDir);
  // Warm the project list before the first request so the picker is populated
  // on the very first page load rather than one poll later.
  await scanProjects(db, config, { force: true });

  // Warmed here, deliberately not awaited: asking the Claude binary what it
  // supports costs a few seconds of its startup, and the answer is only needed
  // the first time someone opens the profile editor. Doing it now means it is
  // ready by then; doing it there would make the panel hang on first open.
  void discoverClaude();

  const gate = createGate(config.token);
  const serveStatic = createStaticServer(config.webRoot);
  const handleApi = createApi({ config, ca, hostKey, wallpapers, db });
  const bridge = createBridgeHandlers({ host: config.sshHost, port: config.sshPort });
  const acme = config.domain
    ? new Acme({
        domain: config.domain,
        email: config.acmeEmail,
        staging: config.acmeStaging,
        stateDir: config.stateDir,
      })
    : null;

  let tlsReady = false;

  const handle = async (req: Request, server: Server<BridgeData>, secure: boolean): Promise<Response | undefined> => {
    const url = new URL(req.url);

    // ACME challenges must answer on plain HTTP, unauthenticated, before any
    // redirect — Let's Encrypt will not follow a 302 to a cert we do not have.
    if (!secure && acme) {
      const challenge = acme.handleChallenge(url);
      if (challenge) return challenge;
    }

    if (!secure && tlsReady && config.domain) {
      return Response.redirect(`https://${config.domain}${url.pathname}${url.search}`, 308);
    }

    /*
     * `/t/<ref>` — a URL you type into a terminal.
     *
     * It answers with a short shell script that execs `ssh -t … dtach …`, so
     * `sh -c "$(curl -sSL …/t/quiet-amber-otter-1)"` lands you in the session.
     * Everything is resolved here rather than on the far side, so the box needs
     * nothing installed for this to work — not even vibe-os on the PATH — and
     * the script is short enough to read before you run it.
     *
     * Its position is load-bearing at both ends. Ahead of `consumeTokenParam`,
     * because that answers a `?token=` by setting a cookie and redirecting,
     * which curl follows straight into a 401 — so this route checks the token
     * itself instead. And ahead of the static handler, because `/t/<ref>` has
     * no extension and the SPA fallback would otherwise hand a terminal
     * index.html to run.
     */
    const attach = /^\/t\/([^/]+)\/?$/.exec(url.pathname);
    if (attach && (req.method === 'GET' || req.method === 'HEAD')) {
      const text = (body: string, status = 200): Response =>
        new Response(req.method === 'HEAD' ? null : body, {
          status,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });

      if (gate.checkAllowingParam(req, url)) return text('# unauthorized\n', 401);
      if (!config.sessions) return text('# this server runs plain login shells (--no-sessions)\n', 409);

      const ref = decodeURIComponent(attach[1]);
      const info = attachInfo(db, config, ref, publicOrigin(req, url), publicHost(req, url));
      if (!info) return text(`# no such window: ${ref}\n`, 404);
      log.info(`handed out an attach command for ${info.session}`);
      return text(attachScript(info));
    }

    const redirect = gate.consumeTokenParam(url, secure);
    if (redirect) return redirect;

    const denied = gate.check(req);

    if (url.pathname === '/websocket') {
      if (!originAllowed(req)) {
        log.warn(`rejected cross-origin websocket upgrade from ${req.headers.get('origin')}`);
        return new Response('forbidden', { status: 403 });
      }
      if (denied) return new Response('unauthorized', { status: 401 });
      if (bridge.atCapacity()) return new Response('too many connections', { status: 503 });

      const data: BridgeData = {
        socket: null,
        peer: server.requestIP(req)?.address ?? '?',
        closed: false,
      };
      if (server.upgrade(req, { data })) return undefined;
      return new Response('websocket upgrade failed', { status: 400 });
    }

    if (denied) {
      if (url.pathname.startsWith('/api/')) return Response.json({ error: denied }, { status: 401 });
      return new Response(UNAUTHORISED_PAGE, {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const api = await handleApi(req, url);
    if (api) return api;

    const asset = await serveStatic(req, url.pathname);
    if (asset) return asset;

    return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  };

  const makeServer = (port: number, secure: boolean, tls?: { key: string; cert: string }): Server<BridgeData> =>
    Bun.serve<BridgeData>({
      port,
      hostname: config.host,
      ...(tls ? { tls } : {}),
      // Terminal output can be bursty; let a single frame carry a screenful.
      maxRequestBodySize: 32 * 1024 * 1024,
      development: false,
      async fetch(req, server) {
        try {
          return (await handle(req, server, secure)) as Response;
        } catch (err) {
          log.error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
          return new Response('internal error\n', { status: 500 });
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
    if ((code !== 'EACCES' && code !== 'EPERM') || config.port >= 1024) throw err;

    log.warn(`cannot bind port ${config.port} as ${os.userInfo().username} (needs root or CAP_NET_BIND_SERVICE)`);
    log.warn(`  grant it once:   sudo setcap 'cap_net_bind_service=+ep' $(readlink -f "$(which bun)")`);
    log.warn('  or install the service:   sudo vibe-os install-service');
    port = 8080;
    httpServer = makeServer(port, false);
    log.warn(`listening on ${port} instead of ${config.port}`);
  }

  let httpsServer: Server<BridgeData> | undefined;
  const extras: string[] = [];

  if (acme && config.domain) {
    try {
      const material = await acme.obtain();
      httpsServer = makeServer(config.tlsPort, true, material);
      tlsReady = true;
      extras.push(`http://${config.domain} redirects to https`);
    } catch (err) {
      log.error(`TLS setup failed: ${err instanceof Error ? err.message : String(err)}`);
      log.warn(`continuing on plain HTTP at port ${port}`);
    }
  }

  const query = config.token ? `?token=${config.token}` : '';
  const urls = tlsReady
    ? [`https://${config.domain}${config.tlsPort === 443 ? '' : `:${config.tlsPort}`}/${query}`]
    : reachableHosts(config).map((h) => `http://${h}${port === 80 ? '' : `:${port}`}/${query}`);

  const sample = windowCommand('vibe-<workspace>-1', '<worktree>', config);
  if (sample) extras.push(`each window runs: ${sample}`);
  extras.push(`state: ${config.stateDir}`);
  extras.push(`runtime: bun ${Bun.version}`);

  banner(config, port, urls, extras);

  return {
    port,
    close() {
      httpServer.stop(true);
      httpsServer?.stop(true);
      log.info(`stopped (${bridgeConnections()} bridge connections were open)`);
    },
  };
}
