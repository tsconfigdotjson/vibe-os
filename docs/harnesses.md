# Harnesses

A harness is the program a profile launches. vibe-os ships Claude, Hermes,
Cursor and Codex, plus a plain shell and a custom command. You can add your own
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
`server/harnesses/codex.ts` is a complete example.
