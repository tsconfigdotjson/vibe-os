import os from 'node:os';
import type { Config } from './config.ts';
import type { SshCa } from './ssh-ca.ts';
import { fingerprint } from './ssh-ca.ts';
import { WallpaperStore, MAX_WALLPAPER_BYTES, type DesktopPrefs } from './wallpapers.ts';
import { log } from './log.ts';
import pkg from '../package.json' with { type: 'json' };

const PANE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_PUBKEY_BYTES = 16 * 1024;

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
  maxWallpaperBytes: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Builds the command each window runs on login.
 *
 * `tmux new-session -A` attaches if the session exists and creates it
 * otherwise, which is exactly the reattach-or-start behaviour a window needs:
 * the browser can reload, crash, or be closed for a day, and whatever was
 * running is still there. `-u` forces UTF-8 because a fresh VPS often has no
 * locale set and tmux would otherwise draw its borders in ASCII.
 */
export function paneCommand(paneId: string, config: Config): string | undefined {
  if (!config.tmux) return undefined;
  const attach = `tmux -u new-session -A -s vibe-${paneId}`;
  if (!config.tmuxTheme) return attach;

  // Match tmux's status bar to the desktop chrome. tmux's default is a solid
  // green bar that fights every other colour on screen.
  //
  // These are session options, not global (`set -g`) ones: a vibe-os window
  // should not restyle tmux sessions the user started themselves, and they
  // share one tmux server. The `\;` reaches tmux as a literal separator after
  // the login shell has parsed the command.
  const style = [
    'set status-style "bg=#10141c fg=#9aa3b6"',
    'set status-left-style "fg=#56cfe1 bold"',
    'set window-status-current-style "fg=#dfe5f0 bold"',
    'set pane-border-style "fg=#1b2230"',
    'set pane-active-border-style "fg=#56cfe1"',
    'set status-right "#[fg=#667085]#H"',
  ].join(' \\; ');
  return `${attach} \\; ${style}`;
}

export interface ApiDeps {
  config: Config;
  ca: SshCa;
  hostKey: string | null;
  wallpapers: WallpaperStore;
}

export function createApi(deps: ApiDeps) {
  const { config, ca, wallpapers } = deps;

  return async function handleApi(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    if (!p.startsWith('/api/')) return null;

    if (p === '/api/health') return json({ ok: true });

    if (p === '/api/config' && req.method === 'GET') {
      const body: ClientConfig = {
        version: pkg.version,
        hostname: os.hostname(),
        user: config.user,
        workspace: config.workspace,
        tmux: config.tmux,
        authRequired: config.token !== null,
        endpoint: { name: 'local', url: './websocket' },
        hostKey: deps.hostKey,
        hostKeyFingerprint: deps.hostKey ? fingerprint(deps.hostKey) : null,
        certificateEndpoint: '/api/ssh/certificate',
        maxWallpaperBytes: MAX_WALLPAPER_BYTES,
      };
      return json(body);
    }

    // ── certificates ─────────────────────────────────────────────────────────
    if (p === '/api/ssh/certificate') {
      if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

      const paneId = url.searchParams.get('pane') ?? 'default';
      if (!PANE_ID.test(paneId)) return json({ error: 'invalid pane id' }, 400);
      const mode = url.searchParams.get('mode') ?? 'tmux';
      if (mode !== 'tmux' && mode !== 'shell') return json({ error: 'invalid mode' }, 400);

      // Check the declared length before buffering: the server allows large
      // bodies for wallpaper uploads, and there is no reason to hold 32MB in
      // memory just to reject it as a public key.
      if (Number(req.headers.get('content-length') ?? 0) > MAX_PUBKEY_BYTES) {
        return json({ error: 'public key too large' }, 413);
      }

      try {
        const publicKey = await req.text();
        if (publicKey.length > MAX_PUBKEY_BYTES) throw new Error('public key too large');

        const forceCommand = mode === 'tmux' ? paneCommand(paneId, config) : undefined;
        const cert = await ca.signUserCert({
          publicKey,
          principal: config.user,
          identity: `vibe-os/${paneId}`,
          forceCommand,
          ttlSeconds: config.certTtlSeconds,
        });

        log.info(
          `issued certificate for ${paneId} (${config.user}, ${Math.round(config.certTtlSeconds / 60)}m${forceCommand ? ', tmux' : ''})`,
        );

        // sshterm compares this header for exact equality against "text/plain".
        // Appending "; charset=utf-8" — which most frameworks do by default —
        // makes it reject the certificate with an opaque error.
        return new Response(cert, {
          status: 200,
          headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`certificate request rejected: ${message}`);
        return json({ error: message }, 400);
      }
    }

    // ── desktop preferences ──────────────────────────────────────────────────
    if (p === '/api/desktop') {
      if (req.method === 'GET') return json(await wallpapers.prefs());
      if (req.method === 'PUT') {
        try {
          const body = (await req.json()) as DesktopPrefs;
          return json(await wallpapers.setPrefs(body));
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      return json({ error: 'method not allowed' }, 405);
    }

    // ── wallpapers ───────────────────────────────────────────────────────────
    if (p === '/api/wallpapers') {
      if (req.method === 'GET') return json(await wallpapers.list());

      if (req.method === 'POST') {
        const declared = Number(req.headers.get('content-length') ?? 0);
        if (declared > MAX_WALLPAPER_BYTES) {
          return json({ error: 'image too large' }, 413);
        }
        try {
          const name = url.searchParams.get('name') ?? 'wallpaper';
          const bytes = new Uint8Array(await req.arrayBuffer());
          return json(await wallpapers.save(bytes, name), 201);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      return json({ error: 'method not allowed' }, 405);
    }

    if (p.startsWith('/api/wallpapers/')) {
      const id = p.slice('/api/wallpapers/'.length);

      if (req.method === 'GET') {
        const found = await wallpapers.read(id);
        if (!found) return json({ error: 'not found' }, 404);
        return new Response(found.file, {
          headers: {
            'content-type': found.mime,
            // Content-addressed, so the bytes behind an id never change.
            'cache-control': 'public, max-age=31536000, immutable',
            // Defence in depth: even if a hostile file slipped past the magic
            // byte check, the browser must not be talked into running it.
            'content-security-policy': "default-src 'none'; sandbox",
            'x-content-type-options': 'nosniff',
          },
        });
      }

      if (req.method === 'DELETE') {
        return (await wallpapers.remove(id)) ? json({ ok: true }) : json({ error: 'not found' }, 404);
      }
      return json({ error: 'method not allowed' }, 405);
    }

    return json({ error: 'not found' }, 404);
  };
}
