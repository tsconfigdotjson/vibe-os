# API

vibe-os is driven over HTTP. The desktop uses the same API, and the routes below
marked **stable** are the ones meant for scripts, webhooks and cron. The rest
exist for the desktop and may change between releases.

The `vibe-os` CLI wraps the stable routes. See [From the command line](#from-the-command-line).
The same operations are MCP tools at `/mcp`: see [MCP](mcp.md).

## Authentication

Send the server's token as a bearer token:

```sh
curl -H "Authorization: Bearer $VIBE_OS_TOKEN" http://127.0.0.1/api/windows
```

The token is the one `vibe-os start` prints in its URL. Without `--token`, it is
stored in `~/.vibe-os/config.json`. A server started with `--no-token` needs no
header, but then only answers to its own addresses and names (see `--allowed-host`).

Requests that send an `Origin` header from another site are refused, so the API
cannot be called from a web page on another origin.

Request bodies are JSON and need `Content-Type: application/json`. A body with any
other type is read as empty.

## Responses

Every response is JSON. Errors are `{ "error": "message" }` with a 4xx or 5xx
status:

| status | meaning |
| --- | --- |
| 400 | the request is malformed, or names something invalid |
| 401 | missing or wrong token |
| 404 | no such project, workspace, profile or window |
| 405 | the route exists but not with this method |
| 409 | the server cannot do this here, for example `--no-sessions`, a window that is not running, or the box is short of memory |
| 502 | starting or typing into a session failed |

## Stable routes

### Projects

A project is a git repository under the workspace root.

`GET /api/projects` lists them.

```json
[{ "id": "…", "name": "api", "path": "/home/me/workspace/api", "branch": "main", "remote": "git@github.com:me/api.git", "createdAt": 1791291661842 }]
```

`POST /api/projects/scan` looks for new repositories on disk and returns the list.

### Workspaces

A workspace is a git worktree of a project, on its own branch.

`GET /api/workspaces` lists every workspace, most recently opened first.

```json
[{ "id": "…", "name": "quiet-amber-otter", "branch": "quiet-amber-otter", "path": "…", "projectId": "…", "project": "api", "lastOpenedAt": 1791291661842 }]
```

`GET /api/projects/:project/workspaces` lists one project's workspaces.

`POST /api/projects/:project/workspaces` creates one.

| field | |
| --- | --- |
| `name` | optional. Lowercase letters, digits and dashes. Three random words if absent |
| `from` | optional. The branch or commit to start from. `origin/<from>` is used when it exists. Defaults to origin's default branch |

Returns `201` with `{ id, name, branch, path, base, warning }`. `base` is the ref
the branch was cut from. `warning` is set when origin could not be fetched.

`DELETE /api/workspaces/:workspace` ends the workspace's sessions and removes
the worktree. The branch is kept.

### Profiles

A profile is a role a window can be opened as: a harness, its flags, and a
prompt. Profiles belong to a project.

`GET /api/projects/:project/profiles` lists them.

`POST /api/projects/:project/profiles` creates one, and
`PATCH /api/profiles/:profile` changes one. Fields: `name`, `color`, `harness`
(an id from `GET /api/harnesses`, `shell` or `custom`), `command` (for `custom`),
`args` (a string, split like a shell would), `prompt`, `memoryHigh`, `memoryMax`,
`position`.

`DELETE /api/profiles/:profile` deletes one. Its windows keep running.

### Windows

A window is a terminal in a workspace. With sessions on (the default), each one
is a dtach session that runs until it is closed.

`GET /api/windows` lists every window on the box. `?label=<text>` lists only
the windows opened with that label.

```json
[{ "id": "…", "ref": "quiet-amber-otter-1", "session": "vibe-quiet-amber-otter-1", "workspace": "quiet-amber-otter", "project": "api", "role": "QA", "label": "nightly-triage", "live": true, "state": "idle", "lastOutputAt": 1791291661842, "lastSendAt": 1791291650000, "turn": "done" }]
```

`ref` is what `vibe-os attach` and `vibe-os close` take. `role` is the profile
name, or null for a plain terminal. `label` is the one given when the window was
opened, or null. `live` is whether its session is running.

`state` is what the program in the window is doing, or null when it is not running:

| state | |
| --- | --- |
| `busy` | it drew something in the last second and a half. An agent at work is always busy |
| `question` | it is quiet, and the screen shows a question: a dialog that ends in "Enter to confirm" or "Esc to cancel", a selector with a "↑↓ navigate" hint, a numbered menu, or `(y/n)` |
| `idle` | it is quiet at its prompt, or finished |
| `asleep` | it was hibernated (`--hibernate-after`). `live` is false; `start`, `send` or a browser opening it resumes the conversation |

A program that reports its own state with the Program Status Protocol (OSC
7501), as Pi does, is `busy` while it says it is working and `question` while
it says it is waiting on a dialog, whether or not it is drawing. Once it says it
is done, the screen decides as above. A report counts until the next one, a
terminal reset or a shell prompt, and is not kept across a server restart.

`lastOutputAt` is when it last drew anything, in milliseconds since the epoch.
It is null until the server has seen output from it, so it starts over when the
server restarts.

`lastSendAt` and `turn` say how the window is doing with the last thing sent to
it. A send that submits text, or presses keys, starts a turn:

| turn | |
| --- | --- |
| `pending` | sent, and nothing drawn since |
| `working` | it has drawn something since the send |
| `done` | it went quiet again after working: `idle` or `question` |

Both are null when nothing has been sent since the server started. Like
`lastOutputAt`, they are kept in memory and start over when the server restarts.
A window that is `idle` with `turn: "pending"` has not started on the send yet.
In a plain terminal or a shell profile, the turn is the command: it stays
`working` until the shell has the terminal back, so a quiet `sleep 60` is not
done while it runs.

`GET /api/workspaces/:workspace/windows` lists one workspace's windows, with
their layout on the desktop.

`POST /api/workspaces/:workspace/windows` adds a window. On its own it does not
start it: that happens when a browser shows it, with `start` or `send` below, or
with `start` or `prompt` here.

| field | |
| --- | --- |
| `profileId` | optional. A profile of the workspace's project. A plain terminal if absent |
| `label` | optional. Your own tag for the window, up to 200 characters, to find it again with `GET /api/windows?label=` |
| `start` | optional. Start the window's session too |
| `prompt` | optional. Start the window and send this text, as `send` does |
| `blanks` | optional. Start the window and send the profile prompt with its blanks filled, as `send` does |
| `submit` | optional. With `prompt` or `blanks`, press Enter after pasting |
| `force` | optional. Open an agent even when the box is short of memory |
| `reuse` | optional. With `label`: if a window with that label is already open in the workspace, return it instead of adding one |

Returns `201` with the window. With `start`, `prompt` or `blanks`, the window
also carries the fields `start` and `send` return, including `window`, its
summary. If the window cannot be started it is removed again, and the call
returns `502`.

When the box is short of memory and the profile runs an agent, it returns `409`
with `{ "error": "…", "capacity": true }` instead. Send it again with
`"force": true` to open it anyway.

With `reuse`, a window already open under the label is returned with `200` and
`"reused": true`, so a retried call does not open a second window. Its prompt is
not sent again while it is running or asleep. If its session has ended, `prompt`,
`blanks` or `start` start it again as they would a new window.

`POST /api/windows/:window/start` starts the window's session with nothing
attached. It logs in over SSH with a short-lived certificate, the same way the
browser does, so the session is the same as one the desktop starts. Starting a
running window does nothing. Returns `{ "started": true, "window": { … } }`,
with `started` false when it was already running.

`POST /api/windows/:window/send` pastes text into the window, starting it first
if it is not running.

| field | |
| --- | --- |
| `text` | the text to paste |
| `blanks` | instead of `text`: values for the profile prompt's `{{blanks}}`, by label. The filled prompt is pasted |
| `submit` | optional. Press Enter after pasting. Default false |
| `force` | optional. Paste even when the window is waiting on a question. Default false |
| `keys` | instead of `text`: keys to press, in order, like `["Enter"]` or `["Escape"]` |

With neither `text`, `blanks` nor `keys`, the profile prompt is pasted as it is.
Every blank in it has to be filled.

The text is pasted the way the desktop's Send button does it, as one bracketed
paste. Before pasting, the call waits until the window is ready:

1. The program is reading keys, for up to a minute.
2. It has stopped drawing, for up to 20 seconds. A harness that is starting
   draws its splash screen and then goes quiet. One that is still busy after 20
   seconds gets the paste anyway, and most harnesses queue it.
3. What it stopped on is not a question. If it is, like Claude asking whether
   to trust a new folder, nothing is pasted, unless `force` is set.

After the paste, the window has to draw something within 3 seconds, or Enter
is not pressed.

```json
{ "started": true, "delivered": true, "state": "idle", "window": { … } }
```

`delivered` is whether the text went in. `state` is what the window was doing
at the time (see [`GET /api/windows`](#windows)). When `delivered` is false,
`reason` says why. Read the window's output to see what it is asking.

After a delivered send, the desktop no longer offers the profile prompt above
the window.

`keys` presses keys instead of pasting: Enter to submit what is already typed,
a number or `y` to answer a question, Escape to stop a busy agent. A key is one
character, typed as it is, or one of `Enter`, `Escape`, `Tab`, `BackTab`,
`Backspace`, `Delete`, `Space`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`,
`PageUp`, `PageDown` and `Ctrl+<letter>`. Up to 32 per send. Keys go in as soon
as the program is reading input, without waiting for it to go quiet, and also
when it is waiting on a question. They cannot be combined with `text`,
`blanks` or `submit`.

```json
{ "keys": ["2", "Enter"] }
```

`GET /api/windows/:window/output` returns what the window shows, as plain text
with colours and cursor movement removed.

| query | |
| --- | --- |
| `lines` | optional. How many lines, counted from the bottom. 1 to 2000, default 50 |
| `after` | optional. A `cursor` from an earlier read: return only what was added since |

```json
{ "text": "❯ Reply with just the word pong.\n⏺ pong\n…", "state": "idle", "lastOutputAt": 1791291661842, "cursor": 412 }
```

`cursor` counts the lines that have scrolled off the top of the screen into the
history. With `after`, `text` is the lines that scrolled into the history since
that cursor, oldest first, and `screen` is the screen as it is now:

```json
{ "text": "⏺ Running the tests…", "screen": "…\n❯", "state": "busy", "lastOutputAt": 1791291662001, "cursor": 415, "truncated": false }
```

The history does not change once written, so reading on from each new `cursor`
sees every line once. The screen can be redrawn in place, so it comes back whole
each time. `truncated` is true when some of what came after the cursor is no
longer held (the history keeps 1000 lines), or when the cursor is from before a
server restart. `lines` limits `text` when given with `after`.

A full-screen program, such as Claude Code since it moved to drawing in the
terminal's alternate screen, keeps no history: nothing scrolls off its screen,
so `cursor` stays put, `text` is empty, and `screen` is everything there is.
For a Claude window, `messages` below is the better way to read what was said.

A hibernated window answers with what it showed when it went to sleep,
`state: "asleep"` and `lastOutputAt: null`, and is not woken by the read.

The text is the screen and the history above it, up to 1000 lines. A long line
the terminal wrapped is joined back into one, and a run of blank lines reads as
one. Faint text on the cursor's line
is left out, so a greyed-out placeholder or suggested prompt in a harness's
input box does not read as text someone typed. A window that was already running
when the server started is asked to redraw itself the first time it is read,
which narrows it by one column for a moment. Returns `409` when the window is
not running.

`GET /api/windows/:window/wait` blocks until the window settles, or changes, and
returns. This replaces polling `output` in a loop.

| query | |
| --- | --- |
| `until` | optional. `settled` (default): not `busy`, so `idle`, `question` or `asleep`. `idle` or `question`: that state. `change`: any state other than the one when the wait began |
| `timeout` | optional. Seconds, 1 to 240, default 60 |
| `turn` | optional. `1` with `settled`: also wait until the turn after the last send is `done` (see [`turn`](#windows)), so the idle before the window starts on a send does not count |
| `background` | optional. `1` with `settled`: also wait until the agent has no command running in the background. Claude windows only |
| `lines` | optional. Include the window's last lines of output, as `output` does. Default 0 |

```json
{ "ref": "quiet-amber-otter-1", "state": "idle", "reached": true, "waitedMs": 48210, "lastOutputAt": 1791291661842, "window": { … }, "text": "…", "cursor": 415 }
```

`reached` is false when the time ran out, which is a `200` like any other answer.
A window that is not running answers at once with its state: `asleep`, or null
with `live: false` in `window`. Waiting does not wake a hibernated window.
`window` is the window's summary, as `GET /api/windows` returns it.

Claude Code moves long commands into the background and goes back to its
prompt, then answers again when the command finishes. So a Claude window can
be `idle` with its turn `done` while the work is still going. When that is so,
the result has `"background": true`. Pass `background=1` to wait for those
commands too. It is off by default because a command that never ends, like a
dev server, would keep the wait going until it times out.

`GET /api/windows/wait?refs=a,b,c` waits on up to 32 windows, by ref or id, and
returns when any one of them meets `until`. `ref` names that window, and
`windows` lists where each of them is:

```json
{ "ref": "brave-jade-lynx-1", "state": "question", "reached": true, …, "windows": [{ "ref": "quiet-amber-otter-1", "state": "busy", "turn": "working" }, { "ref": "brave-jade-lynx-1", "state": "question", "turn": "done" }] }
```

`GET /api/windows/:window/messages` returns the last messages of the
conversation in a Claude window, read from Claude's own transcript. It works on
a running window and a hibernated one.

| query | |
| --- | --- |
| `last` | optional. How many messages, from the end. 1 to 500, default 20 |

```json
{ "messages": [{ "role": "user", "text": "Reproduce #123", "at": 1791291600000 }, { "role": "tool", "text": "Bash(bun test)", "at": 1791291610000 }, { "role": "assistant", "text": "The test fails as reported…", "at": 1791291660000 }] }
```

`role` is `user`, `assistant`, or `tool` for a tool call the assistant made, in
short form. Thinking, tool results and subagents are left out. Returns `409` for
a window whose harness has no transcript vibe-os can read, and for a Claude
window that is not running and not asleep.

`DELETE /api/windows/:window` ends the window's session and removes it.

`GET /api/windows/:window/attach` returns the `ssh` command that attaches a
terminal to the window.

### Events

`GET /api/events` is a stream of window events, as
[server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html).

| query | |
| --- | --- |
| `refs` | optional. Only these windows, comma separated |
| `label` | optional. Only windows with this label |

```sh
curl -N -H "Authorization: Bearer $VIBE_OS_TOKEN" http://127.0.0.1/api/events
```

Each event is one `data:` line of JSON. Its type is in the JSON, not in an
`event:` field.

```
data: {"type":"window.state","ref":"quiet-amber-otter-1","label":"nightly-triage","workspace":"quiet-amber-otter","project":"api","at":1791291661842,"from":"busy","to":"idle"}
```

| type | |
| --- | --- |
| `window.state` | `from` and `to` are states, as in [`GET /api/windows`](#windows). Null is not running |
| `window.turn` | `turn` is the window's new turn |
| `window.opened` | a window was added |
| `window.closed` | a window was closed |
| `window.asleep` | a window was hibernated |
| `window.woke` | a hibernated window is running again |

A comment line goes out every 15 seconds while nothing else does. The desktop's
cookie also works, so `EventSource` in a page on the desktop's own origin needs
no header.

### Health

`GET /api/health` returns `{ "ok": true }`.

## Desktop routes

These serve the desktop and are not stable.

| route | |
| --- | --- |
| `GET /api/config` | what the desktop needs to start |
| `GET /api/harnesses` | every harness, as the specs the profile editor renders |
| `GET /api/harness/:harness` | what the box has for one: version, login, models and options |
| `GET /api/projects/:project/mcp` | MCP servers a profile can be given |
| `POST /api/workspaces/:workspace` | marks a workspace as opened |
| `GET /api/workspaces/:workspace/memory` | memory use per window, for the dock |
| `PATCH /api/windows/:window` | position, size, stacking, the prompt band |
| `POST /api/windows/:window/handoff` | hands a window to an SSH terminal and back |
| `POST /api/windows/:window/restore` | answers the offer to resume after a reboot |
| `POST /api/ssh/certificate` | signs the browser's key for one window |
| `/api/desktop`, `/api/wallpapers` | wallpaper and desktop preferences |

## From the command line

`vibe-os ls`, `workspace`, `open`, `output`, `wait`, `events` and `close` call the stable routes. On the box
they find the server and its token on their own. From anywhere else, pass
`--url` and `--token`, or set `VIBE_OS_URL` and `VIBE_OS_TOKEN`.

```sh
# cut a workspace for issue #123 from a branch
vibe-os workspace new api --from fix-123

# open it as the QA profile and hand it a prompt
vibe-os open quiet-amber-otter --profile QA --prompt "Reproduce #123 and write a failing test" --submit

# or fill the QA profile's own prompt
vibe-os open quiet-amber-otter --profile QA --blank ticket=#123 --submit

# wait until it has answered, then read it
vibe-os wait quiet-amber-otter-1 --turn --timeout 600
vibe-os output quiet-amber-otter-1 --lines 20

vibe-os ls
vibe-os close quiet-amber-otter-1
```

| command | |
| --- | --- |
| `vibe-os ls` | list windows, and what each is doing |
| `vibe-os workspace new <project> [--from <branch>] [--name <name>]` | create a workspace and print its name |
| `vibe-os workspace ls [project]` | list workspaces |
| `vibe-os open <workspace> [--profile <name>] [--prompt <text>] [--blank label=value] [--submit] [--force] [--label <text>] [--reuse]` | add a window, start it, and paste a prompt if given. Prints the window's ref. With `--reuse`, the window already open with `--label` is used instead |
| `vibe-os output <window> [--lines <n>] [--follow]` | print what a window shows. `--follow` keeps printing new lines until the window stops |
| `vibe-os wait <window...> [--until <state>] [--timeout <s>] [--turn] [--background]` | wait for any of the windows to settle. Exits 0 when one did, 2 when time ran out, 1 when a window is not running |
| `vibe-os events [window...] [--label <text>]` | print window events as JSON lines, until interrupted |
| `vibe-os close <window>` | close a window and end its session |

A workspace can be named as `project/name` when two projects have one with the
same name. `--prompt -` reads the prompt from stdin. `--json` prints what the
API returned instead of text.

`wait --timeout` can be longer than the 240 seconds one request allows: the CLI
waits again until the time is up.

If a window cannot be started, `open` removes it again and exits non-zero. If it
starts but the prompt is not delivered, the window stays open, and `open` says
why and exits non-zero.
