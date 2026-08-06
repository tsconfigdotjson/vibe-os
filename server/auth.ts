// The front door.
//
// vibe-os hands out shell access to the machine it runs on, so "who may load
// the page" and "who may open a shell" are the same question — there is no
// point protecting one and not the other. Every entry point (the app, the API,
// the certificate signer, the wallpaper upload, the byte pipe) goes through
// this one gate.
//
// It is off by default, which is a deliberate and dangerous choice: it makes
// `vibe-os` work on a private network without ceremony. Startup prints a
// warning that says so. Pass --token to turn it on.

import { timingSafeEqual, createHash } from 'node:crypto';

const COOKIE = 'vibe_os_session';

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is over fixed-length buffers and cannot leak
  // length through timingSafeEqual's own length check.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
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
  check(req: Request): string | null;
  /**
   * Handles `?token=…` on a page load: sets the session cookie and redirects to
   * the same URL without the token, so it does not linger in history or leak
   * through a Referer header.
   */
  consumeTokenParam(url: URL, secure: boolean): Response | null;
}

export function createGate(token: string | null): Gate {
  if (!token) {
    return { enabled: false, check: () => null, consumeTokenParam: () => null };
  }

  return {
    enabled: true,

    check(req) {
      const cookie = readCookie(req, COOKIE);
      if (cookie && safeEqual(cookie, token)) return null;

      const auth = req.headers.get('authorization');
      if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return null;

      return 'missing or invalid session token';
    },

    consumeTokenParam(url, secure) {
      const supplied = url.searchParams.get('token');
      if (!supplied) return null;
      if (!safeEqual(supplied, token)) {
        return new Response('invalid token\n', {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
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
      return new Response(null, {
        status: 302,
        headers: {
          'set-cookie': attrs.join('; '),
          location: `${url.pathname}${url.search}`,
        },
      });
    },
  };
}
