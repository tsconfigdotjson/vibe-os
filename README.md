<div align="center">

<img src="public/icon.svg" width="88" height="88" alt="">

# vibe-os

**A coding desktop in the browser, on a box you own.**

Switch between the git repos on a machine, spin up a worktree per piece of work,
and open terminals into it, from anything with a browser.

[![CI](https://github.com/GratefulWorkspace/vibe-os/actions/workflows/ci.yml/badge.svg)](https://github.com/GratefulWorkspace/vibe-os/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

</div>

---

Open the desktop and you get a project picker, a sidebar of workspaces, and
windows you can drag around a snap grid. Every window is a
[dtach](https://github.com/crigler/dtach) session in its workspace's worktree,
so closing the tab and coming back tomorrow finds whatever was running still
running.

Down the right is a rail of **profiles**, the roles you work as. *QA Engineer*,
*Backend Manager*, whatever your work divides into. Each carries a colour, a
harness with its settings, and a standing prompt. Click one and you get a window
tinted in its colour with Claude already running in the worktree.

There is nothing to configure. No key to copy and paste, no `authorized_keys` to
edit, no `sshd_config` change, and no root.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Using it](#using-it)
  - [Projects and workspaces](#projects-and-workspaces)
  - [Profiles](#profiles)
  - [Popping a terminal out](#popping-a-terminal-out)
  - [The desktop](#the-desktop)
  - [Installing it as an app](#installing-it-as-an-app)
- [Deploying on a VPS](#deploying-on-a-vps)
  - [What the box needs](#what-the-box-needs)
  - [Install](#install)
  - [Behind Tailscale](#behind-tailscale)
  - [Firewall](#firewall)
  - [Running it as a service](#running-it-as-a-service)
  - [An always-on browser](#an-always-on-browser)
  - [Giving the box a GitHub identity](#giving-the-box-a-github-identity)
  - [Updating a running box](#updating-a-running-box)
- [Security](#security)
- [CLI reference](#cli-reference)
- [Development](#development)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

### Try it locally

```bash
docker compose up --build
open http://localhost:8080
```

A blank Debian box with sshd, dtach and git, which is the same shape as a fresh
VPS. The port is published on loopback only, because this compose file runs
without a token and an unauthenticated vibe-os is a shell for anyone who can
reach it.

### Or point an agent at a VPS

You have an agent. Give it SSH access to a fresh box and this:

> Set up vibe-os (https://github.com/GratefulWorkspace/vibe-os) on this VPS.
>
> 1. Create a non-root user with sudo if I am logged in as root, and do the rest
>    as that user. vibe-os hands out shells as whoever runs it.
> 2. Install the prerequisites: `openssh-server`, `openssh-client`, `dtach`,
>    `git`, and `gh`. Install Claude Code with the standalone installer from
>    https://claude.ai/install.sh, not npm.
> 3. Install Tailscale, run `tailscale up`, and tell me the tailnet address.
> 4. Build the binary. If you have Bun locally, `bun run compile` and copy
>    `dist/bin/vibe-os-linux-x64` to `/usr/local/bin/vibe-os`. Otherwise clone
>    the repo on the box, install Bun, and run `bun install && bun run build`.
> 5. Run `vibe-os doctor` and then `sudo vibe-os doctor`. Fix what they report
>    before continuing. Do not skip this.
> 6. Install the service: `sudo vibe-os install-service --port 7681 --host
>    127.0.0.1 --token`. Run that with sudo from the user account, not as root.
> 7. Put HTTPS in front: `sudo tailscale serve --bg 7681`.
> 8. Close the box down with ufw: allow in on `tailscale0`, allow `41641/udp`,
>    default deny incoming, then enable. Confirm you can still reach the box
>    over the tailnet in a second session before enabling it.
> 9. Turn off SSH password authentication by writing
>    `PasswordAuthentication no` to `/etc/ssh/sshd_config.d/01-hardening.conf`.
>    That file has to sort before `50-cloud-init.conf`, which sets it to yes.
>    Run `sshd -t` before reloading.
> 10. Run `sudo vibe-os doctor` one more time and paste the output, along with
>     the URL and token from `journalctl -u vibe-os`.
>
> Tell me what you are about to run before you run anything that opens a port
> or changes sshd.

Read what it proposes before you let it run. Step 8 can lock you out of the box
if the tailnet is not actually working yet.

---

## How it works

```
┌─────────────────┐                        ┌──────────────────┐        ┌──────┐
│     browser     │   wss://…/websocket    │  vibe-os (bun)   │  TCP   │ sshd │
│   ssh.wasm      │ ─────────────────────► │    :80 / :443    │ ─────► │  :22 │
│  private key    │                        │   byte pipe      │        │      │
│  in IndexedDB   │   POST /api/ssh/…      │   + SSH CA       │        │dtach │
└─────────────────┘ ─────────────────────► └──────────────────┘        └───▲──┘
                                                                           │
┌─────────────────┐                                                        │
│  your terminal  │   ssh -t … vibe-os attach quiet-amber-otter-1           │
│   ssh + dtach   │ ──────────────────────────────────────────────────────►─┘
└─────────────────┘
```

**The SSH protocol runs inside the browser.** Key exchange, authentication and
channel multiplexing happen in a Go/WASM sandbox in the tab. The server is a
byte pipe: it never sees plaintext and holds no credentials for your session.

**vibe-os is its own short-lived certificate authority.** On first start it
generates an ed25519 CA and appends one `cert-authority` line to
`~/.ssh/authorized_keys`. Each window generates a keypair in the browser, keeps
the private half in IndexedDB, and posts only the public half to be signed.
Certificates last 12 hours. Revoking every browser that ever connected is
deleting one line.

**Windows survive because dtach owns them, not vibe-os.** Each certificate
carries a `force-command` that attaches to the window's dtach socket, creating
it in the workspace's worktree if it is not there yet. Restarting the server,
reloading the page and closing the laptop all leave the session running.

The bottom route in that diagram is the same session by a different door: your
own ssh client, your own key, straight to sshd. See
[popping out](#popping-a-terminal-out).

---

## Using it

### Projects and workspaces

The picker in the top-left switches between git repositories on the machine.
**Refresh** walks the disk for them, bounded by depth and a visit budget, and
only on that button.

Each project has **workspaces** in the sidebar. A workspace is a git worktree on
its own branch, named with three random words. Terminals belong to a workspace:
switching swaps which windows are on screen and restores their placement, while
the sessions you left keep running. Only ✕ ends anything.

`git push` works with no arguments from a new workspace, because creating one
sets `push.autoSetupRemote` on the project. Nothing is pushed for you.

Every window in a workspace shares one checkout, one branch and one git index.
That is the point, but it means two agents running `git commit` at the same
moment will collide on `index.lock`. Nothing is corrupted, one of them retries.
If two pieces of work need to proceed independently, give them a workspace each.

### Profiles

A profile is a name, a colour, a harness (`claude`, a shell, or any command on
the box) with its flags, and a standing prompt. Profiles belong to a project and
appear in every workspace of it.

The colour is the point: it tints the window, its title bar and its dock entry,
so three roles running at once are distinguishable without reading anything.

- **Quitting the harness closes the window.** A role window exists to run that
  role. ⟳ opens it again.
- **Clicking a role that is already open raises it.** Hover a live row and press
  **+** to open a second one.
- **Flags are stored as a list of arguments**, quoted individually when the
  command is built. The browser never sends a command at all.

The editor gives you a model dropdown, a thinking dropdown (`--effort`), a
permission dropdown and a few switches, with the generated flags and a preview
behind **Advanced**. Models and permission modes are read off the Claude binary
installed on the server, so the list follows Claude's releases.

#### MCP servers

Three settings rather than a list of switches, because that is what Claude
accepts: everything the box has, nothing, or exactly what you pick.

The list is read off the box. Add one and it appears:

```sh
claude mcp add --scope user linear --transport sse https://mcp.linear.app/sse
```

Use `--scope user`. Without it Claude files the server under whichever directory
you ran the command in, and if that was a workspace, the server goes when the
worktree does.

Picking servers writes one file per server under `~/.vibe-os/mcp/` at 0600, and
the profile stores the path rather than the definition, which can contain an API
key. The files are rewritten from `~/.claude.json` whenever a window starts, so
`claude mcp add` stays the only place a server is configured.

Credentials follow the server name, so a server you have already logged into
keeps working. `--strict-mcp-config` also drops plugin-provided servers, but not
claude.ai connectors like Gmail or Drive, which are attached to your account.

#### Blanks

A prompt can leave gaps:

```
Read {{which files}} on branch {{branch}} and report back.
```

Each `{{…}}` becomes a field in the band above the terminal, drawn inline in the
sentence. Select a word in the editor and press **+ blank** to make one.

Blanks are keyed by position, so two `{{file}}` stay two separate fields.
Pressing Copy or Send with blanks empty refuses once, then goes anyway, and an
unfilled blank falls back to its own label.

**Copy** puts the prompt on the clipboard. **Send** writes it into the session
with bracketed paste, so a multi-line prompt arrives in Claude's composer as one
block rather than submitting on the first newline. Send always works;
`navigator.clipboard` does not exist on a page served over plain HTTP to an IP.

### Popping a terminal out

The ⇗ button sends a terminal to its own browser window, or to a real terminal
on your machine:

```bash
ssh -t vibe@vibe-os.your-tailnet.ts.net vibe-os attach quiet-amber-otter-1
```

Every route addresses the same window id and the same dtach session, so popping
out is detaching one client and attaching another. **Bring it back** returns it
with scrollback intact, and the desktop reclaims a window on its own if the
terminal goes away.

`vibe-os attach` with no argument gives you a picker of every window on the box:

```
  vibe-os · 3 windows

    1  live  quiet-amber-otter-1   QA Engineer       vibe-os/quiet-amber-otter
    2  idle  quiet-amber-otter-2   terminal          vibe-os/quiet-amber-otter
    3  live  brave-copper-lynx-1   Backend Manager   vibe-os/brave-copper-lynx

  attach [1-3, q to quit]:
```

**This grants no access.** That ssh connection authenticates with your own key,
or your tailnet identity under `tailscale up --ssh`. vibe-os is not in the auth
path and `--token` does not gate it. Anyone who can ssh to the box could already
type `dtach -a`.

### The desktop

Windows snap to a 24 × 14 grid. Drag a title bar to move, any edge to resize,
double-click to fill the desktop. **⊞** on the dock tiles up to four windows.

There are no keyboard chords. The terminal has focus nearly all the time, and
every key the desktop took would be a key the session could not have.

The dock and the profile rail hide themselves. Push the pointer into the bottom
or right edge to bring them back.

Closing a window ends its session. **Minimise** puts it away and keeps it
running.

The dock's **◑** opens the wallpaper picker. Uploads are stored on the server,
so the same desktop appears on every device. **Dim** darkens the wallpaper
behind the windows.

### Installing it as an app

vibe-os ships a web app manifest, so Chrome, Edge and Brave offer to install it
and it runs in its own window. On iOS, **Share → Add to Home Screen**.

It needs a secure origin: `localhost`, or HTTPS by way of
[`tailscale serve`](#behind-tailscale) or `--domain`.

Give each box its own colour so you can tell installed instances apart:

```bash
vibe-os start --theme-color '#7a4fd6'
```

The service worker caches nothing. It exists only because Chrome will not offer
installation without one.

---

## Deploying on a VPS

### What the box needs

| Package | What uses it | Without it |
| --- | --- | --- |
| `openssh-server` | every window logs in through it | nothing connects |
| `openssh-client` | signing certificates, finding the host key | **the server refuses to start** |
| `dtach` | keeps windows alive across reloads | windows die on reload, and **profiles launch no harness** |
| `git` | projects and worktrees | no projects |
| `gh` | PRs, issues and reviews (optional) | git works, the GitHub API does not |
| `claude` | the Claude harness | those profiles open a window that closes immediately |

```bash
sudo apt update && sudo apt install -y openssh-server openssh-client dtach git gh
curl -fsSL https://claude.ai/install.sh | bash      # standalone, needs no Node
```

Verified on Debian 12 and 13, Ubuntu 24.04 and 26.04 LTS, x86\_64.

`dtach` is the one people skip. The harness command lives in the dtach
invocation, so without it a profile opens a shell and does nothing else.

### Install

```bash
bun run compile              # writes dist/bin/vibe-os-linux-{x64,arm64}
scp dist/bin/vibe-os-linux-x64 you@host:/usr/local/bin/vibe-os
ssh you@host 'chmod +x /usr/local/bin/vibe-os'
```

The binary carries the whole app, including the 20MB SSH WASM runtime. No Bun,
Node or npm on the target.

Then check it, twice. `vibe-os doctor` answers whether a certificate this host
signs will actually be accepted, which catches the failures that otherwise
appear in a browser as `handshake failed` and nowhere else. Reading sshd's
effective config and the firewall needs root:

```bash
vibe-os doctor          # everything that does not need privileges
sudo vibe-os doctor     # adds the sshd and firewall checks
```

`doctor` evaluates the flags it is given and cannot see a systemd unit, so pass
the same flags the service uses to get a true answer.

### Behind Tailscale

The recommended setup. You stop needing to bind port 80, and you stop needing
Let's Encrypt.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Loopback, not the tailnet address: serve proxies to 127.0.0.1, and binding
# the tailnet address gives a 502 because serve cannot reach it.
vibe-os start --port 7681 --host 127.0.0.1 --token
sudo tailscale serve --bg 7681
```

That serves it at `https://<machine>.<tailnet>.ts.net` with a real certificate,
which is also what the browser needs before it will expose the clipboard or
offer to install the app.

### Firewall

Tailscale does not close ports for you. Until you do, the machine still answers
on its public address, and vibe-os hands out shells.

**Confirm you can reach the box over the tailnet in a second terminal before
denying anything**, and know where your provider's rescue console is.

```bash
sudo ufw allow in on tailscale0
sudo ufw allow 41641/udp               # keeps Tailscale on a direct path
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

Verified from outside the tailnet against a box running this recipe: ports 22,
80, 443, 7681 and 8080 all time out, while the tailnet address answers.

`sudo vibe-os doctor` checks these. It reads ufw, falling back to nftables and
iptables, and it reads configuration rather than reachability. It cannot see
your provider's firewall, which is a separate thing worth closing too. OVH's is
stateless, so leave `41641/udp` open there or Tailscale relays everything.

Cloud images often ship `PasswordAuthentication yes` in
`/etc/ssh/sshd_config.d/50-cloud-init.conf`. sshd takes the first occurrence of
a keyword, so overriding it needs a file that sorts *earlier*:

```bash
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/01-hardening.conf
sudo sshd -t && sudo systemctl reload ssh
```

Confirm a fresh key-based login works before closing the session you have.

### Running it as a service

```bash
sudo vibe-os install-service --port 7681 --token hunter2
journalctl -u vibe-os -f
```

Run it with `sudo` from your own account, not as root. It takes the user from
`SUDO_USER` and writes a unit that runs as them, forwarding whatever flags you
passed. It refuses to write a unit that runs as root.

If you are binding port 80 rather than using Tailscale, that needs
`CAP_NET_BIND_SERVICE`, which `install-service` grants. By hand:

```bash
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/vibe-os
```

Otherwise vibe-os falls back to port 8080 and says so.

### An always-on browser

One Google Chrome, on a virtual display, running for as long as the box does.
It is where a browser extension lives on a machine with no screen. Optional, and
separate from `install-service`.

x86\_64 only. Google publishes no arm64 Chrome for Linux, and Chromium is not a
substitute if you want the Claude in Chrome extension.

```bash
sudo apt install -y tigervnc-standalone-server openbox x11-utils

curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
https://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable

sudo vibe-os install-browser
```

That writes seven units: an X server with VNC built in, a window manager, Chrome
itself, a liveness probe on a timer, and a nightly restart on a timer. All of
them restart on failure.

| Flag | Default |
| --- | --- |
| `--geometry <WxH>` | `1600x900` |
| `--display <n>` | `99` |
| `--vnc-port <n>` | `5900`, loopback only |
| `--cdp-port <n>` | `9222`, loopback only |
| `--restart-at <expr>` | `*-*-* 02:00:00 America/New_York` |
| `--no-restart` | install no nightly timer |

Include the timezone in `--restart-at`. systemd reads a bare time as UTC.

Give it two gigabytes of headroom counting swap. Chrome idles near 0.5GB, and on
a box without it the OOM killer takes terminal sessions rather than tabs.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

#### Using it

The display has no VNC password. It listens on loopback, so reach it through
SSH, and `sudo vibe-os doctor` fails loudly if it is ever bound anywhere else.

```bash
ssh -L 5900:127.0.0.1:5900 you@host
```

Point any VNC viewer at `127.0.0.1:5900`. TigerVNC Viewer, RealVNC Viewer and
Remmina all connect straight through.

macOS Screen Sharing will not take a server with no authentication: it asks for
a password that does not exist. Give it one, keeping the loopback bind as the
layer that actually protects the box:

```bash
vncpasswd -f <<<'yourpass' > ~/.vibe-os/vncpasswd
chmod 600 ~/.vibe-os/vncpasswd
sudo sed -i 's|-SecurityTypes None|-SecurityTypes VncAuth -PasswordFile '"$HOME"'/.vibe-os/vncpasswd|' \
  /etc/systemd/system/vibe-os-xvnc.service
sudo systemctl daemon-reload && sudo systemctl restart vibe-os-xvnc
```

Then open `vnc://127.0.0.1:5900` and leave the username blank. VNC authentication
is DES-based and truncates at 8 characters, so treat it as a second layer and
not as the thing keeping the box shut. `install-browser` rewrites this unit, so
reapply it after a reinstall.

```bash
systemctl restart vibe-os-chrome     # bounce it now
journalctl -u vibe-os-chrome -f      # what it is saying
sudo systemctl stop vibe-os-chrome vibe-os-wm vibe-os-xvnc    # stop all of it
```

Open a URL in the running instance from a terminal on the box:

```bash
DISPLAY=:99 google-chrome https://example.com
```

The nightly restart closes leftover tabs and returns the memory a day of
browsing took. The profile lives in `~/.vibe-os/chrome` and carries sign-ins
across a restart, so this does not log you out.

#### Extensions

Install by hand through the viewer, or force-install without any interaction:

```bash
sudo mkdir -p /etc/opt/chrome/policies/managed
sudo tee /etc/opt/chrome/policies/managed/vibe-os.json <<'JSON'
{
  "ExtensionInstallForcelist": [
    "fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx"
  ]
}
JSON
sudo systemctl restart vibe-os-chrome
```

That ID is Claude in Chrome. Take any other from its Chrome Web Store URL.

Signing in is interactive, including a captcha, so do it once through the
viewer. Claude in Chrome needs a paid plan.

Anyone who reaches this browser gets whatever it is signed in to. That is the
same token and the same tailnet that already hand out shells, but it is a wider
blast radius than a shell alone.

### Giving the box a GitHub identity

Workspaces are branches, and pushing happens in the terminal, so a box with no
GitHub credentials dead-ends at the first `git push`. Do this as the login user,
not root:

```bash
ssh-keygen -t ed25519 -C "vibe-os@$(hostname)" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

No passphrase: an agent-less prompt would appear inside whichever window ran
`git push`, where nothing can answer it.

Add that key to [github.com/settings/keys](https://github.com/settings/keys)
twice, as an **Authentication key** and as a **Signing key** if you want commits
made here to show as verified:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"   # a verified GitHub email
```

The key covers git. It does not cover the GitHub API, so PRs and issues need
`gh auth login` (choose SSH, which keeps the token confined to API calls).

A push-capable key here means anyone who gets a shell can push to your
repositories. Use a per-repository deploy key instead if that matters, and
accept that `gh` will not work.

### Updating a running box

```bash
bun run build && bun scripts/compile.ts linux-x64
scp dist/bin/vibe-os-linux-x64 you@host:/tmp/vibe-os
ssh you@host 'sudo systemctl stop vibe-os \
  && sudo mv /tmp/vibe-os /usr/local/bin/vibe-os \
  && sudo chmod +x /usr/local/bin/vibe-os \
  && sudo systemctl start vibe-os'
```

Nothing is lost by that restart. Two things it does not pick up:

- **A changed harness command.** An existing session keeps running whatever it
  was started with. Close the window and open it again.
- **Changed service flags.** Those live in the unit, so re-run
  `install-service`.

A reboot is different: dtach sessions do not survive one.

---

## Security

**vibe-os hands out shell access to the machine it runs on.** Every window is
the same unix user, there is no per-user isolation, and anyone who can reach the
port and pass the gate can run anything that user can. Treat access to vibe-os
as equivalent to SSH access to the box.

The recommended shape is all of it: behind Tailscale, firewalled to the tailnet,
bound to the tailnet address, and with the token on.

**The gate is off by default**, which suits a private network, and startup warns
you about it.

```bash
vibe-os --token          # generates one, remembers it, prints the URL
vibe-os --token hunter2  # or pick your own
```

It gates the app, the API, the certificate signer, the wallpaper upload and the
WebSocket bridge. Cross-origin WebSocket upgrades are always rejected.

Open the URL with `?token=…` once and the server sets an `HttpOnly` cookie, then
redirects without the token so it does not linger in history. Scripts can send
`Authorization: Bearer <token>`. Comparison is constant-time.

The cookie value is the token rather than a derived session id, so there is no
per-browser session to revoke. Rotating means changing it on the server.

`--domain` provisions a Let's Encrypt certificate over HTTP-01 and serves HTTPS,
renewing 30 days before expiry. On plain HTTP the browser clipboard API is
unavailable, so copy-on-select and paste stop working and the app cannot be
installed. OSC 52 clipboard *reads* are always refused, since anything running
in a session could otherwise ask what you last copied.

---

## CLI reference

| command | what it does |
| --- | --- |
| `vibe-os` / `vibe-os start` | serve the UI and the SSH bridge |
| `vibe-os attach [window]` | attach this terminal to a window's session |
| `vibe-os doctor` | check this machine is ready, and say what is missing |
| `sudo vibe-os install-service` | write and enable a systemd unit |
| `sudo vibe-os install-browser` | run one Chrome on a virtual display |
| `vibe-os fetch-wasm` | re-download the SSH WASM runtime |

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
--ssh-advertise <host[:port]>
                    host to print in attach commands, when sshd is not on
                    the name the browser reached the desktop on
--user <name>       unix user to log in as (default: current user)
--no-sessions       plain login shells instead of persistent dtach sessions
--cert-ttl <secs>   certificate lifetime (default 43200)

--theme-color <hex> window chrome colour for the installed app (default #1c2128)
--workspace <dir>   where worktrees are created (default ~/workspace)
--state-dir <dir>   CA, TLS material and generated MCP configs
                    (default ~/.vibe-os)
```

`install-browser` takes its own flags:

```
--geometry <WxH>    virtual screen size (default 1600x900)
--display <n>       X display number (default 99)
--vnc-port <n>      VNC port, bound to loopback (default 5900)
--cdp-port <n>      Chrome debug port, bound to loopback (default 9222)
--restart-at <expr> nightly restart, a systemd OnCalendar expression
                    (default '*-*-* 02:00:00 America/New_York')
--no-restart        do not install the nightly restart timer
```

Every option except `--tls-port` and `--cert-ttl` also reads a `VIBE_OS_`
environment variable, which is how the container is configured.

---

## Development

```bash
bun install          # also fetches ssh.wasm from the upstream release
bun run build        # web app + precompressed assets + embedded manifest
bun run dev          # Vite on :5173, proxying to a vibe-os on :7681
bun run dev:server   # the server with --hot, on :7681
bun run compile      # standalone binaries into dist/bin

bun run check        # lint + typecheck + tests, the same three CI runs
bun test             # specs in test/ and beside the code
```

Biome with the recommended rule set and Prettier's defaults. Nothing is switched
off in `biome.json`. The server is TypeScript run directly by Bun, with no build
step of its own.

| | |
| --- | --- |
| server | Bun, TypeScript run directly, `Bun.serve`, no framework |
| storage | SQLite (`bun:sqlite`) via drizzle-orm, idempotent DDL at startup |
| browser | React 19, Vite, xterm.js v6, SWR for polling |
| ssh | `ssh.wasm` in the tab, `ssh-keygen` and `ssh-keyscan` on the host |
| shared | `shared/`: wire types, the grid, the argv tokeniser |

`ssh.wasm` comes prebuilt from
[c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) releases, pinned by tag with
its SHA-256 verified before extraction. To move it, set `SSHTERM_VERSION`, run
`bun run fetch-wasm`, and copy the checksum it prints into `PINNED`.

App icons are generated from `public/icon.svg`:

```bash
rsvg-convert -w 192 -h 192 public/icon-app.svg -o public/icon-192.png
rsvg-convert -w 512 -h 512 public/icon-app.svg -o public/icon-512.png
rsvg-convert -w 180 -h 180 public/icon-app.svg -o public/apple-touch-icon.png
rsvg-convert -w 512 -h 512 public/icon-maskable.svg -o public/icon-maskable-512.png
```

---

## Project status

Usable and in daily use, but young. No release binaries are published yet, so
build one or run the container.

Everything in [Deploying on a VPS](#deploying-on-a-vps) has been walked end to
end on a fresh OVHcloud VPS on Ubuntu 26.04, behind Tailscale, serving HTTPS.
The firewall rules were checked from outside the tailnet.

Known gaps:

- **No authentication by default.** The token gate is off until you pass
  `--token`, and there is no multi-user story at all.
- **ACME has never issued a real certificate.** `--domain` works in tests, but
  the Tailscale path makes it unnecessary, so it stays unproven.
- **IPv6 reachability is unverified.** The v4 firewall rules were tested from
  outside; the v6 rules mirror them and default to `DROP`, but that was read
  from the box rather than probed.
- **No keyboard shortcuts.** Deliberate, see [the desktop](#the-desktop), but
  something that does not steal keys from the terminal is worth having.
- **MCP servers can be picked but not added.** Adding them is `claude mcp` on
  the box.
- **No branch operations.** Pushing, PRs and merging happen in the terminal.
- **Deleting a workspace keeps its branch**, so work is recoverable. Nothing
  prunes them for you.

---

## Contributing

Issues and pull requests welcome. Before opening one:

```bash
bun run check     # lint, typecheck and tests, the same three CI runs
```

Tests live in `test/` for the server and beside the code for the browser.
Anything with logic worth trusting should arrive with some.

[docs/gotchas.md](docs/gotchas.md) lists the traps in this codebase that cost
someone an afternoon. Worth a skim before changing the terminal or the session
plumbing.

Comments in this repository explain why rather than what. If you undo a
documented decision, update the reasoning with it.

---

## License

MIT. Bundles [c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) (MIT).
