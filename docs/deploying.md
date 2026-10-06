# Deploying on a VPS

## What the box needs

| Package | What uses it | Without it |
| --- | --- | --- |
| `openssh-server` | every window logs in through it | nothing connects |
| `openssh-client` | signing certificates, finding the host key | **the server refuses to start** |
| `dtach` | keeps windows alive across reloads | windows die on reload, and **profiles launch no harness** |
| `git` | projects and worktrees | no projects |
| `gh` | PRs, issues and reviews (optional) | git works, the GitHub API does not |
| `claude` | the Claude harness | those profiles open a window that closes immediately |
| `hermes` | the Hermes harness (optional) | those profiles open a window that closes immediately |
| `cursor-agent` | the Cursor harness (optional) | those profiles open a window that closes immediately |
| `codex` | the Codex harness (optional) | those profiles open a window that closes immediately |
| `earlyoom` | ending a runaway process when memory runs out | a box with swap thrashes until someone intervenes |

```bash
sudo apt update && sudo apt install -y openssh-server openssh-client dtach git gh earlyoom
curl -fsSL https://claude.ai/install.sh | bash      # standalone, needs no Node

# Optional, for the Hermes harness
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup                                        # pick a provider

# Optional, for the Cursor harness
curl https://cursor.com/install -fsS | bash
cursor-agent login                                  # one login per box

# Optional, for the Codex harness
npm install -g @openai/codex
codex login --device-auth                           # one login per box
```

Verified on Debian 12 and 13, Ubuntu 24.04 and 26.04 LTS, x86\_64.

`dtach` is the one people skip. The harness command lives in the dtach
invocation, so without it a profile opens a shell and does nothing else.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tsconfigdotjson/vibe-os/main/install.sh | sh
```

It installs the latest [release](https://github.com/tsconfigdotjson/vibe-os/releases)
for Linux x64, Linux arm64 or Apple Silicon to `/usr/local/bin` (or
`~/.local/bin` without sudo), after checking its SHA-256. Set `VIBE_OS_VERSION`
to pin a tag, or `VIBE_OS_INSTALL_DIR` to choose the directory.

The binary carries the whole app, including the 20MB SSH WASM runtime. No Bun,
Node or npm on the target.

On a box that already has Bun, the npm package is the same thing without the
build step:

```bash
bun add -g @tsconfigdotjson/vibe-os   # installs the vibe-os command
```

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

## Setup

```bash
vibe-os setup
```

Each step checks first and skips itself when there is nothing to do, so running
it again on a configured box changes nothing. In order:

1. **User.** As root, it offers to create a user with passwordless sudo and
   root's SSH keys, then stops so you can log in as them and run it again.
2. **Prerequisites.** `openssh-server`, `openssh-client`, `dtach`, `git`,
   `curl` and optionally `gh`, through apt, dnf, yum, pacman or zypper.
3. **sshd**, enabled and started if nothing answers on port 22.
4. **Harnesses.** Claude Code, then optionally Hermes and Cursor.
5. **Tailscale**, installed and brought up (it prints a login URL).
6. **The service**, on `127.0.0.1:7681` with a generated token kept in
   `~/.vibe-os/config.json`. An installed unit is left alone unless you pass a
   different `--port` or `--host`.
7. **`tailscale serve --bg 7681`**, for HTTPS on the tailnet.
8. **SSH hardening.** Writes `01-hardening.conf` to turn off password logins,
   runs `sshd -t` and reloads. Skipped if your user has no SSH key yet.
9. **Firewall**, with ufw: allow the tailnet and `41641/udp`, deny the rest.
10. **`doctor`**, run with sudo, then the URL with `?token=`.

The firewall step can lock you out, so before enabling ufw it arms a systemd
timer that disables it again in five minutes. Setup then waits for you to
confirm from a **new** session over the tailnet:

```bash
ssh <user>@<machine>.<tailnet>.ts.net vibe-os confirm-firewall
```

If that never arrives, ufw turns itself off. Your provider's firewall is
separate; leave `41641/udp` open there.

| flag | |
| --- | --- |
| `-y`, `--yes` | take the default answer to every question |
| `--firewall` | with `--yes`, do the firewall step too (it is skipped otherwise) |
| `--hermes`, `--cursor` | install those harnesses too |
| `--user <name>` | as root, the user to create |
| `--port`, `--host` | where the service listens (default `7681`, `127.0.0.1`) |

With `--yes`, an agent runs the firewall confirmation from a second SSH
connection while setup waits in the first.

## Behind Tailscale

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

## Firewall

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

## Running it as a service

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

## Memory

An agent session uses 300 to 700 MB, and grows the longer it runs. Budget:

| RAM | Agent sessions |
| --- | --- |
| 2 GB | 1 |
| 4 GB | 3 to 4 |
| 8 GB | 8 to 10 |
| 16 GB | 20 or so |

Past that the box runs out of page cache and stalls, and with swap the kernel
never kills anything to recover. Three things keep that from happening:

- **Each window runs in its own systemd scope** with `MemoryHigh=40%`,
  `MemoryMax=50%` and `MemorySwapMax=10%` of RAM. Past the first it is slowed
  down; past the second, with its swap used up, it is ended. Change the
  defaults with `--memory-high`, `--memory-max` and `--memory-swap-max`, and the
  first two per profile in the editor. Sizes are systemd's: `1500M`, `2G`,
  `40%`, `infinity`.
  Scopes need the user to linger (`sudo loginctl enable-linger $USER`, which
  `vibe-os setup` offers); without that, or without user systemd as in most
  containers, windows start unscoped.
- **Opening an agent asks first** when the box is short on memory.
- **An OOM daemon** ends one process instead of letting the box thrash. Install
  `earlyoom`, or let `vibe-os setup` do it. `vibe-os doctor` warns when there is
  none.

## An always-on browser

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
| `--restart-at <expr>` | `*-*-* 02:00:00`, in the box's timezone |
| `--no-restart` | install no nightly timer |
| `--vnc-password [value]` | none, and an existing one is kept |
| `--no-vnc-password` | serve the display with no authentication |

The default names the box's own timezone, which on most VPS images is UTC, and
the install summary prints it. Pass your own zone if your night is elsewhere, as
in `*-*-* 02:00:00 America/New_York`.

Give it two gigabytes of headroom counting swap. Chrome idles near 0.5GB, and on
a box without it the OOM killer takes terminal sessions rather than tabs.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Using it

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
sudo vibe-os install-browser --vnc-password        # generates and prints one
sudo vibe-os install-browser --vnc-password hunter2
```

Then open `vnc://127.0.0.1:5900` and leave the username blank. VNC
authentication is password-only.

Later runs of `install-browser` keep a password that is already set, so a
reinstall does not quietly drop you back to no authentication. `--no-vnc-password`
turns it off on purpose.

VNC authentication is DES-based and truncates at 8 characters, so treat it as a
second layer and not as the thing keeping the box shut. Prefer the bare
`--vnc-password`: a password passed as an argument is visible in shell history
and, briefly, in `ps`.

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

### Extensions

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

## Giving the box a GitHub identity

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

## Updating a running box

```bash
curl -fsSL https://raw.githubusercontent.com/tsconfigdotjson/vibe-os/main/install.sh | sh
sudo systemctl restart vibe-os
```

Nothing is lost by that restart. Two things it does not pick up:

- **A changed harness command.** An existing session keeps running whatever it
  was started with. Close the window and open it again.
- **Changed service flags.** Those live in the unit, so re-run
  `install-service`.

A reboot is different: dtach sessions do not survive one. Afterwards, each
window whose session was cut off offers **Resume conversation**, which restarts
the agent on its last conversation (`--continue`, or `codex resume --last`), or
**Start fresh**. A plain shell
window offers **Reopen**. The same offer appears for a session the OOM killer
ended, the next time the server starts.
