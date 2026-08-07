import type { SshTermConfig } from './sshterm';

/** Mirrors ClientConfig in server/api.ts. */
export interface ServerConfig {
  version: string;
  hostname: string;
  user: string;
  workspaceRoot: string;
  tmux: boolean;
  authRequired: boolean;
  endpoint: { name: string; url: string };
  hostKey: string | null;
  /**
   * Computed server-side on purpose: the browser cannot do it on plain HTTP,
   * where `crypto.subtle` is unavailable because the origin is not secure.
   */
  hostKeyFingerprint: string | null;
  certificateEndpoint: string;
  maxWallpaperBytes: number;
}

export async function fetchServerConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/config failed: HTTP ${res.status}`);
  return (await res.json()) as ServerConfig;
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
 * handler; tmux would fail outright and a shell would be unusable. The command
 * travels in the certificate's force-command instead, so sshd runs it inside
 * the PTY it already allocated for the shell request.
 */
export function windowSshConfig(server: ServerConfig, windowId: string): SshTermConfig {
  // Only the window id goes over the wire. The server looks up which workspace
  // it belongs to and starts tmux in that worktree, so a browser cannot ask for
  // a session in a directory of its choosing.
  const identityProvider = new URL(
    `${server.certificateEndpoint}?window=${encodeURIComponent(windowId)}`,
    window.location.origin,
  ).href;

  return {
    // One database for the app, one key per pane inside it.
    dbName: 'vibe-os',
    persist: true,
    theme: 'dark',
    endpoints: [server.endpoint],
    hosts: server.hostKey ? [{ name: server.endpoint.name, key: server.hostKey }] : [],
    generateKeys: [
      {
        name: `vibe-${windowId}`,
        type: 'ed25519',
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
