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

import { createHash, timingSafeEqual } from "node:crypto";

const COOKIE = "vibe_os_session";

function safeEqual(a: string, b: string): boolean {
  // Hash first so the comparison is over fixed-length buffers and cannot leak
  // length through timingSafeEqual's own length check.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
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

/**
 * Was the browser talking TLS, even if we were not?
 *
 * `secure` is whether this process's own listener is TLS, and behind a proxy it
 * is always false: `tailscale serve` — the deployment this project recommends —
 * terminates TLS and forwards plain HTTP to 127.0.0.1. So the cookie was set
 * without `Secure` on exactly the setup that has the best TLS of any of them.
 *
 * The header is only ever allowed to *upgrade* the answer, never downgrade it.
 * That matters because anyone can send `X-Forwarded-Proto`, and the rule keeps
 * a forged one from doing anything an attacker would want: claiming `https`
 * only makes the cookie stricter, and claiming `http` on a real TLS listener is
 * ignored. Nor can a forgery be aimed at someone else — browsers do not send
 * this header, so the only request it can appear on is the sender's own.
 */
function isSecureRequest(req: Request, secure: boolean): boolean {
  if (secure) return true;
  const proto = req.headers.get("x-forwarded-proto");
  // A chain of proxies appends, and the client's protocol is the first entry.
  return proto?.split(",")[0].trim().toLowerCase() === "https";
}

export interface Gate {
  /** null when allowed, otherwise a reason string. */
  check(req: Request): string | null;
  /**
   * Handles `?token=…` on a page load: sets the session cookie and redirects to
   * the same URL without the token, so it does not linger in history or leak
   * through a Referer header.
   *
   * `secure` is whether *this* listener is TLS. A proxy in front may have
   * terminated TLS itself, which `isSecureRequest` accounts for.
   */
  consumeTokenParam(req: Request, url: URL, secure: boolean): Response | null;
}

export function createGate(token: string | null): Gate {
  if (!token) {
    return {
      check: () => null,
      consumeTokenParam: () => null,
    };
  }

  const gate = {
    check(req: Request): string | null {
      const cookie = readCookie(req, COOKIE);
      if (cookie && safeEqual(cookie, token)) return null;

      const auth = req.headers.get("authorization");
      if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), token))
        return null;

      return "missing or invalid session token";
    },

    consumeTokenParam(
      req: Request,
      url: URL,
      secure: boolean,
    ): Response | null {
      const supplied = url.searchParams.get("token");
      if (!supplied) return null;
      if (!safeEqual(supplied, token)) {
        return new Response("invalid token\n", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      url.searchParams.delete("token");
      const attrs = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=31536000",
        isSecureRequest(req, secure) ? "Secure" : "",
      ].filter(Boolean);
      return new Response(null, {
        status: 302,
        headers: {
          "set-cookie": attrs.join("; "),
          location: `${url.pathname}${url.search}`,
        },
      });
    },
  } satisfies Gate;

  return gate;
}
