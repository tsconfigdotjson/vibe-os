// `vibe-os mcp`: the /mcp endpoint for a client that launches a local process.
//
// Some MCP clients can only start a command and talk to it over stdin and
// stdout, and some cannot set an Authorization header. This bridges them to a
// running server: it serves tools/list and tools/call over stdio, and answers
// each by calling the same tool on /mcp over HTTP, with the token found the way
// `vibe-os ls` finds it. Progress from the server is passed back, so a long
// vibe_wait keeps the client's idle timer reset, and a cancelled call is
// cancelled on the server too.
//
// stdout is the protocol channel, so everything this says goes to stderr.

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import pkg from "../package.json" with { type: "json" };
import { type Remote, resolveRemote } from "./client.ts";
import type { RawOptions } from "./config.ts";
import { describeError } from "./log.ts";
import { MAX_WAIT_S } from "./ops.ts";

/**
 * How long one forwarded call may take: a full-length wait, and a margin.
 * Progress resets it, so this only ends a call the server went silent on.
 */
const CALL_TIMEOUT_MS = (MAX_WAIT_S + 60) * 1000;

/** Connects a client to the server's /mcp, as the bridge's upstream. */
export async function connectUpstream(
  remote: Remote,
  fetchImpl?: typeof fetch,
): Promise<Client> {
  const client = new Client(
    { name: "vibe-os-mcp-bridge", version: pkg.version },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`${remote.url}/mcp`),
    {
      requestInit: remote.token
        ? { headers: { authorization: `Bearer ${remote.token}` } }
        : undefined,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    },
  );
  await client.connect(transport);
  return client;
}

/** A stdio-side server that forwards every tool call to `upstream`. */
export function bridgeServer(upstream: Client): Server {
  const server = new Server(
    { name: "vibe-os", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions: upstream.getInstructions(),
    },
  );
  server.setRequestHandler("tools/list", async (request) =>
    upstream.listTools(request.params),
  );
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    let progress = 0;
    return (await upstream.callTool(
      { name: request.params.name, arguments: request.params.arguments },
      {
        signal: ctx.mcpReq.signal,
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        onprogress:
          token === undefined
            ? undefined
            : (p) => {
                // Renumbered: the client's sequence must only go up, whatever
                // the server's does.
                progress += 1;
                void ctx.mcpReq
                  .notify({
                    method: "notifications/progress",
                    params: { ...p, progressToken: token, progress },
                  })
                  .catch(() => {});
              },
      },
    )) as Awaited<ReturnType<Client["callTool"]>> & Record<string, unknown>;
  });
  return server;
}

/** Runs the bridge until stdin closes. */
export async function runMcpBridge(
  values: RawOptions,
  local: { port: number; stateDir: string },
): Promise<number> {
  let upstream: Client;
  let remote: Remote | undefined;
  try {
    remote = await resolveRemote(values, local);
    upstream = await connectUpstream(remote);
    console.error(`vibe-os mcp: bridging stdio to ${remote.url}/mcp`);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    console.error(
      `vibe-os mcp: ${
        !remote
          ? describeError(err)
          : status === 401 || /\b401\b/.test(describeError(err))
            ? `${remote.url} wants a token: pass --token or set VIBE_OS_TOKEN`
            : `could not reach vibe-os at ${remote.url}/mcp: ${describeError(err)}`
      }`,
    );
    return 1;
  }
  const handle = serveStdio(() => bridgeServer(upstream));
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await handle.close().catch(() => {});
  await upstream.close().catch(() => {});
  return 0;
}
