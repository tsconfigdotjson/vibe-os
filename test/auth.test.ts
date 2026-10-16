import { describe, expect, test } from "bun:test";
import {
  createGate,
  hostAllowed,
  hostName,
  isLoopback,
  originAllowed,
} from "../server/auth.ts";

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

describe("the Origin check", () => {
  const from = (origin: string | null, host = "box:7681") =>
    new Request("http://box:7681/api/projects", {
      method: "POST",
      headers: { host, ...(origin === null ? {} : { origin }) },
    });

  test("a request with no Origin is not a browser on another site", () => {
    expect(originAllowed(from(null))).toBe(true);
  });

  test("the page's own origin is allowed", () => {
    expect(originAllowed(from("http://box:7681"))).toBe(true);
  });

  test("another site is refused", () => {
    expect(originAllowed(from("https://evil.example"))).toBe(false);
  });

  test("the same name on another port is another origin", () => {
    expect(originAllowed(from("http://box:8080"))).toBe(false);
  });

  test("an opaque origin is refused", () => {
    expect(originAllowed(from("null"))).toBe(false);
  });

  test("an Origin with no Host to compare it to is refused", () => {
    const req = new Request("http://box/", {
      headers: { origin: "http://box" },
    });
    req.headers.delete("host");
    expect(originAllowed(req)).toBe(false);
  });
});

describe("hostName", () => {
  test.each([
    ["box", "box"],
    ["box:7681", "box"],
    ["Box.Example.TS.net.", "box.example.ts.net"],
    ["127.0.0.1:80", "127.0.0.1"],
    ["[::1]:7681", "::1"],
    ["[::1]", "::1"],
    ["fe80::1", "fe80::1"],
  ])("%s is %s", (header, name) => {
    expect(hostName(header)).toBe(name);
  });
});

describe("the Host check", () => {
  const names = new Set(["vibe-os", "vibe-os.example.ts.net"]);
  const to = (host: string) =>
    hostAllowed(new Request("http://x/", { headers: { host } }), names);

  test("addresses are always allowed, since rebinding needs a name", () => {
    expect(to("127.0.0.1:8080")).toBe(true);
    expect(to("100.64.0.7")).toBe(true);
    expect(to("[::1]:7681")).toBe(true);
  });

  test("localhost and its subdomains are allowed", () => {
    expect(to("localhost:8080")).toBe(true);
    expect(to("app.localhost")).toBe(true);
  });

  test("a name the server knows is allowed, in any case and on any port", () => {
    expect(to("vibe-os.example.ts.net")).toBe(true);
    expect(to("VIBE-OS:7681")).toBe(true);
  });

  test("a name it does not know is refused", () => {
    expect(to("rebind.evil.example")).toBe(false);
  });

  test("a known name inside a longer one is still unknown", () => {
    expect(to("vibe-os.evil.example")).toBe(false);
    expect(to("localhost.evil.example")).toBe(false);
  });

  test("no Host at all is refused", () => {
    const req = new Request("http://x/");
    req.headers.delete("host");
    expect(hostAllowed(req, names)).toBe(false);
  });
});

/**
 * A host under the same registrable domain, like another customer's
 * `vps-*.vps.ovh.ca`, can set a cookie of the same name for the whole domain.
 * The browser then sends two.
 */
describe("cookies planted by a neighbouring host", () => {
  const gate = createGate(TOKEN);
  const withCookie = (cookie: string) => gate.check(req({ cookie }));

  test("a planted cookie sent first does not lock the owner out", () => {
    expect(
      withCookie(`vibe_os_session=planted; vibe_os_session=${TOKEN}`),
    ).toBeNull();
    expect(
      withCookie(`vibe_os_session=planted; __Host-vibe_os_session=${TOKEN}`),
    ).toBeNull();
  });

  test("planted cookies alone do not pass", () => {
    expect(
      withCookie("vibe_os_session=planted; __Host-vibe_os_session=other"),
    ).not.toBeNull();
  });

  test("over HTTPS the cookie is the __Host- one, which the browser guards", () => {
    const res = gate.consumeTokenParam(
      req(),
      new URL(`https://box/?token=${TOKEN}`),
      true,
    );
    const cookie = res?.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith("__Host-vibe_os_session=")).toBe(true);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain");
  });

  test("over plain HTTP it keeps the plain name, which needs no Secure", () => {
    const res = gate.consumeTokenParam(
      req(),
      new URL(`http://box/?token=${TOKEN}`),
      false,
    );
    expect(res?.headers.get("set-cookie")?.startsWith("vibe_os_session=")).toBe(
      true,
    );
  });
});

describe("isLoopback", () => {
  test("this machine, in each form a socket reports it", () => {
    for (const a of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"])
      expect(isLoopback(a)).toBe(true);
  });

  test("anything else, including a missing address", () => {
    for (const a of [
      "54.39.97.232",
      "100.96.101.46",
      "::ffff:10.0.0.1",
      "",
      undefined,
    ])
      expect(isLoopback(a)).toBe(false);
  });
});
