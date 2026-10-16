// The one wrapper every request goes through.
//
// Routes sit behind `frontDoor`, which decides who gets in before any route is
// chosen. A route added later is gated without doing anything, and none of
// them checks the token itself. The only answers given without a token are the
// ones `unguarded` returns, which index.ts keeps to the ACME challenge and the
// move from plain HTTP to HTTPS.

import { type Gate, hostAllowed, hostName, originAllowed } from "./auth.ts";
import { log } from "./log.ts";

/** What a request needs to know about the connection it came on. */
export interface Arrival {
  /** Whether this listener is TLS. */
  secure: boolean;
}

/** A route handler. Undefined means the request became a WebSocket. */
export type Handler<A extends Arrival> = (
  req: Request,
  url: URL,
  arrival: A,
) => Promise<Response | undefined>;

export interface FrontDoorOptions<A extends Arrival> {
  gate: Gate;
  /** Whether there is a token. With none, the Host check stands in for it. */
  token: boolean;
  /** Names the server answers to, for the Host check. */
  hosts: ReadonlySet<string>;
  /**
   * Answers given before the gate, to anyone. Must never serve the app, the
   * API, or anything else that needs the token.
   */
  unguarded?: (req: Request, url: URL, arrival: A) => Response | null;
}

const UNAUTHORISED_PAGE = `<!doctype html><meta charset="utf-8"><title>vibe-os</title>
<body style="font:14px ui-monospace,monospace;background:#07090d;color:#c8cedb;padding:2rem">
<h1 style="font-weight:600">vibe-os</h1>
<p>This server requires a token. Open the URL printed in the server log.</p></body>`;

/** The 401 for a path, in the shape its callers read. */
export function unauthorised(pathname: string, reason: string): Response {
  if (pathname === "/mcp")
    return new Response(JSON.stringify({ error: reason }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": 'Bearer realm="vibe-os"',
      },
    });
  if (pathname.startsWith("/api/"))
    return Response.json(
      { error: reason },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  if (pathname === "/websocket")
    return new Response("unauthorized", { status: 401 });
  return new Response(UNAUTHORISED_PAGE, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Wraps the routes in the checks every request passes, in order: the
 * unguarded answers, Origin, Host when there is no token, `?token=` on a page
 * load, then the token itself.
 *
 * `/mcp` skips the `?token=` step, because the MCP spec forbids a token in the
 * query string, so there one counts for nothing.
 */
export function frontDoor<A extends Arrival>(
  options: FrontDoorOptions<A>,
  routes: Handler<A>,
): (req: Request, arrival: A) => Promise<Response | undefined> {
  const { gate, token, hosts, unguarded } = options;
  return async (req, arrival) => {
    const url = new URL(req.url);

    const open = unguarded?.(req, url, arrival);
    if (open) return open;

    if (!originAllowed(req)) {
      log.warn(
        `rejected ${req.method} ${url.pathname} from origin ${req.headers.get("origin")}`,
      );
      return new Response("forbidden: cross-origin request\n", {
        status: 403,
      });
    }
    if (!token && !hostAllowed(req, hosts)) {
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

    if (url.pathname !== "/mcp") {
      const redirect = gate.consumeTokenParam(req, url, arrival.secure);
      if (redirect) return redirect;
    }

    const denied = gate.check(req);
    if (denied) return unauthorised(url.pathname, denied);

    return routes(req, url, arrival);
  };
}
