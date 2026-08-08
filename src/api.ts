import type { ClientConfig } from "../shared/wire";
import { request } from "./data";
import type { SshTermConfig } from "./sshterm";

const CONFIG_ROUTE = "/api/config";

/**
 * The `/api/config` body. Named for the client's point of view; it is the same
 * declaration the server builds against.
 */
export type ServerConfig = ClientConfig;

/**
 * Through the shared helper, so a failure here reads like a failure anywhere
 * else. Its own fetch discarded the server's `{ error }` body, which meant a
 * config failure showed "HTTP 500" where the same failure on any other route
 * showed the actual reason.
 */
export function fetchServerConfig(): Promise<ServerConfig> {
  return request<ServerConfig>(CONFIG_ROUTE);
}

/**
 * Builds the sshterm config for one window.
 *
 * Two details are load-bearing:
 *
 * `identityProvider` must be an absolute URL. The Go HTTP client compiled to
 * WASM cannot resolve a relative one — it needs a scheme and host to pick a
 * transport — so it is resolved against the page origin here.
 *
 * `autoConnect.command` is deliberately left unset. Setting it takes upstream's
 * `session.Run(command)` path, which requests no PTY and installs no resize
 * handler; dtach would fail outright and a shell would be unusable. The command
 * travels in the certificate's force-command instead, so sshd runs it inside
 * the PTY it already allocated for the shell request.
 */
export function windowSshConfig(
  server: ServerConfig,
  windowId: string,
): SshTermConfig {
  // Only the window id goes over the wire. The server looks up which workspace
  // it belongs to and starts the session in that worktree, so a browser cannot ask for
  // a session in a directory of its choosing.
  const identityProvider = new URL(
    `${server.certificateEndpoint}?window=${encodeURIComponent(windowId)}`,
    window.location.origin,
  ).href;

  return {
    // One database for the app, one key per pane inside it.
    dbName: "vibe-os",
    persist: true,
    theme: "dark",
    endpoints: [server.endpoint],
    hosts: server.hostKey
      ? [{ name: server.endpoint.name, key: server.hostKey }]
      : [],
    generateKeys: [
      {
        name: `vibe-${windowId}`,
        type: "ed25519",
        identityProvider,
      },
    ],
    autoConnect: {
      username: server.user,
      hostname: server.endpoint.name,
      identity: `vibe-${windowId}`,
    },
  };
}
