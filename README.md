# vibe-os

A coding desktop in the browser, on a box you own. Switch between the git repos
on a machine, spin up a worktree per piece of work, and open terminals into it —
all over HTTP from anything with a browser.

> **Status:** works end to end, and has only ever run in Docker. `--domain`
> (Let's Encrypt) and `install-service` have not been exercised on real
> hardware. No release binaries are published yet, so build one (below) or run
> the container.

Open the desktop and you get a project picker, a sidebar of workspaces, and
windows you can drag around a snap grid over a wallpaper. Every window is a tmux
session in its workspace's worktree, so closing the tab and coming back tomorrow
finds whatever was running still running.

There is nothing to configure. No key to copy and paste, no `authorized_keys` to
edit, no `sshd_config` change, and no root.

## Run it

The fastest way to see it, and the one that is actually tested:

```bash
docker compose up --build
open http://localhost:8080
```

The container is a blank Debian box with sshd, tmux and git — the same shape as
a fresh VPS, so it exercises the real thing: vibe-os generates its CA, writes
the `cert-authority` line, discovers the host key, and binds port 80 as an
unprivileged user via `setcap`.

The runtime stage contains **no Bun, Node or npm** — plain Debian, OpenSSH, tmux
and one compiled binary. If anything the server needed at runtime were not
actually embedded in that binary, the container would fail to start rather than
quietly work because a source tree happened to be lying around.

Two differences from a VPS worth knowing:

- `localhost` counts as a **secure origin**, so clipboard copy/paste works here
  even over plain HTTP. Reached by bare IP on a VPS, it would not.
- The startup banner prints the container's bridge address (`172.x.x.x`), which
  the host cannot reach. Use `localhost:8080`. On a VPS that same line prints
  the address you actually want.

Both volumes are worth keeping: `vibe-home` preserves the CA and your work,
`vibe-sshd` preserves the container's host keys so the browser does not report
the host key as changed after a rebuild.

---

## On a VPS

> **Not yet run on a real VPS.** Everything below is exercised by the Docker
> rehearsal, which is faithful for sshd, tmux and certificates. `install-service`
> and the firewall steps are the parts only a real box exercises.

### What the box needs

vibe-os is one binary with no runtime dependencies, but it shells out to a few
things and logs in through the machine's own sshd. These are the prerequisites:

| Package | What uses it | Without it |
| --- | --- | --- |
| `openssh-server` | every window logs in through it | nothing connects |
| `openssh-client` | `ssh-keygen` signs certificates, `ssh-keyscan` finds the host key to pin | **the server refuses to start** |
| `tmux` | wraps every window | windows become plain shells that die on reload, and **profiles launch no harness at all** |
| `git` | projects and worktrees | no projects |
| `gh` | opening and merging pull requests from a window | the workflow stops at `git push` |
| `claude` | the Claude harness | those profiles fall back to a shell |

```bash
sudo apt update && sudo apt install -y openssh-server openssh-client tmux git gh
curl -fsSL https://claude.ai/install.sh | bash      # standalone, needs no Node
```

Verified on **Debian 12 and 13** and **Ubuntu 24.04 and 26.04 LTS**, x86\_64,
from the compiled binary — `vibe-os doctor` clean on each. The binary is
dynamically linked against glibc and was built against an old baseline, so
anything from bookworm onward is fine.

If you intend to run a real browser on this box for Claude's Chrome
integration, install **Google Chrome's own .deb** rather than the distribution's
`chromium` package. On Ubuntu that package is a snap, and snap confinement is a
known breaker of native messaging hosts — which is exactly the mechanism the
Claude extension uses to reach a local Claude Code.

`tmux` is the one people skip. It is not a nicety here: the harness command
lives in the tmux invocation, so without it a profile opens a shell and does
nothing else.

### Install

```bash
# a self-contained binary — no Bun, Node or npm on the target
bun run compile              # writes dist/bin/vibe-os-linux-{x64,arm64}
scp dist/bin/vibe-os-linux-x64 you@host:/usr/local/bin/vibe-os
ssh you@host 'chmod +x /usr/local/bin/vibe-os'
```

```bash
# or from a checkout, which needs Bun on the target
bun install && bun run build && bun bin/vibe-os.mjs start
```

The binary carries the whole app, including the 20MB SSH WASM runtime. Once
releases are published the first path collapses into a single `curl`.

Then, before starting anything:

```bash
vibe-os doctor          # and again with sudo — see below
```

### Check it, twice

`vibe-os doctor` answers the one question that matters: will a certificate this
host signs actually be accepted for this user? It reads sshd's *effective*
configuration to do it, which catches the failures that otherwise show up in a
browser as `handshake failed` and nowhere else — a non-default
`AuthorizedKeysFile`, an `AllowUsers` list that omits your user,
`PubkeyAuthentication no`, or a home directory that is group-writable and so
silently ignored under `StrictModes`.

Reading sshd's effective config needs root, so run it **both ways**:

```bash
vibe-os doctor          # everything that does not need privileges
sudo vibe-os doctor     # adds the sshd checks — this is the one that matters
```

Without root it says so rather than guessing:

```
! sshd config    could not read sshd's effective config — the checks below are the defaults, not the truth
```

### Behind Tailscale

This is the recommended way to run it, and not only for the network. Tailscale
removes the two riskiest parts of a public deployment: you stop needing to bind
port 80, and you stop needing Let's Encrypt.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# high port — no root, no setcap, no capability in the systemd unit
vibe-os start --port 7681 --token

# HTTPS on your tailnet name, certificate provisioned automatically
sudo tailscale serve --bg 7681
```

That serves it at `https://<machine>.<tailnet>.ts.net`, and gives you three
things beyond privacy:

- **A real certificate**, so `--domain` and the whole ACME path stay unused.
- **A secure origin**, which is what the browser requires before it will expose
  `navigator.clipboard`. Copy-on-select and paste-on-right-click start working
  in the terminals — over plain HTTP on a bare IP they silently do not.
- **No privileged port**, so no `setcap` and no `CAP_NET_BIND_SERVICE`.

Enabling HTTPS for your tailnet is a one-time toggle in the admin console;
`tailscale serve` will tell you if it is off.

### Firewall: tailnet only

Tailscale does not close ports for you. Until you do, the machine is still
answering on its public address, and vibe-os hands out shells.

**Do not lock yourself out.** Confirm you can reach the box over the tailnet in
a second terminal *before* denying anything, and know where your provider's
serial or rescue console is.

```bash
sudo ufw allow in on tailscale0        # anything arriving over the tailnet
sudo ufw allow 41641/udp               # lets Tailscale make direct connections
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

`41641/udp` is worth understanding rather than pasting: without it Tailscale
still works, but falls back to relaying through DERP, which is slower. It is
not a hole in the tailnet — it is how peers find each other directly.

Note there is no `allow 22` here. Once the rules are in place, SSH arrives over
the tailnet like everything else. If you would rather keep a public SSH door
open while you gain confidence, add `sudo ufw allow 22/tcp` and remove it later.

The nftables equivalent, if you are not using ufw:

```bash
sudo nft add rule inet filter input iifname "tailscale0" accept
sudo nft add rule inet filter input udp dport 41641 accept
```

**Your provider's firewall is a separate thing.** AWS security groups, OVH's
Network Firewall, Hetzner firewalls, DigitalOcean cloud firewalls and the rest
sit in front of the machine and know nothing about ufw. Close 80 and 443 there
too, and leave only what you actually serve publicly, which with Tailscale is
nothing.

OVH's is worth singling out because it is *stateless*: it filters each packet on
its own with no idea which connection it belongs to, so a naive "allow
established" rule does not exist and blocking inbound UDP will quietly break
Tailscale's direct connections. If you use it, leave `41641/udp` open there as
well as in ufw, or accept that every packet relays through DERP.

Finally, belt and braces — bind vibe-os to the tailnet address so it is not
listening on the public interface at all:

```bash
vibe-os start --port 7681 --token --host 100.x.y.z
```

`vibe-os doctor` reports on this directly, and prints your tailnet address when
it finds one:

```
! exposure       no token and bound to every interface — Tailscale is up (100.x.y.z), but so is any public address
                 bind to the tailnet only:  --host 100.x.y.z
```

### Do not run it as root

A fresh VPS logs you in as root, and vibe-os hands out shells as whoever it runs
as. Make an account first — everything above assumes you have:

```bash
adduser --gecos "" vibe
usermod -aG sudo vibe
su - vibe          # and do the rest from here
```

`install-service` refuses to write a unit that runs as root rather than letting
you find out later, and the CA line only means anything in the home directory of
the user who actually logs in.

### Give the box a GitHub identity

Workspaces are git worktrees on their own branches, and vibe-os deliberately
stops there — pushing, PRs and merging happen in the terminal. So a box with no
GitHub credentials is a box where the whole workflow dead-ends at the first
`git push`. Do this as the login user, not root: the key has to live in the home
directory that windows actually log into.

```bash
ssh-keygen -t ed25519 -C "vibe-os@$(hostname)" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

No passphrase, deliberately. An agent-less passphrase prompt appears inside
whichever window happens to run `git push`, which is not somewhere an agent can
answer it. The security boundary here is who can reach the box, not the key file.

Add that public key to GitHub **twice**, at
[github.com/settings/keys](https://github.com/settings/keys):

- as an **Authentication key**, which is what makes clone and push work
- as a **Signing key**, if you want commits made here to show as *Verified*

Signing is worth the extra minute when an agent is doing the committing, because
it is the only thing that distinguishes a commit that really came from your
machine:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"   # must match a verified GitHub email
```

Then install the GitHub CLI and log in, because `gh` is what opens and merges
pull requests — an SSH key alone does not:

```bash
sudo apt install -y gh
gh auth login          # choose SSH, and the key you just made
```

Check both halves before trusting them:

```bash
ssh -T git@github.com     # "Hi <you>! You've successfully authenticated"
gh auth status
```

One thing to be clear-eyed about: a push-capable key on this box means anyone
who gets a shell here can push to your repositories, and vibe-os hands out
shells. That is an argument for the token gate and the firewall rules above, and
for keeping this box as trusted as the laptop you would otherwise be typing on.
If you would rather it could not push everywhere, use a per-repository deploy
key instead and accept that `gh` will not work.

### Keeping it running

```bash
sudo vibe-os install-service --port 7681 --token hunter2
journalctl -u vibe-os -f
```

Run it with `sudo` **from your own account**, not as root — it takes the user
from `SUDO_USER`, resolves that account's real home from its passwd entry, and
writes a unit that runs as them. It forwards whatever flags you passed, so the
service behaves exactly like the command you just tested by hand.

It also grants `CAP_NET_BIND_SERVICE`, which you no longer need if you took the
Tailscale path above — harmless, but that is why it is there.

---

## How it works

```
┌─────────────────┐                        ┌──────────────────┐        ┌──────┐
│     browser     │   wss://…/websocket    │  vibe-os (bun)   │  TCP   │ sshd │
│   ssh.wasm      │ ─────────────────────► │    :80 / :443    │ ─────► │  :22 │
│  private key    │                        │   byte pipe      │        │      │
│  in IndexedDB   │   POST /api/ssh/…      │   + SSH CA       │        │ tmux │
└─────────────────┘ ─────────────────────► └──────────────────┘        └──────┘
```

**The SSH protocol runs inside the browser.** Key exchange, authentication and
channel multiplexing all happen in a Go/WASM sandbox in the tab. The server is a
byte pipe that understands nothing about SSH — it never sees plaintext and holds
no credentials for your session.

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

2. Each window generates its own keypair inside the WASM sandbox. The private
   half stays in IndexedDB and never crosses the network.

3. The window POSTs only its **public** key to `/api/ssh/certificate`. The
   server signs it and returns a certificate valid for 12 hours.

4. sshd accepts it because of that one `cert-authority` line.

No private key is ever transmitted. Certificates expire on their own, and
revoking every browser that ever connected is deleting one line.

### How windows stay alive

Each certificate carries a per-window `force-command` critical option:

```
force-command tmux -u new-session -A -s 'vibe-quiet-amber-otter-1' \
                  -c '/home/you/workspace/.vibe-worktrees/my-repo/quiet-amber-otter'
```

The session name comes from the workspace, and `-c` is what puts the shell in
that workspace's worktree. Both are resolved server-side from the window id —
the browser sends an id and never names a directory.

`new-session -A` attaches if the session exists and creates it otherwise, so a
window reattaches to exactly what it was running before. Because the client
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
--tmux-status       show tmux's own status bar inside each window
--no-tmux-theme     leave tmux's colours alone
--cert-ttl <secs>   certificate lifetime (default 43200)

--workspace <dir>   where worktrees are created (default ~/workspace);
                    projects are discovered across the host, not just here
--state-dir <dir>   CA and TLS material (default ~/.vibe-os)
```

### Projects and workspaces

The picker in the top-left switches between git repositories on the machine.
**Refresh** walks the disk for them — bounded by depth, a skip list and a visit
budget, and only ever on that button, never on a poll.

Each project has **workspaces** in the sidebar. A workspace is a git worktree on
its own branch, named with three random words, so they are cheap to make and
safe to throw away. Terminals belong to a workspace: switching workspaces swaps
which windows are on screen and restores their placement, while the sessions you
left keep running — switching detaches, only ✕ ends anything.

Every terminal starts in its workspace's worktree. That path is resolved
server-side from the window id; the browser never names a directory.

**`git push` works with no arguments** from a new workspace. A branch made by
`worktree add -b` normally has no upstream, so the first push stops with a
command to copy — a papercut on every workspace, which is most of them. So
creating a workspace sets `push.autoSetupRemote` on the project, and push
establishes the tracking branch itself when it creates the remote branch.

Nothing is pushed for you, and no branch appears on the remote until you push
one. The alternative — writing the tracking config up front — points the branch
at a ref that does not exist yet, so `git status` reads
`## name...origin/name [gone]` until the first push, and "gone" is what git says
about an upstream someone deleted. This way status stays clean.

The setting lands on the project repository, because worktrees share their
repository's config. It is skipped for a project with no remote, and an existing
value is left alone — including a deliberate `false`.

### What terminals in a workspace share

Every window in a workspace opens in the same worktree, so they share one
checkout, one branch, and one git index — `.git/worktrees/<name>/index`. Editing
a file in one window changes it for all of them, which is the point: a workspace
is one piece of work, and the roles on the rail are people looking at it
together.

The catch is that git takes a lock on that index for anything that writes, so
two agents running `git add` or `git commit` in the same workspace at the same
moment will collide:

```
fatal: Unable to create '.../index.lock': File exists.
```

Nothing is corrupted — one of them simply loses and has to retry — but it is
worth knowing before you point three Claude sessions at one workspace and ask
them all to commit. Reading, building, testing and analysing in parallel is
fine; it is only the index that is exclusive.

If two pieces of work genuinely need to proceed independently, give them a
workspace each. Different workspaces have different worktrees, different
branches and different index files, so they never contend at all — which is what
workspaces are for.

State lives in SQLite in the state directory, reached over the API, so a desktop
follows you between browsers and machines. The sidebar polls once a minute and
on window focus — a VPS is not a realtime database and a minute of staleness
costs nothing.

### Profiles

The rail on the right lists the roles you can open a terminal as — *QA
Engineer*, *Backend Manager*, whatever your work divides into. Clicking one
opens a window, launches its harness in the worktree, and offers its standing
prompt above the terminal. Profiles belong to a project and appear in every
workspace of it, because the prompts and flags describe the codebase while
workspaces are worktrees you throw away.

A profile carries a name, one of ten colours, a harness (`claude`, a plain
shell, or any command on the box) with its flags, and a prompt. The colour is
the point of the thing: it tints the window, its title bar and its dock entry,
so three roles running at once are distinguishable without reading anything. A
role window also gets a taller header with the role's name at the top of the
hierarchy and the tmux session name demoted beneath it.

Clicking a role that is already open **raises that window** rather than starting
a second one — a workspace usually wants one of each. Alt-click when it does
not.

Flags are stored as a list of arguments, not a command line, and each is quoted
on its own when the launch command is built. `--model 'opus; rm -rf /'` is one
argument containing a semicolon, not two commands. The browser never sends a
command at all: the window row says which profile it was opened as, and the
server resolves the rest, exactly as it already does for the worktree path.

The editor offers a few Claude flags as one-click chips; everything else goes in
the arguments field, which takes whatever the harness understands. Two of the
chips are worth knowing the shape of:

- **`--remote-control`** works anywhere. It needs nothing on the box beyond
  outbound network, which makes it a natural fit here — the session is on the
  VPS either way, and this just gives you a second way to reach it.
- **`--chrome`** needs Chrome, with the Claude extension, running on the *same
  machine as Claude Code*: the two talk over a native messaging host, which is a
  local process the browser spawns. So it works when you run vibe-os on your own
  machine, and does not when Claude is on a VPS and Chrome is on your laptop.
  Passing it on a box with no Chrome is harmless — the session starts normally,
  just without browser tools.

The harness runs as `<command> <args>; exec "$SHELL"`. The tail matters — tmux
ends a session when its last pane exits, so without it, quitting Claude would
take the desktop window with it. And because windows attach with
`new-session -A`, which ignores a shell-command when it attaches, reloading the
page rejoins the running harness instead of starting a second one on top.

#### The prompt band

The band above the terminal offers the prompt two ways, and the second is the
one that always works.

**Copy** puts it on the clipboard. **Send** writes it straight into the SSH
session and lets xterm wrap it in bracketed-paste markers, so a multi-line
prompt arrives in Claude's composer as one unsent block rather than submitting
itself on the first newline.

Send exists because `navigator.clipboard` **does not exist at all** on a page
served over plain HTTP to an IP address — which is the deployment this project
is for. Copy falls back to `execCommand`, which still works there; pasting *into*
the terminal has no such fallback. Either button dismisses the band, and that
sticks across reloads, per window.

Deleting a profile leaves any window already running it alone — those are live
sessions with real work in them. The window just becomes an ordinary terminal.

### Popping a terminal out

The ⇗ button in a window's title bar opens that terminal in its own browser
window, which is worth having when a role needs a whole screen rather than a
tile on someone else's.

There is nothing clever underneath. Both views address the same window id, the
server turns that into the same tmux session, and tmux is what actually holds
the terminal — so popping out is just detaching one client and attaching
another, and everything running carries on.

The desktop shows a placeholder while a terminal is popped out, rather than
mirroring it. tmux is perfectly happy with two clients on one session and would
show the same thing in both, but it sizes a session to its *smallest* client, so
a mirrored pair drags itself down to whichever window is narrower. One client at
a time means the pop-out gets the size it actually has.

Closing the pop-out, or pressing **Bring it back**, returns the terminal to the
desktop with its scrollback intact. Reloading the desktop while a pop-out is
open does not disturb it: the desktop asks who is out there and every live
pop-out answers, so it knows to keep showing the placeholder.

### The desktop

Windows float over a wallpaper and snap to a 24 × 14 grid. Drag a title bar to
move, drag any edge or corner to resize; the grid only appears while you are
dragging, with the destination cell lit up. Double-click a title bar to fill the
desktop.

Chords use `alt`, not tmux's `ctrl-b` — the terminal has focus nearly all the
time and `ctrl-b` belongs to the tmux session running inside it.

| key | action |
| --- | --- |
| `alt` `t` | open a window |
| `alt` `1`…`9` | raise window n |
| `alt` `z` | maximise / restore |
| `alt` `m` | minimise to the dock |
| `alt` `w` | close the window and end its session |
| `alt` `n` | create a workspace |

Closing a window ends the session behind it; **minimise** puts one away and
keeps it running. Reloading or closing the tab keeps everything — persistence
only gives way to an explicit dismissal.

tmux's own status bar is hidden, because the window's title bar already shows
the session name and state and the menu bar shows the host. `--tmux-status`
brings it back, which is worth it if you split panes inside a window.

### Wallpaper

The dock's ◑ button opens the picker. Uploads are stored on the server, not in
the browser, so the same desktop appears on every device you open it from.
Images are content-addressed by hash and their type is decided by sniffing magic
bytes — not by the filename or the declared Content-Type, since these get served
back to a browser and a mislabelled HTML file would be a stored-XSS primitive.

The **Dim** slider darkens the wallpaper behind the windows. Terminal text sits
on a 62% plate over the glass, which reads well on most images; turn Dim up for
a busy or bright one.

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
there is no per-user isolation — every window is the same unix user. Treat access
to vibe-os as equivalent to SSH access to the box, because it is.

Which is the argument for not relying on the gate alone. A token is one secret
in front of a shell; a closed port is not reachable at all. On a VPS, put it
behind Tailscale, [close everything else at the firewall](#firewall-tailnet-only),
and bind to the tailnet address — then keep the token as well. `vibe-os doctor`
reports on exactly this and will tell you when you have a shell on a public
interface with no gate in front of it.

### TLS

Plain HTTP on port 80 works out of the box on a bare IP. Pass `--domain` and it
provisions a Let's Encrypt certificate over HTTP-01 (it already owns port 80),
serves HTTPS, and redirects. Certificates are renewed 30 days before expiry.

On plain HTTP the browser clipboard API is unavailable — the origin is not a
secure context — so copy-on-select and paste-on-right-click stop working. A
profile's prompt is unaffected either way: its **Send** button writes into the
session directly and never touches the clipboard.

There are two ways to get a secure origin, and the second is easier than the
first: `--domain` and Let's Encrypt, or [`tailscale serve`](#behind-tailscale),
which provisions a certificate for your `.ts.net` name with no domain to own, no
ACME, and no port 80. The ACME path is also the one part of this codebase that
has never run outside a test.

---

## Port 80

Binding it needs root or `CAP_NET_BIND_SERVICE`. On a fresh VPS you are usually
root and it just works. Otherwise vibe-os falls back to port 8080 and tells you
how to fix it:

```bash
# the compiled binary
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/vibe-os
# or, if running from a checkout, the Bun that executes it
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which bun)")"
```

or let systemd handle it, which grants the capability without setcap at all:

```bash
sudo vibe-os install-service --user "$USER"
journalctl -u vibe-os -f
```

Or sidestep it: run on a high port with
[`tailscale serve`](#behind-tailscale) in front. Nothing privileged is involved,
and you get HTTPS as well.

---

## Development

```bash
bun install          # also fetches ssh.wasm from the upstream release
bun run build        # web app + precompressed assets + embedded manifest
bun run dev          # Vite on :5173, proxying to a vibe-os on :7681
bun run dev:server   # the server with --hot, on :7681
bun run compile      # standalone binaries into dist/bin
```

The server is TypeScript run directly by Bun — there is no build step for it.
`bun run compile` bundles it with every web asset into one executable per
platform.

`ssh.wasm` (~19 MB) comes prebuilt from
[c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) releases rather than being
compiled here, so no Go toolchain is needed on the target machine. The build
precompresses it to about 4.5 MB of brotli, which is what visitors actually
download.

Pin a version with `SSHTERM_VERSION=v0.8.3 bun run fetch-wasm`.

### Stack

| | |
| --- | --- |
| server | Bun, TypeScript run directly, `Bun.serve` — no framework |
| storage | SQLite (`bun:sqlite`) via drizzle-orm, idempotent DDL at startup |
| browser | React 19, Vite, xterm.js v6, SWR for polling |
| ssh | `ssh.wasm` in the tab; `ssh-keygen` and `ssh-keyscan` on the host |

Two runtime dependencies: `drizzle-orm` and `acme-client`. Everything else is a
devDependency and ends up bundled.

### Things that will bite you

**One Go runtime serves the whole page.** Every window calls `start()` on the
same WASM instance, and an unhandled Go panic in *any* window kills the runtime
for *all* of them. Two consequences: teardown order in `SshTerminal.tsx` is
load-bearing (close the session and await `done` *before* disposing the
Terminal — React StrictMode's double-mount hits this immediately), and
`onRuntimeDead` exists so the app can rebuild every window instead of leaving
you with terminals that look fine but accept no input.

**Host key algorithm order is not the obvious one.** golang.org/x/crypto/ssh's
`supportedHostKeyAlgos` puts ECDSA *ahead* of Ed25519 — the opposite of OpenSSH.
vibe-os discovers the host key with `ssh-keyscan` in that order, because pinning
a key the server holds but does not present makes every window report the host key
as **changed**, which reads like an attack rather than a misconfiguration.

**tmux is detected on the machine vibe-os runs on**, which is the SSH target by
default. If you point `--ssh-host` somewhere else, pass `--tmux` explicitly.

**Upstream prints a banner into every session** from `internal/start.go`, with
no option to disable it. It is filtered in `SshTerminal.tsx` by wrapping the
terminal object handed to Go, rather than by forking the Go source — building
ssh.wasm ourselves would cost the "prebuilt from upstream releases, no Go
toolchain on the VPS" property. The filter switches itself off at the first line
that is not part of the banner, so it cannot swallow real output.

**xterm's `allowTransparency` is not enough to see through a terminal.** It
covers the cell layer; xterm 6 also paints an opaque background on the element
it mounts into and on its scrollable wrapper. Miss those and the terminal
renders perfectly while punching a solid black rectangle through the glass — the
effect just silently disappears. styles.css clears them explicitly.

**BunFile.stat() returns undefined for embedded files** rather than a rejected
promise, so `.catch()` on it throws. Use `.size`, which works in both modes.
Embedded assets have no mtime either, so their ETag version comes from the
generated `BUILD_ID`.

**A compiled Bun binary keeps the same argv shape as `bun run`** —
`[runtime, entry, ...args]`, where the entry reads as `/$bunfs/root/<name>`.
Assuming a standalone executable drops the entry slot turns that path into the
subcommand.

---

## What is not here yet

- **Never run on a VPS.** `install-service` and the firewall steps are what
  Docker cannot rehearse. Taking the [Tailscale path](#behind-tailscale) leaves
  `--domain` and ACME unused, which is convenient, because that code has never
  run outside a test either.
- **No authentication by default.** The token gate exists and works; it is off
  until you pass `--token`. There is no multi-user story at all.
- **No keyboard shortcuts for profiles.** The rail is click-only; `alt` plus a
  digit already raises windows, and a second chord deserves its own thought.
- **No branch operations.** Workspaces create a worktree and a branch; pushing,
  PRs and merging happen in the terminal.
- **Deleting a workspace keeps its branch**, deliberately, so work is
  recoverable — nothing prunes those branches for you.

## License

MIT. Bundles [c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) (MIT).
