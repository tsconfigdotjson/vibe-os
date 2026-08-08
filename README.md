# vibe-os

A coding desktop in the browser, on a box you own. Switch between the git repos
on a machine, spin up a worktree per piece of work, and open terminals into it —
all over HTTP from anything with a browser.

> **Status:** running on a real VPS as of 2026-08-07 — an OVHcloud box on
> Ubuntu 26.04, behind Tailscale, serving over HTTPS with a Let's Encrypt
> certificate, with Claude launching into worktrees from the profile rail.
> `systemctl` and `tailscale serve` are proven; `--domain` (Let's Encrypt via
> ACME) remains untested, because taking the Tailscale path means never
> reaching for it. No release binaries are published yet, so build one (below)
> or run the container.

Open the desktop and you get a project picker, a sidebar of workspaces, and
windows you can drag around a snap grid over a wallpaper. Every window is a dtach
session in its workspace's worktree, so closing the tab and coming back tomorrow
finds whatever was running still running.

Down the right is a rail of **profiles** — the roles you work as. *QA Engineer*,
*Backend Manager*, whatever your work divides into. Each carries a colour, a
harness with its settings, and a standing prompt that can leave blanks for you
to fill in. Click one and you get a window tinted in its colour with Claude
already running in the worktree and the prompt waiting above it. Any terminal
can be popped out into its own browser window and brought back, with everything
still running.

There is nothing to configure. No key to copy and paste, no `authorized_keys` to
edit, no `sshd_config` change, and no root.

## Run it

The fastest way to see it, and the one that is actually tested:

```bash
docker compose up --build
open http://localhost:8080
```

The container is a blank Debian box with sshd, dtach and git — the same shape as
a fresh VPS, so it exercises the real thing: vibe-os generates its CA, writes
the `cert-authority` line, discovers the host key, and binds port 80 as an
unprivileged user via `setcap`.

The runtime stage contains **no Bun, Node or npm** — plain Debian, OpenSSH, dtach
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

> These steps were walked end to end on a fresh OVHcloud VPS, and the two
> things that broke there were both PATH: a forced command does not get a login
> shell, and a systemd service does not get one either. Both are fixed. The
> firewall section is the part still taken on trust.

### What the box needs

vibe-os is one binary with no runtime dependencies, but it shells out to a few
things and logs in through the machine's own sshd. These are the prerequisites:

| Package | What uses it | Without it |
| --- | --- | --- |
| `openssh-server` | every window logs in through it | nothing connects |
| `openssh-client` | `ssh-keygen` signs certificates, `ssh-keyscan` finds the host key to pin | **the server refuses to start** |
| `dtach` | keeps every window alive across reloads | windows become plain shells that die on reload, and **profiles launch no harness at all** |
| `git` | projects and worktrees | no projects |
| `gh` | pull requests, issues and reviews — *optional* | git still works; the GitHub API does not |
| `claude` | the Claude harness | those profiles open a window that closes again immediately |

```bash
sudo apt update && sudo apt install -y openssh-server openssh-client dtach git gh
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

`dtach` is the one people skip. It is not a nicety here: the harness command
lives in the dtach invocation, so without it a profile opens a shell and does
nothing else.

It is deliberately dtach and not tmux. A window needs exactly two things from a
session manager — survive a reload, and let a real terminal take over — and tmux
brings a second terminal emulator along with them. That emulator keeps its own
model of your screen and sends only the cells it thinks changed, so any
momentary disagreement with the browser's terminal becomes permanent: it will
not resend a cell it believes is already correct. dtach keeps no model. It holds
the pty and moves bytes, and the program talks to your terminal directly.

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

# Loopback, not the tailnet address: `tailscale serve` proxies to 127.0.0.1,
# and it is the only thing that should be able to reach the plain HTTP port.
# Binding the tailnet address instead gives a 502 — serve cannot reach it.
vibe-os start --port 7681 --host 127.0.0.1 --token

# HTTPS on your tailnet name, certificate provisioned automatically
sudo tailscale serve --bg 7681
```

Enabling HTTPS for the tailnet is a one-time toggle in the admin console, and
`tailscale serve` says so if it is off. `--token` with no value generates one
and remembers it; the startup log prints the URL with it filled in.

That serves it at `https://<machine>.<tailnet>.ts.net`, and gives you three
things beyond privacy:

- **A real certificate**, so `--domain` and the whole ACME path stay unused.
- **A secure origin**, which is what the browser requires before it will expose
  `navigator.clipboard`. Copy-on-select and paste-on-right-click start working
  in the terminals — over plain HTTP on a bare IP they silently do not.
- **No privileged port**, so no `setcap` and no `CAP_NET_BIND_SERVICE`.

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

### Pushing a change to a box that is already running

```bash
bun run build && bun scripts/compile.ts linux-x64
scp dist/bin/vibe-os-linux-x64 you@host:/tmp/vibe-os
ssh you@host 'sudo systemctl stop vibe-os \
  && sudo mv /tmp/vibe-os /usr/local/bin/vibe-os \
  && sudo chmod +x /usr/local/bin/vibe-os \
  && sudo systemctl start vibe-os'
```

Nothing is lost by that restart: workspaces, profiles and window layout are in
SQLite, and the terminals are dtach sessions the server does not own. Reload the
browser and every window reattaches to whatever was running.

Two things that restart does *not* pick up, both worth knowing before you
conclude a change did not work:

- **A changed harness command.** A window attaches to its existing socket if one
  is live, and the command only runs when the session is created, so an existing
  session keeps running whatever it was started with. Close the window and open
  it again — reloading is not enough.
- **Changed service flags.** The port, bind address and token live in the unit,
  so re-run `sudo vibe-os install-service …` with the new ones.

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

That key covers the git protocol — clone, fetch, pull, push. It does **not**
cover the GitHub API, which is a separate authentication system: pull requests,
issues and reviews are HTTPS calls that take an OAuth token, and no SSH key can
sign one. So if you want to open or merge a PR from a window — or want an agent
in one to do it — the CLI needs its own login:

```bash
sudo apt install -y gh
gh auth login          # choose SSH, so git keeps using the key above
```

Skip it if your habit is to push from the box and open the PR in a browser
somewhere else; nothing else degrades. Choosing SSH at the prompt is what keeps
the token confined to API calls rather than taking over git as well.

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
│  in IndexedDB   │   POST /api/ssh/…      │   + SSH CA       │        │dtach │
└─────────────────┘ ─────────────────────► └──────────────────┘        └───▲──┘
                                                                           │
┌─────────────────┐                                                        │
│  your terminal  │   ssh -t … vibe-os attach quiet-amber-otter-1           │
│   ssh + dtach   │ ──────────────────────────────────────────────────────►─┘
└─────────────────┘
```

The bottom route is the same session by a different door: your own ssh client,
your own key, straight to sshd, with vibe-os nowhere in the path except to have
told you what to type. See [popping out to a real
terminal](#popping-out-to-a-real-terminal).

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
force-command dtach -p '~/.vibe-os/sessions/vibe-quiet-amber-otter-1.sock' … \
              || dtach -n '…/vibe-quiet-amber-otter-1.sock' -E -z /bin/sh -c \
                    'cd /home/you/workspace/.vibe-worktrees/my-repo/quiet-amber-otter && …'
              ;  exec dtach -a '…/vibe-quiet-amber-otter-1.sock' -E -z -r winch
```

The socket name comes from the workspace, and the `cd` is what puts the shell in
that workspace's worktree. Both are resolved server-side from the window id —
the browser sends an id and never names a directory.

`dtach -p` is a liveness probe: it writes to the socket and fails on a dead one,
so a session left behind by a crash is replaced instead of blocking every later
attach. Creating with `-n` and attaching with `-a` is deliberate rather than
using `-A` for both — the two differ in argv, which is what lets the server
detach a client without any risk of killing the session itself. `-E` gives the
detach key back to the program, and `-r winch` asks it to repaint on attach,
since dtach stores no screen to replay. Because the client
requests a *shell* (not an exec), sshd allocates a real PTY and then runs the
forced command inside it — so resize, job control and full-screen programs all
behave.

This detail is load-bearing and easy to get wrong. sshterm's `autoConnect.command`
option looks like the obvious place to put the session command, but it takes
upstream's `session.Run(command)` path, which requests **no PTY and installs no
resize handler**. dtach fails outright there. The command has to travel in the
certificate instead.

That command is built in one place, `server/session.ts`, and has two callers:
the certificate signer above, and `vibe-os attach`. They must not drift — a
window has to be the same window whichever door you come in by — so neither
composes a dtach invocation of its own.

---

## Commands

| command | what it does |
| --- | --- |
| `vibe-os` / `vibe-os start` | serve the UI and the SSH bridge |
| `vibe-os attach [window]` | attach this terminal to a window's session |
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
--ssh-advertise <host[:port]>
                    host to print in attach commands, when sshd is not on
                    the name the browser reached the desktop on
--user <name>       unix user to log in as (default: current user)
--no-sessions       plain login shells instead of persistent dtach sessions
--cert-ttl <secs>   certificate lifetime (default 43200)

--workspace <dir>   where worktrees are created (default ~/workspace);
                    projects are discovered across the host, not just here
--state-dir <dir>   CA, TLS material and generated MCP configs
                    (default ~/.vibe-os)
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
hierarchy and the session name demoted beneath it.

**Quitting the harness closes the window.** A window opened as a role exists to
run that role, so leaving Claude ends the session rather than dropping you into
a shell in the worktree — which would leave a window behind to be tidied up by
hand after every finished conversation. It closes everywhere at once, the
browser tile and any terminal attached to the same session, because there is
only one session underneath. ⟳ opens it again with the harness relaunched.

The cost is that a harness which cannot start at all — the wrong command, or a
PATH that does not reach it — closes the window before the error can be read.
`vibe-os doctor` and `journalctl -u vibe-os` are where that shows up. If you
want a shell in the worktree, that is what a plain-shell profile is for.

Clicking a role that is already open **raises that window** rather than starting
a second one — a workspace usually wants one of each. When it does not, a live
row grows a **+** on hover, which opens another.

Flags are stored as a list of arguments, not a command line, and each is quoted
on its own when the launch command is built. `--model 'opus; rm -rf /'` is one
argument containing a semicolon, not two commands. The browser never sends a
command at all: the window row says which profile it was opened as, and the
server resolves the rest, exactly as it already does for the worktree path.

The editor does not ask you to know any of that. A model dropdown, a thinking
dropdown, a permission dropdown, and a few switches; the flags they produce are
folded behind **Advanced**, along with a field for anything else and a preview
of the exact command that will run.

**Thinking** is `--effort`, from low up to max. It is how long the session
reasons before it acts, so it costs latency and tokens in exchange for being
right more often — worth spending on a role that reviews or debugs, wasted on
one that runs a build. Leaving it on Default passes no flag at all and lets the
harness choose, which is the right answer until you have a reason otherwise.

The model list is read off the Claude binary installed on the server, so it
follows Claude's releases rather than this project's. Aliases come first and
full versions after, because an alias is almost always what you want: a role
written today should get the best Opus, not the one that was current the day it
was written. Permission modes and effort levels come from the CLI's own help
output, so a mode or a level added upstream appears without a change here — the
one difference is that effort is a scale rather than a set, so a list this
project cannot parse falls back to the known ladder whole rather than being
merged into something out of order.

Two switches are worth knowing the shape of:

- **Remote control** works anywhere. It needs nothing on the box beyond outbound
  network, which makes it a natural fit here — the session is on the VPS either
  way, and this just gives you a second way to reach it.
- **Browser tools** (`--chrome`) is the one to be careful about. The
  [documentation](https://code.claude.com/docs/en/chrome) describes a native
  messaging host, which requires Chrome and Claude Code on the same machine and
  would rule out a VPS entirely. The binary tells a fuller story: it also
  contains a WebSocket bridge and errors about the extension and Claude Code
  being logged into *different* claude.ai accounts, which only makes sense if
  the two can pair over the network. **Untested here** — if you want it, sign in
  on both ends and run `/chrome` to see whether it pairs before building any
  infrastructure. Passing it on a box with no Chrome is harmless either way; the
  session starts normally, just without browser tools.

The harness runs as `<command> <args>; exec "$SHELL"`. The tail matters — dtach
ends a session when its last pane exits, so without it, quitting Claude would
take the desktop window with it. And because windows attach with
`new-session -A`, which ignores a shell-command when it attaches, reloading the
page rejoins the running harness instead of starting a second one on top.

#### MCP servers

A **MCP servers** dropdown sits with the others, and it has three settings
rather than a list of switches, because that is what Claude can actually be
told. There is no flag that enables a server by name. What exists is
`--mcp-config`, which takes definitions, and `--strict-mcp-config`, which
ignores everything else — so the three states are: pass neither and get
whatever the box has, pass `--strict-mcp-config` alone and get none of it, or
pass both and get exactly what you picked.

The list is read off the box, the same way the model list is read off the
binary. Add one and it appears:

```sh
claude mcp add --scope user linear --transport sse https://mcp.linear.app/sse
```

**Use `--scope user`.** Without it Claude files the server under whichever
directory you happened to run the command in, and if that was a workspace, the
server goes when the worktree does. All three scopes are listed anyway —
machine-wide, the repo's `.mcp.json`, and one-directory — each labelled with
which it is, because the alternative answer to "I added it, where is it?" is
silence.

Picking servers writes a file per server under `~/.vibe-os/mcp/`, holding just
that one, and the profile stores the path. Not the definition itself, for two
reasons: a definition can contain an API key or a bearer token, and arguments
show up in `ps`, while these files are 0600 in a 0700 directory. And a copy
frozen into a profile stops matching the box the moment the URL changes. The
files are rewritten from `~/.claude.json` and each project's `.mcp.json`
whenever the editor reads the list and again whenever a window starts, so
`claude mcp add` is the only place a server is ever really configured, and
every profile using it follows.

Three things worth knowing, all measured rather than assumed:

- Credentials follow the **server name**, not the file that declared it. A
  server you have already logged into keeps working through a generated file,
  with no second OAuth round.
- Because the file is passed explicitly, a **one-directory server works in a
  workspace** — which it would not otherwise, since the session's directory is
  the worktree and not the one it was registered against.
- `--strict-mcp-config` also drops **plugin-provided** MCP servers. It does not
  drop **claude.ai connectors** — Gmail, Calendar, Drive and the rest are
  attached to the account rather than to this machine, and nothing on the
  command line turns them off.

Picking nothing is the same command line as picking none, so the editor writes
it as none rather than leaving it half-said. A selection whose server has since
gone from the box is shown struck through and stays selected: it is what the
profile says, and dropping it quietly would change what the profile does
without telling you.

#### Blanks

A standing prompt is worth most when it is nearly the same every time. "Review
the ticket" only helps if you can say which ticket, so a prompt can leave gaps:

```
Read {{which files}} on branch {{branch}} and report back.
```

Each `{{…}}` becomes a field in the band, drawn inline in the sentence it
belongs to rather than as a form above it — you read the prompt and fill the
holes in it. The words inside the braces are the placeholder, so they should say
what goes there. Select a word in the editor and press **+ blank** to turn it
into one; typing the braces by hand does the same thing.

Blanks are keyed by position, not by name. Two `{{file}}` in one prompt stay two
separate fields, because they are far more likely to be two files than the same
one written twice.

Pressing Copy or Send with blanks still empty refuses once and puts the cursor
in the first one. Pressing again goes anyway, and an unfilled blank falls back
to its own label so the sentence still reads.

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

The ⇗ button in a window's title bar offers two places to send that terminal:

- **Browser window** — its own window on this screen, worth having when a role
  needs a whole screen rather than a tile on someone else's.
- **SSH session** — a real terminal on your own machine, over plain `ssh`.

There is nothing clever underneath either one. Every route addresses the same
window id, the server turns that into the same dtach session, and dtach is what
actually holds the terminal — so popping out is just detaching one client and
attaching another, and everything running carries on.

The desktop shows a placeholder while a terminal is out, rather than mirroring
it. dtach is perfectly happy with two clients on one session and would show the
same thing in both, but it sizes a session to its *smallest* client, so a
mirrored pair drags itself down to whichever window is narrower. One client at a
time means whatever picked the terminal up gets the size it actually has.

**Bring it back** returns the terminal to the desktop with its scrollback
intact, and closing a browser pop-out does the same. Reloading the desktop
disturbs neither: a browser pop-out is asked who is out there and answers, and
an SSH handoff is a column on the window row, so it survives anything the
browser does.

### Popping out to a real terminal

Choosing **SSH session** hands the window over and shows you two ways to pick it
up. One is plain ssh:

```bash
ssh -t vibe@vibe-os.tail76dd79.ts.net vibe-os attach quiet-amber-otter-1
```

The other is a URL you type into a terminal:

```bash
sh -c "$(curl -sSL https://vibe-os.tail76dd79.ts.net/t/quiet-amber-otter-1)"
```

That URL answers with a three-line shell script that `exec`s an `ssh` command,
so `curl` on its own shows you exactly what you are about to run. Everything is
resolved server-side, so the box needs nothing installed for it. Use
`sh -c "$(…)"` and not `curl … | sh`: a pipe makes the script's stdin the pipe,
leaving `ssh -t` with no terminal to allocate, and dtach fails on arrival.

**Which one is listed first depends on the token gate.** The URL is the nicer
answer right up until there is a token, because the token has to travel in the
query string for `curl` to get past the gate — and a URL you can no longer type
from memory, that also lands your token in your shell history, has lost every
advantage it had over the ssh command beside it. So an ungated server offers the
URL first and a gated one offers ssh first.

The ssh form has no matching caveat. It names vibe-os by an absolute path
whenever the binary is somewhere sshd's PATH would not find it, so it resolves
wherever it happens to be installed.

`vibe-os attach` with no window gives you a picker of every window on the box,
newest workspace first, which is the one worth remembering — on your laptop you
do not have a window id, you have "the thing I was doing yesterday".

```
  vibe-os · 3 windows

    1  live  quiet-amber-otter-1   QA Engineer       vibe-os/quiet-amber-otter
    2  idle  quiet-amber-otter-2   terminal          vibe-os/quiet-amber-otter
    3  live  brave-copper-lynx-1   Backend Manager   vibe-os/brave-copper-lynx

  attach [1-3, q to quit]:
```

Both routes build their command with the same function that fills in a
certificate's `force-command`, so arriving over ssh puts you in the same
session, in the same worktree, running the same harness the browser would have
started. Nothing is special-cased for terminals.

**This grants no access.** The ssh connection authenticates with your own key in
`~/.ssh/authorized_keys`, or with your tailnet identity under `tailscale up
--ssh`; vibe-os is not in the auth path at all and `--token` does not gate it.
Anyone who can ssh to the box as that user could already type `dtach -a`.
What this adds is knowing what to attach *to*.

Tailscale SSH is worth turning on for exactly this — it makes the command work
with no key to distribute, and it coexists with the bridge, which dials
`127.0.0.1:22` and is not intercepted.

**Bring it back** kills the attached dtach client, which is the
server-side equivalent of closing a browser pop-out: your terminal drops back to
its shell, and the desktop takes the window over. Nothing running is disturbed.

The desktop also takes a window back on its own when the terminal goes away, so
closing your laptop lid does not leave a placeholder behind forever. It waits
for a client to actually show up before it starts watching — otherwise it would
reclaim the window while the command was still on your clipboard — and gives up
after fifteen minutes on a handoff nobody ever used.

The host in those commands is the host your browser used to reach the desktop,
which is almost always the one sshd answers on. `--ssh-advertise host[:port]`
overrides it for when the two genuinely differ, such as a reverse proxy in front
of the web port.

### The desktop

Windows float over a wallpaper and snap to a 24 × 14 grid. Drag a title bar to
move, drag any edge or corner to resize; the grid only appears while you are
dragging, with the destination cell lit up. Double-click a title bar to fill the
desktop.

There are no keyboard chords. The terminal has focus nearly all the time, and
every key the desktop took for itself was a key the session underneath could not
have — `alt` is how a terminal sends the characters
a Mac keyboard has no other way to type. Everything is a control you can see.

**⊞ on the dock tiles the windows.** One fills the desktop, two go across, three
are two across with a full-width one beneath, and four take the corners. Five is
where it stops: past four every tile is narrower than a terminal wants to be, so
the button greys out and nothing moves rather than arranging something nobody
would work in. Minimised windows are left where they are — they were put away on
purpose, so they are neither counted nor dragged back out.

**The dock and the profile rail hide themselves.** Both are things you reach for
rather than read, and between reaches they were two strips of screen a terminal
could have had — the window surface now runs to the right edge. Push the pointer
into the bottom edge and the dock comes back; into the right edge and the rail
does. A hairline in each edge marks where.

Closing a window ends the session behind it; **minimise** puts one away and
keeps it running. Reloading or closing the tab keeps everything — persistence
only gives way to an explicit dismissal.

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

Copying *inside* a session — from Claude, from vim — reaches the browser
clipboard as well. Programs ask for that with OSC 52, which arrives here
untouched because nothing sits between the program and the terminal; the browser
side then has to handle it, which xterm.js does not do on its own. Clipboard
*reads* over OSC 52 are refused — anything running in a session could otherwise
ask what you last copied.

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

**dtach is detected on the machine vibe-os runs on**, which is the SSH target by
default. If you point `--ssh-host` somewhere else, pass `--sessions` explicitly.

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

- **ACME is still untested.** `--domain` and the Let's Encrypt path have never
  run outside a test, and taking the [Tailscale path](#behind-tailscale) means
  never reaching for them — which is why they stay that way.
- **The firewall rules are taken on trust.** Everything else in the VPS section
  has been walked end to end on real hardware; those have not.
- **No authentication by default.** The token gate exists and works; it is off
  until you pass `--token`. There is no multi-user story at all.
- **No keyboard shortcuts at all.** The desktop is click-only, deliberately —
  see [The desktop](#the-desktop). Something that does not steal keys from the
  terminal is worth having; it has not been designed yet.
- **MCP servers can be picked but not added.** The editor lists what the box
  has and hands a profile the ones you choose; adding, editing and removing
  them is still `claude mcp` on the box, which is also the only place they are
  configured.
- **No branch operations.** Workspaces create a worktree and a branch; pushing,
  PRs and merging happen in the terminal.
- **Deleting a workspace keeps its branch**, deliberately, so work is
  recoverable — nothing prunes those branches for you.

## License

MIT. Bundles [c2FmZQ/sshterm](https://github.com/c2FmZQ/sshterm) (MIT).
