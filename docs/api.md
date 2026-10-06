# API

vibe-os is driven over HTTP. The desktop uses the same API, and the routes below
marked **stable** are the ones meant for scripts, webhooks and cron. The rest
exist for the desktop and may change between releases.

The `vibe-os` CLI wraps the stable routes. See [From the command line](#from-the-command-line).

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
| 409 | the server cannot do this here, for example `--no-sessions`, or the box is short of memory |
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

`GET /api/windows` lists every window on the box.

```json
[{ "id": "…", "ref": "quiet-amber-otter-1", "session": "vibe-quiet-amber-otter-1", "workspace": "quiet-amber-otter", "project": "api", "role": "QA", "live": true }]
```

`ref` is what `vibe-os attach` and `vibe-os close` take. `role` is the profile
name, or null for a plain terminal. `live` is whether its session is running.

`GET /api/workspaces/:workspace/windows` lists one workspace's windows, with
their layout on the desktop.

`POST /api/workspaces/:workspace/windows` adds a window. It does not start it:
that happens when a browser shows it, or with `start` or `send` below.

| field | |
| --- | --- |
| `profileId` | optional. A profile of the workspace's project. A plain terminal if absent |
| `force` | optional. Open an agent even when the box is short of memory |

Returns `201` with the window. When the box is short of memory and the profile
runs an agent, it returns `409` with `{ "error": "…", "capacity": true }`
instead. Send it again with `"force": true` to open it anyway.

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

With neither `text` nor `blanks`, the profile prompt is pasted as it is. Every
blank in it has to be filled.

The text is pasted the way the desktop's Send button does it, as one bracketed
paste. The call waits, up to a minute, until the program in the window is
reading keys, so it works on a window that was opened a moment ago. A harness
that stops on a question first, like Claude asking whether to trust a new
folder, gets the paste in that question.

After a send, the desktop no longer offers the profile prompt above the window.

`DELETE /api/windows/:window` ends the window's session and removes it.

`GET /api/windows/:window/attach` returns the `ssh` command that attaches a
terminal to the window.

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

`vibe-os ls`, `workspace`, `open` and `close` call the stable routes. On the box
they find the server and its token on their own. From anywhere else, pass
`--url` and `--token`, or set `VIBE_OS_URL` and `VIBE_OS_TOKEN`.

```sh
# cut a workspace for issue #123 from a branch
vibe-os workspace new api --from fix-123

# open it as the QA profile and hand it a prompt
vibe-os open quiet-amber-otter --profile QA --prompt "Reproduce #123 and write a failing test" --submit

# or fill the QA profile's own prompt
vibe-os open quiet-amber-otter --profile QA --blank ticket=#123 --submit

vibe-os ls
vibe-os close quiet-amber-otter-1
```

| command | |
| --- | --- |
| `vibe-os ls` | list windows, and which are running |
| `vibe-os workspace new <project> [--from <branch>] [--name <name>]` | create a workspace and print its name |
| `vibe-os workspace ls [project]` | list workspaces |
| `vibe-os open <workspace> [--profile <name>] [--prompt <text>] [--blank label=value] [--submit] [--force]` | add a window, start it, and paste a prompt if given. Prints the window's ref |
| `vibe-os close <window>` | close a window and end its session |

A workspace can be named as `project/name` when two projects have one with the
same name. `--prompt -` reads the prompt from stdin. `--json` prints what the
API returned instead of text.

If a window cannot be started, `open` removes it again and exits non-zero.
