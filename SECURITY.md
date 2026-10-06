# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
this repository. Do not open a public issue.

Include what you ran, what you expected, and what happened. A proof of concept
against your own box is the most useful thing you can send.

Fixes land on `main`. There are no maintained release branches, so the latest
release is the only supported version.

## What counts

vibe-os hands out shell access to the machine it runs on. Anyone who passes the
token gate can run anything the vibe-os user can, and that is by design.
[docs/security.md](docs/security.md) describes the model.

A vulnerability is anything that gets past that model:

- Reaching the API, the certificate signer or the WebSocket bridge without the
  token, when one is set.
- Driving any of those from another origin: CSRF, DNS rebinding, or a
  cross-origin WebSocket.
- A certificate that does more than its window's `force-command`, or that
  outlives `--cert-ttl`.
- Reading or writing files outside what a route is for, including through
  wallpaper uploads.
- Script injection into the desktop from anything a session prints, a profile
  stores, or a file name.
- `install-browser` or `install-service` exposing VNC, the Chrome debug port, or
  the server beyond the interfaces they say they bind.
- The SSH WASM runtime being fetched or served in a way that lets someone
  substitute it.

Not vulnerabilities:

- Anything that needs a shell on the box, or the token, to begin with.
- Running without a token on a network you do not control. The startup
  warning and `vibe-os doctor` both say so.
- Problems in sshd, dtach, Chrome or a harness that vibe-os does not make worse.
