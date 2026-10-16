# MCP

vibe-os is an MCP server. An agent in Claude Code, Codex, Cursor or another MCP
client can cut workspaces, open windows as profiles, hand them prompts, wait for
them to finish and read what they said. It is the [API](api.md) as tools, at
`/mcp` on the same server, behind the same token.

It speaks the 2026-07-28 revision of MCP, and serves 2025-11-25 clients as well.

## Tools

| tool | |
| --- | --- |
| `vibe_list_windows` | the windows on the box, with their state and turn. Filters: `label`, `workspace`, `state` |
| `vibe_list_workspaces` | workspaces, most recently opened first. Filter: `project` |
| `vibe_list_projects` | projects, each with its profiles: name, harness, and the blanks in its prompt |
| `vibe_create_workspace` | a new worktree of a project. `project` takes `project/name` to name it |
| `vibe_open_window` | opens a window in a workspace as a profile (by name), starts it, and sends `prompt` or `blanks`, submitted unless `submit: false`. `reuse` with `label` returns the window already open under that label |
| `vibe_send` | text, submitted unless `submit: false`, or `keys` |
| `vibe_read_output` | what a window shows. `after` reads on from a cursor |
| `vibe_wait` | blocks until a window, or the first of several, settles. Up to 240 seconds, default 120 |
| `vibe_read_messages` | the last messages of a Claude window's conversation, from its transcript |
| `vibe_close_window` | closes a window |
| `vibe_delete_workspace` | ends a workspace's windows and removes its worktree. The branch is kept |

Windows are named by their ref, like `quiet-amber-otter-1`. A window's state is
`busy`, `idle`, `question` or `asleep`, as in the [API](api.md#windows).

The usual round is: `vibe_open_window` with a prompt, `vibe_wait`, then
`vibe_read_messages` for a Claude window or `vibe_read_output` for anything else.
A window on a question (a menu, a yes/no, a permission prompt) needs an answer:
read it with `vibe_read_output`, then `vibe_send` with `keys`, like `["2"]` or
`["y"]`. `["Escape"]` stops a busy agent.

`vibe_wait` waits for the window to answer the last send, not just for quiet, so
the moment before an agent starts on a prompt does not count. With a progress
token, it reports progress every 20 seconds and on every change, which keeps a
client's idle timeout from firing during a long turn. Claude Code moves a call
that runs past two minutes into the background and says when it finishes.

Neither `vibe_wait` nor `vibe_read_output` wakes a hibernated window.
`vibe_send` does.

Text results are cut at about 32,000 characters, keeping the end, with a note
saying how much was cut.

## Setup

The server's URL is the desktop's, plus `/mcp`. The token is the one in
`~/.vibe-os/config.json`, or the one `vibe-os start` printed.

### Claude Code

```sh
claude mcp add --transport http vibe-os https://box.tailnet.ts.net/mcp \
  --header "Authorization: Bearer $VIBE_OS_TOKEN"
```

Or in `.mcp.json`, where `${VIBE_OS_TOKEN}` is read from the environment:

```json
{
  "mcpServers": {
    "vibe-os": {
      "type": "http",
      "url": "https://box.tailnet.ts.net/mcp",
      "headers": { "Authorization": "Bearer ${VIBE_OS_TOKEN}" }
    }
  }
}
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.vibe-os]
url = "https://box.tailnet.ts.net/mcp"
bearer_token_env_var = "VIBE_OS_TOKEN"
```

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vibe-os": {
      "url": "https://box.tailnet.ts.net/mcp",
      "headers": { "Authorization": "Bearer ${env:VIBE_OS_TOKEN}" }
    }
  }
}
```

### Over stdio

`vibe-os mcp` is the same tools over stdin and stdout, for a client that starts
a command rather than calling a URL. It finds the server the way `vibe-os ls`
does: on the box, from `~/.vibe-os/config.json`; elsewhere, from `--url` and
`--token` or `VIBE_OS_URL` and `VIBE_OS_TOKEN`.

```sh
claude mcp add vibe-os -- vibe-os mcp
```

It logs to stderr only.

## Authentication

`/mcp` takes the token as `Authorization: Bearer <token>`, or the desktop's
cookie. A token in the query string is not accepted there. Without a token, the
answer is `401` with `WWW-Authenticate: Bearer`. A server started with
`--no-token` needs none, and answers only to its own names, as for the API.

claude.ai and Claude Desktop connectors cannot use it yet: they need OAuth, and
vibe-os has a single static token.

## Through Tailscale Funnel

To reach `/mcp` from outside the tailnet, for example from a scheduled job in
the cloud, funnel that path alone on a port of its own:

```sh
sudo tailscale funnel --bg --https=8443 --set-path /mcp http://127.0.0.1:7681/mcp
```

That makes `https://<machine>.<tailnet>.ts.net:8443/mcp` public. It still needs
the token, and the token is a shell on the box, so keep it out of anything that
is logged.

## Not supported

- The MCP Tasks extension. `vibe_wait` is the way to wait for long work.
- Resources and subscriptions. For a stream of window events, use
  [`GET /api/events`](api.md#events).
