# Using vibe-os

## Projects and workspaces

The picker in the top-left switches between git repositories on the machine.
**Refresh** walks the disk for them, bounded by depth and a visit budget, and
only on that button.

Each project has **workspaces** in the sidebar. A workspace is a git worktree on
its own branch, named with three random words. Creating one fetches `origin` and
branches from its default branch, so it starts level with `origin/main` instead
of with whatever the project's own checkout was left on. That fetch is what the
spinner is waiting for. With no `origin`, or none that can be reached, the
workspace is still created from the last fetch or from the checkout, and the
sidebar says which. Terminals belong to a workspace:
switching swaps which windows are on screen and restores their placement, while
the sessions you left keep running. Only ✕ ends anything.

`git push` works with no arguments from a new workspace, because creating one
sets `push.autoSetupRemote` on the project. Nothing is pushed for you.

Every window in a workspace shares one checkout, one branch and one git index.
That is the point, but it means two agents running `git commit` at the same
moment will collide on `index.lock`. Nothing is corrupted, one of them retries.
If two pieces of work need to proceed independently, give them a workspace each.

## Profiles

A profile is a name, a colour, a harness (`claude`, `hermes`, `cursor`,
`codex`, [one you add](harnesses.md), a shell, or any command on the box)
with its flags, and a standing prompt. Profiles belong to a
project and appear in every workspace of it.

The colour is the point: it tints the window, its title bar and its dock entry,
so three roles running at once are distinguishable without reading anything.

- **Quitting the harness closes the window.** A role window exists to run that
  role. ⟳ opens it again.
- **Clicking a role that is already open raises it.** Hover a live row and press
  **+** to open a second one.
- **Flags are stored as a list of arguments**, quoted individually when the
  command is built. The browser never sends a command at all.
- **Memory** sets this role's own limits, overriding the server's. See
  [Memory](deploying.md#memory).

The editor gives you a model dropdown, a thinking dropdown (`--effort`), a
permission dropdown and a few switches, with the generated flags and a preview
behind **Advanced**. Models and permission modes are read off the Claude binary
installed on the server, so the list follows Claude's releases.

Other harnesses get editors of their own. See [Harnesses](harnesses.md) for
Hermes, Cursor and Codex, and for adding your own.

### MCP servers

For Claude profiles. Cursor reads its own list from `~/.cursor/mcp.json`, see
[Cursor](harnesses.md#cursor).

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

### Blanks

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

## Popping a terminal out

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

## The desktop

Windows snap to a 24 × 14 grid. Drag a title bar to move, any edge to resize,
double-click to fill the desktop. **⊞** on the dock tiles up to four windows.

The dock and the profile rail hide themselves. Push the pointer into the bottom
or right edge to bring them back.

Closing a window ends its session. **Minimise** puts it away and keeps it
running.

Each dock entry shows what its window is using, in amber once it is being
throttled and red near its limit. A throttled window stays slow until it is
closed. The **mem** readout is the whole box, with the share of time something
spent stalled on memory, a throttled window included.

The dock's **◑** opens the wallpaper picker. Uploads are stored on the server,
so the same desktop appears on every device. **Dim** darkens the wallpaper
behind the windows.

### Keyboard shortcuts

Press `` Ctrl+` ``, let go, then press one key. A panel above the dock lists the
keys while it waits. **Esc**, or `` Ctrl+` `` again, backs out.

| Key | Does |
| --- | --- |
| **1**–**9** | Brings up the window with that number on the dock, restoring it if it is minimised |
| **←** **→** | Previous or next window on screen, in dock order |
| **↑** **↓** | Previous or next workspace in the sidebar |
| **p**, then **1**–**9** | Opens a profile, numbered down the rail, or brings up its window |
| **t** | Opens a terminal |
| **m** | Minimises the focused window |
| **f** | Fills the desktop with the focused window, or puts it back |
| **g** | Tiles the windows |

Whatever the command brings up gets the keyboard, so you can type straight into
it. Any other key after `` Ctrl+` `` is dropped, not passed to the terminal.

Programs in the terminal never receive `` Ctrl+` ``: xterm.js sends nothing for
it. It is matched by physical key, the one left of **1**, on every keyboard
layout. The `` Ctrl+` `` button at the right of the menu bar does the same as
pressing it. Pop-out windows have no shortcuts.

Shortcuts are off while a profile or wallpaper panel is open.

## Installing it as an app

vibe-os ships a web app manifest, so Chrome, Edge and Brave offer to install it
and it runs in its own window. On iOS, **Share → Add to Home Screen**.

It needs a secure origin: `localhost`, or HTTPS by way of
[`tailscale serve`](deploying.md#behind-tailscale) or `--domain`.

Give each box its own colour so you can tell installed instances apart:

```bash
vibe-os start --theme-color '#7a4fd6'
```

The service worker caches nothing. It exists only because Chrome will not offer
installation without one.
