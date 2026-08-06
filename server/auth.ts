// The front door.
//
// vibe-os hands out shell access to the machine it runs on, so "who may load
// the page" and "who may open a shell" are the same question — there is no
// point protecting one and not the other. Every entry point (the app, the API,
// the certificate signer, the byte pipe) goes through this one gate.
//
// It is off by default, which is a deliberate and dangerous choice: it makes
// `npx vibe-os` work on a private network without ceremony. Startup prints a
// warning that says so. Pass --token to turn it on.

import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const COOKIE = 'vibe_os_session';

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is over fixed-length buffers and cannot leak
  // length through timingSafeEqual's own length check.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export interface Gate {
  readonly enabled: boolean;
  /** null when allowed, otherwise a reason string. */
  check(req: IncomingMessage): string | null;
  /**
   * Handles `?token=…` on a page load: sets the session cookie and redirects to
   * the same URL without the token, so it does not linger in history or in a
   * Referer header. Returns true if the response was handled.
   */
  consumeTokenParam(res: ServerResponse, url: URL, secure: boolean): boolean;
}

export function createGate(token: string | null): Gate {
  if (!token) {
    return {
      enabled: false,
      check: () => null,
      consumeTokenParam: () => false,
    };
  }

  return {
    enabled: true,

    check(req) {
      const cookie = readCookie(req, COOKIE);
      if (cookie && safeEqual(cookie, token)) return null;

      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return null;

      return 'missing or invalid session token';
    },

    consumeTokenParam(res, url, secure) {
      const supplied = url.searchParams.get('token');
      if (!supplied) return false;
      if (!safeEqual(supplied, token)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('invalid token\n');
        return true;
      }
      url.searchParams.delete('token');
      const attrs = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=31536000',
        secure ? 'Secure' : '',
      ].filter(Boolean);
      res.writeHead(302, {
        'set-cookie': attrs.join('; '),
        location: `${url.pathname}${url.search}`,
      });
      res.end();
      return true;
    },
  };
}
