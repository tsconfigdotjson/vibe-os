# CLI reference

| command | what it does |
| --- | --- |
| `vibe-os` / `vibe-os start` | serve the UI and the SSH bridge |
| `vibe-os attach [window]` | attach this terminal to a window's session |
| `vibe-os doctor` | check this machine is ready, and say what is missing |
| `vibe-os setup` | fix what `doctor` finds, asking before each change |
| `vibe-os confirm-firewall` | tell a waiting `setup` the tailnet still gets in |
| `sudo vibe-os install-service` | write and enable a systemd unit |
| `sudo vibe-os install-browser` | run one Chrome on a virtual display |
| `vibe-os fetch-wasm` | re-download the SSH WASM runtime |
| `vibe-os ls` | list windows, and which are running |
| `vibe-os workspace new <project>` | create a workspace, optionally `--from <branch>` |
| `vibe-os open <workspace>` | open a window, optionally `--profile`, `--prompt` and `--submit` |
| `vibe-os close <window>` | close a window and end its session |

`ls`, `workspace`, `open` and `close` drive a running server over its
[API](api.md), on the box or from elsewhere with `--url` and `--token`.

```
--port <n>          HTTP port (default 80)
--host <addr>       bind address (default 0.0.0.0)
--domain <fqdn>     provision a Let's Encrypt certificate and serve HTTPS
--email <addr>      contact address for Let's Encrypt
--tls-port <n>      HTTPS port (default 443)

--token [value]     the token to require (default: the last one used, or
                    a new one, remembered in the state dir)
--no-token          disable the gate (prints a warning)
--allowed-host <name>
                    with no token, a name this server answers to beyond
                    its hostname, --domain and its Tailscale name.
                    Repeatable

--ssh-host <addr>   SSH target for the bridge (default 127.0.0.1)
--ssh-port <n>      SSH target port (default 22)
--ssh-advertise <host[:port]>
                    host to print in attach commands, when sshd is not on
                    the name the browser reached the desktop on
--user <name>       unix user to log in as (default: current user)
--no-sessions       plain login shells instead of persistent dtach sessions
--memory-high <size>
                    throttle a window past this (default 40%, of RAM)
--memory-max <size> kill a window past this (default 50%)
--memory-swap-max <size>
                    swap a window may use (default 10%, of RAM). Sizes
                    are systemd's: 1500M, 2G, 40%, infinity
--no-memory-limit   start windows without a memory scope
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
                    (default '*-*-* 02:00:00', the box's own timezone)
--no-restart        do not install the nightly restart timer
--vnc-password [value]
                    require a VNC password; generates and prints one if
                    omitted. macOS Screen Sharing will not connect without
                    this. An existing one is kept unless --no-vnc-password
--no-vnc-password   serve the display with no authentication
```

`setup` takes the [flags in Setup](deploying.md#setup) as well as `--port`, `--host`,
`--workspace` and `--state-dir`, which it passes to the service.

Every option except `--tls-port` and `--cert-ttl` also reads a `VIBE_OS_`
environment variable, which is how the container is configured. `--no-token` is
`VIBE_OS_NO_TOKEN=1`, and `--allowed-host` is `VIBE_OS_ALLOWED_HOSTS`, comma
separated.
