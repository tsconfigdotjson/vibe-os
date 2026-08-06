# vibe-os

A terminal multiplexer in the browser. Point a blank VPS at it and you get
persistent shells on port 80, reachable from anything with a browser.

```bash
npm install -g vibe-os
vibe-os
```

Open `http://<your-vps>/`. Two panes, both already logged in, each in its own
tmux session. Close the tab, come back tomorrow, and whatever was running is
still running.

There is nothing to configure. No key to copy and paste, no `authorized_keys` to
edit, no `sshd_config` change, no root, and no Docker.

---

## How it works

```
┌─────────────────┐                        ┌──────────────────┐        ┌──────┐
│     browser     │   wss://…/websocket    │   vibe-os (node) │  TCP   │ sshd │
│   ssh.wasm      │ ─────────────────────► │    :80 / :443    │ ─────► │  :22 │
│  private key    │                        │   byte pipe      │        │      │
│  in IndexedDB   │   POST /api/ssh/…      │   + SSH CA       │        │ tmux │
└─────────────────┘ ─────────────────────► └──────────────────┘        └──────┘
```

**The SSH protocol runs inside the browser.** Key exchange, authentication and
channel multiplexing all happen in a Go/WASM sandbox in the tab. The Node server
is a byte pipe that understands nothing about SSH — it never sees plaintext and
holds no credentials for your session.

### The bootstrap problem, and how it is solved

The awkward part of browser-based SSH is the first connection: the browser has a
key nobody has ever heard of, and a blank VPS has an empty `authorized_keys`.
The usual answers are all bad — print a public key and make the user paste it,
or ship a private key down to the browser.

vibe-os does neither. **It is its own short-lived SSH certificate authority.**

1. On first start it generates an ed25519 CA in `~/.vibe-os/` and appends one
   line to `~/.ssh/authorized_keys`:

   ```
   cert-authority ssh-ed25519 AAAA… vibe-os-ca@host
   ```

2. Each pane generates its own keypair inside the WASM sandbox. The private half
   stays in IndexedDB and never crosses the network.

3. The pane POSTs only its **public** key to `/api/ssh/certificate`. The server
   signs it and returns a certificate valid for 12 hours.

4. sshd accepts it because of that one `cert-authority` line.

No private key is ever transmitted. Certificates expire on their own, and
revoking every browser that ever connected is deleting one line.

### How panes stay alive

Each certificate carries a per-pane `force-command` critical option:

```
force-command tmux -u new-session -A -s vibe-1
```

`new-session -A` attaches if the session exists and creates it otherwise, so a
pane reattaches to exactly what it was running before. Because the client
requests a *shell* (not an exec), sshd allocates a real PTY and then runs the
forced command inside it — so resize, job control and full-screen programs all
behave.

This detail is load-bearing and easy to get wrong. sshterm's `autoConnect.command`
option looks like the obvious place to put the tmux command, but it takes
upstream's `session.Run(command)` path, which requests **no PTY and installs no
resize handler**. tmux fails outright there. The command has to travel in the
certificate instead.

---

## Commands

| command | what it does |
| --- | --- |
| `vibe-os` / `vibe-os start` | serve the UI and the SSH bridge |
| `vibe-os doctor` | check this machine is ready, and say what is missing |
| `sudo vibe-os install-service` | write and enable a systemd unit |
| `vibe-os fetch-wasm` | re-download the SSH WASM runtime |

### Options

```
--port <n>          HTTP port (default 80)
--host <addr>       bind address (default 0.0.0.0)
--domain <fqdn>     provision a Let's Encrypt certificate and serve HTTPS
--email <addr>      contact address for Let's Encrypt
--tls-port <n>      HTTPS port (default 443)

--token [value]     require a token; generates and remembers one if omitted
--no-token          disable the gate (default)

--ssh-host <addr>   SSH target for the bridge (default 127.0.0.1)
--ssh-port <n>      SSH target port (default 22)
--user <name>       unix user to log in as (default: current user)
--no-tmux           plain login shells instead of persistent tmux sessions
--cert-ttl <secs>   certificate lifetime (default 43200)

--workspace <dir>   root for projects and worktrees (default ~/workspace)
--state-dir <dir>   CA and TLS material (default ~/.vibe-os)
```

### Multiplexer keys

Chords use `alt`, not tmux's `ctrl-b` — the terminal has focus nearly all the
time and `ctrl-b` belongs to the tmux session running inside it.

| key | action |
| --- | --- |
| `alt` `1`…`9` | focus pane n |
| `alt` `\` | side by side |
| `alt` `-` | stacked |
| `alt` `z` | show only the focused pane |
| `alt` `t` | open another pane |

Drag the divider to resize; double-click it to even the panes out.

---

## Security

**The gate is off by default.** Anyone who can reach the port gets a shell as
the user running vibe-os. That is a deliberate choice for private networks
(Tailscale, a VPC, an SSH tunnel) and startup prints a warning saying so.

To lock it:

```bash
vibe-os --token          # generates one, remembers it, prints the URL
vibe-os --token hunter2  # or pick your own
```

The token is exchanged for an httpOnly session cookie on first visit, and gates
everything: the app, the API, the certificate signer, and the WebSocket bridge.
Cross-origin WebSocket upgrades are always rejected.

Nothing about the gate protects against someone who already has the token, and
there is no per-user isolation — every pane is the same unix user. Treat access
to vibe-os as equivalent to SSH access to the box, because it is.

### TLS

Plain HTTP on port 80 works out of the box on a bare IP. Pass `--domain` and it
provisions a Let's Encrypt certificate over HTTP-01 (it already owns port 80),
serves HTTPS, and redirects. Certificates are renewed 30 days before expiry.

On plain HTTP the browser clipboard API is unavailable — the origin is not a
secure context — so copy-on-select and paste-on-right-click stop working. Use a
domain if you want them.

---

## Port 80

Binding it needs root or `CAP_NET_BIND_SERVICE`. On a fresh VPS you are usually
root and it just works. Otherwise vibe-os falls back to port 8080 and tells you
how to fix it:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(readlink -f "$(which node)")
```

or let systemd handle it, which grants the capability without touching the node
binary:

```bash
sudo vibe-os install-service --user "$USER"
journalctl -u vibe-os -f
```

---

## Development

```bash
npm install          # also fetches ssh.wasm from the upstream release
npm run build
npm run dev          # Vite on :5173, proxying to a vibe-os on :7681
```

`ssh.wasm` (~19 MB) comes prebuilt from
[c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) releases rather than being
compiled here, so no Go toolchain is needed on the target machine. The build
precompresses it to about 4.5 MB of brotli, which is what visitors actually
download.

Pin a version with `SSHTERM_VERSION=v0.8.3 npm run fetch-wasm`.

### Things that will bite you

**One Go runtime serves the whole page.** Every pane calls `start()` on the same
WASM instance, and an unhandled Go panic in *any* pane kills the runtime for
*all* of them. Two consequences: teardown order in `SshTerminal.tsx` is
load-bearing (close the session and await `done` *before* disposing the
Terminal — React StrictMode's double-mount hits this immediately), and
`onRuntimeDead` exists so the app can rebuild every pane instead of leaving you
with terminals that look fine but accept no input.

**Host key algorithm order is not the obvious one.** golang.org/x/crypto/ssh's
`supportedHostKeyAlgos` puts ECDSA *ahead* of Ed25519 — the opposite of OpenSSH.
vibe-os discovers the host key with `ssh-keyscan` in that order, because pinning
a key the server holds but does not present makes every pane report the host key
as **changed**, which reads like an attack rather than a misconfiguration.

**tmux is detected on the machine vibe-os runs on**, which is the SSH target by
default. If you point `--ssh-host` somewhere else, pass `--tmux` explicitly.

---

## What this is not, yet

This is the foundation: package, server, certificate bootstrap, and a two-pane
multiplexer. The pane model is built to extend, but project switching, git
worktrees, and one-click Claude sessions are not here yet. `--workspace` is
plumbed through and shown in the header, waiting for them.

## License

MIT. Bundles [c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) (MIT).
