// Small HTTP pieces shared by the routes and the static server.
//
// Deliberately free of imports. The cache-control constant used to live in
// static.ts, which is the module that embeds the built web assets — so any
// module wanting one string pulled the whole asset manifest in with it, and
// anything importing api.ts could not be loaded without a completed build.

/**
 * A year, the conventional "forever" for content-addressed assets: the hashed
 * bundles, and the wallpapers, whose filenames are a digest of their bytes.
 */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * A JSON response.
 *
 * `no-store` on every one of them. These describe live server state — which
 * windows exist, which are running — and a cached answer is worse than a slow
 * one: a stale window list draws terminals that are gone.
 */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/** The 405 body, which fourteen routes were spelling out individually. */
export const methodNotAllowed = (): Response =>
  json({ error: "method not allowed" }, 405);

/** The 400 for an id that does not even have the right shape. */
export const badId = (what: string): Response =>
  json({ error: `invalid ${what} id` }, 400);

/**
 * A JSON body, or `{}` when there isn't one.
 *
 * Every write route wants the same thing: parse if you can, and treat a missing
 * or malformed body as empty so validation reports the real problem ("a profile
 * needs a name") rather than a parse error. One route was the odd one out and
 * threw instead.
 *
 * A body not labelled JSON counts as missing. `text/plain` is one of the types
 * a page on another site can POST without a preflight, so honouring it would
 * let such a page fill in a route's fields. The Origin check already stops
 * that; this means a gap in it would only ever deliver an empty body.
 */
export const readJson = async <T>(req: Request): Promise<T> => {
  const type = req.headers.get("content-type")?.split(";")[0].trim();
  if (type !== "application/json") return {} as T;
  return (await req.json().catch(() => ({}))) as T;
};

/** How long a browser keeps to HTTPS after one answer over it: a year. */
const HSTS = "max-age=31536000";

/**
 * The headers every response carries.
 *
 * `frame-ancestors` and `X-Frame-Options` stop another site from loading the
 * desktop in a frame and steering clicks into it. Over HTTPS, `HSTS` makes the
 * browser use HTTPS for this host from then on. A route's own
 * `Content-Security-Policy` keeps its rules and gains `frame-ancestors`.
 *
 * Returns a copy when the response's headers cannot be changed, as with
 * `Response.redirect`.
 */
export function withSecurityHeaders(res: Response, https: boolean): Response {
  let out = res;
  try {
    out.headers.set("x-frame-options", "SAMEORIGIN");
  } catch {
    out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: new Headers(res.headers),
    });
    out.headers.set("x-frame-options", "SAMEORIGIN");
  }
  const csp = out.headers.get("content-security-policy");
  const frames = "frame-ancestors 'self'";
  out.headers.set(
    "content-security-policy",
    csp && !csp.includes("frame-ancestors")
      ? `${csp}; ${frames}`
      : (csp ?? frames),
  );
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "same-origin");
  if (https) out.headers.set("strict-transport-security", HSTS);
  return out;
}
