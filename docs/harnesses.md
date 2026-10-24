# Harnesses

A harness is the program a profile launches. vibe-os ships Claude, Hermes,
Cursor, Codex and Pi, plus a plain shell and a custom command. You can add your own
without changing vibe-os.

## Built in

### Hermes

Picking the Hermes harness runs `hermes chat` in the worktree, and the editor
offers a model, a provider, a thinking dropdown (`--reasoning`), an interface
(`--cli` or `--tui`) and the same kind of switches, `--yolo` among them.

Models are typed rather than picked. `hermes model` is an interactive wizard
with no listing mode, so there is nothing to read off the box. The provider list
is real: it is whatever `~/.hermes/config.yaml` has been set up with, so adding
one with `hermes model` makes it appear here. Reasoning levels are read off
`hermes chat --help`, so that ladder follows Hermes' releases.

### Cursor

Picking the Cursor harness runs `cursor-agent` in the worktree, and the editor
offers a model and a handful of switches. Two of them matter most: `--force`,
which is Cursor's spelling of skip-every-check, and `--trust`, which matters
here more than anywhere else: every workspace is a freshly cut worktree, which
to Cursor is a directory it has never seen, so without it every new window opens
on the trust prompt instead of the conversation.

Models come from `cursor-agent models`. The list belongs to the account rather
than the binary: it needs a login, and sometimes the network, so when it cannot
be read the field is plain free text and typed ids still work.

Logging in is a property of the box, not of a profile: run `cursor-agent
login` once on the box. Logged out, a Cursor window opens and sits at the
login prompt. `vibe-os doctor` says so before you find out that way.

MCP servers are a property of the box as well. Configure them in
`~/.cursor/mcp.json`, then log in once, from inside any window:

```sh
cursor-agent mcp login linear
```

Cursor files MCP credentials per directory, which would mean one login per
workspace. vibe-os points every workspace at a single store under the state dir
instead, so that one login covers the ones opened later too. A switch,
`--approve-mcps`, skips the approval prompt each new workspace would otherwise
ask for.

### Codex

Picking the Codex harness runs `codex` in the worktree, and the editor offers a
model, a thinking dropdown, a sandbox, an approval policy and a few switches,
`--dangerously-bypass-approvals-and-sandbox` among them. Models and thinking
levels come from `codex debug models`, so they follow the installed CLI.

Log in once on the box with `codex login --device-auth`. Logged out, a Codex
window sits at the login screen, and `vibe-os doctor` says so.

### Pi

Picking the Pi harness runs `pi` in the worktree, and the editor offers a
model, a thinking dropdown (`--thinking`), an interface (`--tui-mode`) and a few
switches. Models come from `pi --list-models`, which lists only the providers
the box has credentials for, grouped by provider. A model is written as
`--model provider/id`, so the same model from two providers is two choices.

Pi never asks before running a tool, so there is no skip-approvals switch. New
profiles start with two flags:

- `--tui-mode regular`. Pi's fullscreen interface captures the mouse, and a
  browser terminal then cannot select or copy text.
- `--approve`. Pi asks whether to trust a project folder that has a `.pi`
  directory, and every workspace is a worktree it has not seen. Trusting
  loads the repo's `.pi` extensions and MCP servers, which run code, so turn it
  off for a repository you did not write. Without it, answering **Trust parent
  folder** once covers every later workspace of the project, since they share a
  parent.

In a browser window, Shift+Enter submits like Enter. Press Ctrl+J for a new line
in Pi's editor.

Leaving the thinking dropdown on Default leaves `--thinking` out. Pi then starts
at `defaultThinkingLevel` from `~/.pi/agent/settings.json`, or `medium` when
that is not set, and the dropdown says which. A model that lacks that level runs
at the next one up that it has, so DeepSeek V4.1 Flash runs `medium` as `high`.
A resumed conversation keeps the level it was recorded with.

Credentials belong in Pi's own store, not in a shell profile: a window does not
read `.profile`, and neither does the server when it lists models. Run `pi` once
on the box and use `/login` there. Logged out, a Pi window opens with no model,
and `vibe-os doctor` says so.

#### OpenCode Go and DeepSeek

To run DeepSeek V4.1 Flash through an OpenCode Go subscription:

1. In the OpenCode console, under **Settings › Privacy**, select **Global**
   under **Regions**. Go allows only Europe and the United States by default,
   and DeepSeek models are served outside both.
2. On the box, run `pi`, then `/login opencode-go`, and paste the key.
3. In the profile editor, pick **OpenCode Go › deepseek-v4.1-flash**. The
   profile runs `pi --model opencode-go/deepseek-v4.1-flash`.

Go has one DeepSeek V4.1 Flash, with no dated checkpoints to pick from. The
same model is also on OpenCode Zen (`opencode/…`, `/login opencode`) and
DeepSeek's own API (`deepseek/deepseek-flash`, `/login deepseek`). Zen's free
models refuse requests from any client but OpenCode's own, Pi included.

Pi needs Node.js 22.19 or newer, and OpenCode needs Pi 1.3.0 or newer. `vibe-os
doctor` checks both.

Windows look for `pi` in `~/.local/bin` and on the system PATH. The installer
uses `~/.local/bin` when it is on PATH at install time, and `~/.pi/agent/bin`
otherwise; in that case link it, or windows cannot start it:

```sh
ln -s ~/.pi/agent/bin/pi ~/.local/bin/pi
```

## Adding one to a box

Put a JSON file in `~/.vibe-os/harnesses/` (or `harnesses/` under your
`--state-dir`) and restart the server. It shows up in the profile editor's
harness picker, `vibe-os doctor` checks it, and profiles can launch it.

```json
{
  "id": "aider",
  "label": "Aider",
  "command": "aider",
  "paths": ["~/.local/bin/aider"],
  "install": "python -m pip install aider-install && aider-install",
  "defaults": ["--yes-always"],
  "fields": [
    {
      "kind": "select",
      "key": "model",
      "label": "Model",
      "flag": "--model",
      "free": true,
      "options": ["sonnet", "gpt-4o"]
    },
    {
      "kind": "select",
      "key": "edit-format",
      "label": "Edit format",
      "flag": "--edit-format",
      "options": ["whole", "diff", "udiff"]
    },
    { "kind": "toggle", "flag": "--yes-always", "label": "Skip confirmations" },
    { "kind": "toggle", "flag": "--no-auto-commits", "label": "No auto-commits" }
  ],
  "valued": ["--read", "--file"]
}
```

A file that does not parse or validate is skipped. The server logs why, and
`vibe-os doctor` lists it under `harness file`.

### Fields

| key | |
| --- | --- |
| `id` | what profiles store. Lowercase letters, digits and dashes. Cannot be a built-in's id, `shell` or `custom` |
| `label` | the name in the harness picker |
| `command` | the binary, looked up on `PATH` |
| `paths` | other places to look for it. `~` is the home directory |
| `leading` | arguments that always come first, like a subcommand (`["chat"]`) |
| `resume` | how to continue the last conversation after a reboot, see below |
| `install` | the command `vibe-os doctor` prints when the binary is missing |
| `version` | arguments that print a version. Defaults to `["--version"]` |
| `login` | `{ "args": [...], "fix": "..." }`: a command that reports the login state, and the one that logs in |
| `defaults` | the flags a new profile starts with |
| `fields` | the controls the editor shows, in order |
| `valued` | flags the controls do not own that take a value, so the value stays with its flag in the Advanced field |
| `optional` | flags whose value is optional |
| `extraPlaceholder` | placeholder text for the Advanced field |

Only these keys are accepted, so a typo is an error rather than ignored.

### Controls

A **toggle** is a switch under Options:

| key | |
| --- | --- |
| `flag` | the flag it writes, like `--yes-always` |
| `aliases` | other spellings that turn it on, like `["-y"]` |
| `label` | |
| `hint` | tooltip |
| `warn` | a warning shown while it is on |

A **select** is a dropdown, or a text field:

| key | |
| --- | --- |
| `key` | a unique name for the field |
| `label` | |
| `flag` | the flag that takes the value, like `--model` |
| `aliases` | other spellings of `flag`, like `["-m"]` |
| `prefix` | text in front of the value, for a flag shared between fields: `"prefix": "model_reasoning_effort="` with `"flag": "-c"` writes `-c model_reasoning_effort=high` |
| `options` | the values to offer, as strings or `{ "value", "label", "group" }` |
| `specials` | values written as a flag of their own, as `{ "value", "label", "flag", "aliases", "warn" }` |
| `free` | `true` for a text field with `options` as suggestions |
| `none` | the label for leaving it empty |
| `placeholder` | placeholder text for the text field |
| `hint` | shown under the field. Text in backticks shows as code |

A select needs a `flag`, `specials`, or both. With no options at all it is a
text field.

### Resume

```json
"resume": { "args": ["--continue"], "unless": ["--continue", "-c"] }
```

`args` go after the profile's flags. `unless` lists flags that already pick a
conversation, so a profile that has one is not given a second. For a harness
that resumes with a subcommand, set `"subcommand": true` and `args` go straight
after the command instead: Codex's is `["resume", "--last"]`.

Without `resume`, a window whose session died after a reboot can only start
fresh.

### Flags in the Advanced field

Whatever the controls do not recognise is kept in the Advanced field, in its
original order, and written back exactly as typed. A profile never loses a flag
by being opened and saved.

## Adding one to vibe-os

A built-in harness is one file in `server/harnesses/` and one line in
`BUILT_IN` in `server/harness.ts`. It is the same spec as above, written in
TypeScript, with optional code a JSON file cannot have:

- `discover(binary)` reads models and options off the installed binary.
  Whatever it returns for a field's `key` replaces that field's `options`. It
  has a minute before the editor goes without it.
- `setup({ cwd, stateDir })` returns shell to run in the window before the
  harness starts.
- `checks(report, detail)` returns extra `vibe-os doctor` checks.

A built-in can also use the `mcp` field kind, which is Claude's MCP picker.
`server/harnesses/codex.ts` is a complete example, and `server/harnesses/pi.ts`
shows a harness with no single login.
