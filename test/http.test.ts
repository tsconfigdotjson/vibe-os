import { describe, expect, test } from "bun:test";
import { withSecurityHeaders } from "../server/http.ts";

describe("withSecurityHeaders", () => {
  test("no other site can frame a page", () => {
    const res = withSecurityHeaders(new Response("hi"), false);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  test("HSTS only over HTTPS", () => {
    expect(
      withSecurityHeaders(new Response("hi"), false).headers.has(
        "strict-transport-security",
      ),
    ).toBe(false);
    expect(
      withSecurityHeaders(new Response("hi"), true).headers.get(
        "strict-transport-security",
      ),
    ).toBe("max-age=31536000");
  });

  test("a route's own policy keeps its rules and gains frame-ancestors", () => {
    const res = withSecurityHeaders(
      new Response("svg", {
        headers: { "content-security-policy": "default-src 'none'; sandbox" },
      }),
      false,
    );
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'self'",
    );
  });

  test("a redirect, whose headers are fixed, still gets them", () => {
    const res = withSecurityHeaders(
      Response.redirect("https://box/", 308),
      true,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://box/");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });
});
