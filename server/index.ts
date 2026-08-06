import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Config } from './config.js';
import { log, color } from './log.js';
import { SshCa, discoverHostKey, fingerprint, requireSshKeygen } from './ssh-ca.js';
import { createStaticServer } from './static.js';
import { createApi, paneCommand } from './api.js';
import { createBridge } from './bridge.js';
import { createGate } from './auth.js';
import { ensureWasm, ensureWebRoot } from './preflight.js';
import { Acme } from './acme.js';

export interface RunningServer {
  httpServer: Server;
  httpsServer?: https.Server;
  port: number;
  close: () => Promise<void>;
}

function listen(server: Server | https.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Binds the requested port, falling back rather than dying.
 *
 * Port 80 needs either root or CAP_NET_BIND_SERVICE, and on a fresh VPS the
 * user is usually root so it just works. When it does not, exiting with EACCES
 * is a bad experience — the useful thing is to come up somewhere reachable and
 * say exactly how to fix it.
 */
async function listenWithFallback(server: Server, config: Config): Promise<number> {
  try {
    await listen(server, config.port, config.host);
    return config.port;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' || config.port >= 1024) throw err;

    log.warn(`cannot bind port ${config.port} as ${os.userInfo().username} (needs root or CAP_NET_BIND_SERVICE)`);
    log.warn(`  grant it once:   sudo setcap 'cap_net_bind_service=+ep' $(readlink -f "$(which node)")`);
    log.warn('  or install the service:   sudo vibe-os install-service');

    const fallback = 8080;
    await listen(server, fallback, config.host);
    log.warn(`listening on ${fallback} instead of ${config.port}`);
    return fallback;
  }
}

function banner(config: Config, port: number, url: string, extras: string[]): void {
  const line = color.dim('─'.repeat(58));
  console.log('');
  console.log(`  ${color.bold(color.cyan('vibe-os'))} ${color.dim(`· ${os.hostname()}`)}`);
  console.log(`  ${line}`);
  console.log(`  ${color.bold('open')}      ${color.cyan(url)}`);
  console.log(`  ${color.dim('shell')}     ${config.user}@${config.sshHost}:${config.sshPort}`);
  console.log(`  ${color.dim('panes')}     ${config.tmux ? 'tmux-backed (survive reload)' : 'plain login shell'}`);
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

  const gate = createGate(config.token);
  const serveStatic = createStaticServer(config.webRoot);
  const handleApi = createApi({ config, ca, hostKey });
  const acme = config.domain
    ? new Acme({
        domain: config.domain,
        email: config.acmeEmail,
        staging: config.acmeStaging,
        stateDir: config.stateDir,
      })
    : null;

  let tlsReady = false;

  const handle = async (req: IncomingMessage, res: ServerResponse, secure: boolean): Promise<void> => {
    const url = new URL(req.url ?? '/', `http${secure ? 's' : ''}://${req.headers.host ?? 'localhost'}`);

    // ACME challenges must answer on plain HTTP, unauthenticated, before any
    // redirect — Let's Encrypt will not follow a 302 to a cert we do not have.
    if (!secure && acme?.handleChallenge(req, res, url)) return;

    if (!secure && tlsReady && config.domain) {
      res.writeHead(308, { location: `https://${config.domain}${url.pathname}${url.search}` }).end();
      return;
    }

    if (gate.consumeTokenParam(res, url, secure)) return;

    const denied = gate.check(req);
    if (denied) {
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: denied }));
      } else {
        res
          .writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
          .end('<!doctype html><meta charset="utf-8"><title>vibe-os</title><body style="font:14px ui-monospace,monospace;background:#0b0e14;color:#c5c9d4;padding:2rem"><h1>vibe-os</h1><p>This server requires a token. Open the URL printed in the server log.</p></body>');
      }
      return;
    }

    if (await handleApi(req, res, url)) return;
    if (await serveStatic(req, res, url.pathname)) return;

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
  };

  const wrap = (secure: boolean) => (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, secure).catch((err: unknown) => {
      log.error(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error\n');
    });
  };

  const httpServer = http.createServer(wrap(false));
  const port = await listenWithFallback(httpServer, config);

  const bridgeOptions = {
    target: { host: config.sshHost, port: config.sshPort },
    authorize: (req: IncomingMessage) => gate.check(req),
  };

  const attachUpgrade = (server: Server | https.Server) => {
    const bridge = createBridge(bridgeOptions);
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/websocket') {
        socket.destroy();
        return;
      }
      bridge.handleUpgrade(req, socket, head);
    });
    return bridge;
  };

  attachUpgrade(httpServer);

  let httpsServer: https.Server | undefined;
  const extras: string[] = [];

  if (acme && config.domain) {
    try {
      const material = await acme.obtain();
      httpsServer = https.createServer({ key: material.key, cert: material.cert }, wrap(true));
      attachUpgrade(httpsServer);
      await listen(httpsServer, config.tlsPort, config.host);
      tlsReady = true;
      extras.push(`http://${config.domain} redirects to https`);
    } catch (err) {
      log.error(`TLS setup failed: ${err instanceof Error ? err.message : String(err)}`);
      log.warn(`continuing on plain HTTP at port ${port}`);
    }
  }

  const displayHost = config.domain ?? (config.host === '0.0.0.0' || config.host === '::' ? os.hostname() : config.host);
  const url = tlsReady
    ? `https://${config.domain}${config.tlsPort === 443 ? '' : `:${config.tlsPort}`}/`
    : `http://${displayHost}${port === 80 ? '' : `:${port}`}/${config.token ? `?token=${config.token}` : ''}`;

  const sample = paneCommand('1', config);
  if (sample) extras.push(`each pane runs: ${sample}`);
  extras.push(`state: ${config.stateDir}`);

  banner(config, port, url, extras);

  return {
    httpServer,
    httpsServer,
    port,
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (httpsServer) await new Promise<void>((resolve) => httpsServer!.close(() => resolve()));
    },
  };
}
