import { describe, expect, test } from "bun:test";
import { createGate } from "../server/auth.ts";

/**
 * The front door, which had no tests at all.
 *
 * vibe-os hands out shells, so every one of these is the difference between a
 * gate and the appearance of one.
 */
const TOKEN = "s3cret-token-value";
const req = (headers: Record<string, string> = {}) =>
  new Request("http://box/", { headers });

describe("gate off", () => {
  const gate = createGate(null);

  test("allows everything", () => {
    expect(gate.check(req())).toBeNull();
    expect(gate.check(req({ cookie: "vibe_os_session=nonsense" }))).toBeNull();
  });

  test("has no token param to consume", () => {
    const url = new URL("http://box/?token=whatever");
    expect(gate.consumeTokenParam(req(), url, false)).toBeNull();
  });
});

describe("gate on", () => {
  const gate = createGate(TOKEN);

  test("refuses a request with nothing", () => {
    expect(gate.check(req())).toBe("missing or invalid session token");
  });

  test("accepts the session cookie", () => {
    expect(gate.check(req({ cookie: `vibe_os_session=${TOKEN}` }))).toBeNull();
  });

  test("accepts the cookie among others, in any position", () => {
    expect(
      gate.check(req({ cookie: `a=1; vibe_os_session=${TOKEN}; b=2` })),
    ).toBeNull();
    expect(
      gate.check(req({ cookie: `vibe_os_session=${TOKEN}; b=2` })),
    ).toBeNull();
  });

  test("accepts a bearer token, for callers that are not browsers", () => {
    expect(gate.check(req({ authorization: `Bearer ${TOKEN}` }))).toBeNull();
  });

  test("refuses a wrong or truncated token", () => {
    for (const value of [
      "wrong",
      TOKEN.slice(0, -1),
      `${TOKEN}x`,
      "",
      TOKEN.toUpperCase(),
    ]) {
      expect(
        gate.check(req({ cookie: `vibe_os_session=${value}` })),
      ).not.toBeNull();
      expect(
        gate.check(req({ authorization: `Bearer ${value}` })),
      ).not.toBeNull();
    }
  });

  test("refuses a cookie whose name merely ends the same way", () => {
    expect(
      gate.check(req({ cookie: `not_vibe_os_session=${TOKEN}` })),
    ).not.toBeNull();
  });
});

describe("consuming ?token=", () => {
  const gate = createGate(TOKEN);
  const consume = (
    search: string,
    secure = false,
    headers: Record<string, string> = {},
  ) => {
    const url = new URL(`http://box/desk${search}`);
    return gate.consumeTokenParam(req(headers), url, secure);
  };

  test("sets the cookie and redirects with the token stripped", () => {
    const res = consume(`?token=${encodeURIComponent(TOKEN)}`);
    expect(res?.status).toBe(302);
    // The whole point: the token must not survive into history or a Referer.
    expect(res?.headers.get("location")).toBe("/desk");
    expect(res?.headers.get("set-cookie")).toContain("vibe_os_session=");
  });

  test("keeps the other query parameters", () => {
    const res = consume(`?a=1&token=${TOKEN}&b=2`);
    const location = res?.headers.get("location") ?? "";
    expect(location).toContain("a=1");
    expect(location).toContain("b=2");
    expect(location).not.toContain("token");
  });

  test("the cookie is httpOnly and long-lived", () => {
    const cookie = consume(`?token=${TOKEN}`)?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("Path=/");
  });

  test("a wrong token is refused rather than ignored", () => {
    const res = consume("?token=nope");
    expect(res?.status).toBe(403);
    expect(res?.headers.get("set-cookie")).toBeNull();
  });

  test("no token param means no redirect", () => {
    expect(consume("")).toBeNull();
    expect(consume("?a=1")).toBeNull();
  });
});

/**
 * `Secure` tells the browser to withhold the cookie from plain HTTP. It used to
 * be decided from this process's own listener alone, which is always plain HTTP
 * behind a proxy — so `tailscale serve`, the deployment this project
 * recommends, got a cookie without it.
 */
describe("the Secure flag", () => {
  const gate = createGate(TOKEN);
  const cookieFor = (secure: boolean, headers: Record<string, string> = {}) =>
    gate
      .consumeTokenParam(
        req(headers),
        new URL(`http://box/?token=${TOKEN}`),
        secure,
      )
      ?.headers.get("set-cookie") ?? "";

  test("absent on plain HTTP with no proxy in front", () => {
    expect(cookieFor(false)).not.toContain("Secure");
  });

  test("present when this listener is itself TLS", () => {
    expect(cookieFor(true)).toContain("Secure");
  });

  test("present when a proxy says the browser is on https", () => {
    expect(cookieFor(false, { "x-forwarded-proto": "https" })).toContain(
      "Secure",
    );
    // Casing and whitespace are not the proxy's promise to keep.
    expect(cookieFor(false, { "x-forwarded-proto": " HTTPS " })).toContain(
      "Secure",
    );
  });

  test("a chain of proxies is read from the client end", () => {
    expect(cookieFor(false, { "x-forwarded-proto": "https,http" })).toContain(
      "Secure",
    );
    expect(
      cookieFor(false, { "x-forwarded-proto": "http,https" }),
    ).not.toContain("Secure");
  });

  /**
   * The header can only ever make the cookie stricter. Anyone can send it, and
   * this is what keeps a forged one useless: claiming http on a real TLS
   * listener is ignored, and claiming https only withholds the cookie from
   * plain HTTP — which is not something an attacker wants.
   */
  test("cannot downgrade a genuinely secure connection", () => {
    expect(cookieFor(true, { "x-forwarded-proto": "http" })).toContain(
      "Secure",
    );
  });

  test("junk in the header does not set it", () => {
    for (const value of ["", "http", "wss", "https-ish", "nonsense"]) {
      expect(cookieFor(false, { "x-forwarded-proto": value })).not.toContain(
        "Secure",
      );
    }
  });
});
