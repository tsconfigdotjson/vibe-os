import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import type { SshCa } from './ssh-ca.js';
import { fingerprint } from './ssh-ca.js';
import { log } from './log.js';

const MAX_BODY = 16 * 1024;
const PANE_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface ClientConfig {
  version: string;
  hostname: string;
  user: string;
  workspace: string;
  tmux: boolean;
  authRequired: boolean;
  /** WebSocket endpoint, relative to the page so it follows http/https. */
  endpoint: { name: string; url: string };
  /** Host key to pin, or null to fall back to trust-on-first-use. */
  hostKey: string | null;
  hostKeyFingerprint: string | null;
  certificateEndpoint: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface ApiDeps {
  config: Config;
  ca: SshCa;
  hostKey: string | null;
}

/**
 * Builds the command each pane runs on login.
 *
 * `tmux new-session -A` attaches if the session exists and creates it
 * otherwise, which is exactly the reattach-or-start behaviour a pane needs: the
 * browser can reload, crash, or be closed for a day, and the Claude session on
 * the other side keeps running. `-u` forces UTF-8 because a fresh VPS often has
 * no locale set and tmux would otherwise draw its borders in ASCII.
 */
export function paneCommand(paneId: string, config: Config): string | undefined {
  if (!config.tmux) return undefined;
  return `tmux -u new-session -A -s vibe-${paneId}`;
}

export function createApi(deps: ApiDeps) {
  const { config, ca } = deps;
  const versionPromise = packageVersion();

  return async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false;

    if (url.pathname === '/api/health') {
      json(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      const body: ClientConfig = {
        version: await versionPromise,
        hostname: os.hostname(),
        user: config.user,
        workspace: config.workspace,
        tmux: config.tmux,
        authRequired: config.token !== null,
        endpoint: { name: 'local', url: './websocket' },
        hostKey: deps.hostKey,
        hostKeyFingerprint: deps.hostKey ? fingerprint(deps.hostKey) : null,
        certificateEndpoint: '/api/ssh/certificate',
      };
      json(res, 200, body);
      return true;
    }

    if (url.pathname === '/api/ssh/certificate') {
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' });
        return true;
      }

      const paneId = url.searchParams.get('pane') ?? 'default';
      if (!PANE_ID.test(paneId)) {
        json(res, 400, { error: 'invalid pane id' });
        return true;
      }
      const mode = url.searchParams.get('mode') ?? 'tmux';
      if (mode !== 'tmux' && mode !== 'shell') {
        json(res, 400, { error: 'invalid mode' });
        return true;
      }

      try {
        const publicKey = await readBody(req);
        const forceCommand = mode === 'tmux' ? paneCommand(paneId, config) : undefined;

        const cert = await ca.signUserCert({
          publicKey,
          principal: config.user,
          identity: `vibe-os/${paneId}`,
          forceCommand,
          ttlSeconds: config.certTtlSeconds,
        });

        log.info(
          `issued certificate for pane ${paneId} (${config.user}, ${Math.round(config.certTtlSeconds / 60)}m${forceCommand ? ', tmux' : ''})`,
        );

        // sshterm compares this header for exact equality against "text/plain".
        // Appending "; charset=utf-8" — which most frameworks do by default —
        // makes it reject the certificate with an opaque error.
        res.writeHead(200, {
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(cert),
          'cache-control': 'no-store',
        });
        res.end(cert);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`certificate request rejected: ${message}`);
        json(res, 400, { error: message });
      }
      return true;
    }

    json(res, 404, { error: 'not found' });
    return true;
  };
}
