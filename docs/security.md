# Security

**vibe-os hands out shell access to the machine it runs on.** Every window is
the same unix user, there is no per-user isolation, and anyone who can reach the
port and pass the gate can run anything that user can. Treat access to vibe-os
as equivalent to SSH access to the box.

Report vulnerabilities privately, as described in [SECURITY.md](../SECURITY.md).

The recommended shape is all of it: behind Tailscale, firewalled to the tailnet,
bound to the tailnet address, and with the token on.

**The gate is on by default.** The first start generates a token, remembers it
in the state dir, and prints the URL with it.

```bash
vibe-os                  # the remembered token, or a new one
vibe-os --token hunter2  # or pick your own
vibe-os --no-token       # no gate, with a warning at startup
```

It gates the app, the API, the certificate signer, the wallpaper upload and the
WebSocket bridge.

Two checks run in front of it:

- **Origin, always.** A request carrying an `Origin` that is not this server is
  refused, so a page on another site cannot drive the API or open the bridge
  through your browser.
- **Host, with no token.** A request has to name the server by an address,
  `localhost`, the machine's hostname, `--domain`, `--ssh-advertise` or its
  Tailscale name. That stops DNS rebinding, where a page points its own domain
  at the box to become same-origin with it. Add any other name with
  `--allowed-host`. With a token this check is off, since a rebound page has
  neither the cookie nor the token.

Open the URL with `?token=…` once and the server sets an `HttpOnly` cookie, then
redirects without the token so it does not linger in history. Scripts can send
`Authorization: Bearer <token>` (see the [API reference](api.md)).
Comparison is constant-time.

The cookie value is the token rather than a derived session id, so there is no
per-browser session to revoke. Rotating means changing it on the server.

`--domain` provisions a Let's Encrypt certificate over HTTP-01 and serves HTTPS,
renewing 30 days before expiry. On plain HTTP the browser clipboard API is
unavailable, so copy-on-select and paste stop working and the app cannot be
installed. OSC 52 clipboard *reads* are always refused, since anything running
in a session could otherwise ask what you last copied.
