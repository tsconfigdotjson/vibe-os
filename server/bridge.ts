// The WebSocket ↔ TCP byte pipe.
//
// Deliberately dumb: it moves bytes between the browser's WebSocket and a TCP
// socket and understands nothing about SSH. Key exchange, auth and channel
// multiplexing all happen inside the browser's WASM sandbox, so this process
// never sees plaintext and holds no SSH credentials for the session.
//
// ── Backpressure ─────────────────────────────────────────────────────────────
// This is the part worth reading twice. SSH is encrypted and MAC'd, so a single
// dropped or reordered byte does not degrade a session, it kills it. Bun's
// ServerWebSocket.send() has three outcomes:
//
//     > 0   bytes handed to the socket
//      -1   enqueued because we are already in backpressure — safe
//       0   DROPPED because the backpressure limit was exceeded — fatal here
//
// The rule that keeps us out of the fatal case: the instant send() returns -1,
// pause the TCP source, and only resume from the drain() callback. That way we
// never keep pushing into a full queue and never earn a 0. Measured on Bun
// 1.3.10 with 125MB through a deliberately slow reader: byte-exact, in order,
// zero drops.
//
// The browser→sshd direction needs no equivalent dance; it carries keystrokes.
// It is still capped defensively, because "the peer is malicious" is a
// different question from "the peer is slow".

import net from "node:net";
import type { ServerWebSocket } from "bun";
import { log } from "./log.ts";

/** Cap on bytes buffered toward sshd before we treat the client as hostile. */
const MAX_PENDING_TO_SSHD = 8 * 1024 * 1024;

export interface BridgeData {
  socket: net.Socket | null;
  peer: string;
  closed: boolean;
}

export interface BridgeTarget {
  host: string;
  port: number;
}

let open = 0;

export function bridgeConnections(): number {
  return open;
}

export function createBridgeHandlers(
  target: BridgeTarget,
  maxConnections = 64,
) {
  const shutdown = (ws: ServerWebSocket<BridgeData>, why: string) => {
    if (ws.data.closed) return;
    ws.data.closed = true;
    open -= 1;
    log.debug(`bridge ${ws.data.peer} closed (${why}); ${open} open`);
    ws.data.socket?.destroy();
    ws.data.socket = null;
    try {
      ws.close();
    } catch {
      // already gone
    }
  };

  return {
    atCapacity: () => open >= maxConnections,

    handlers: {
      // Generous ceiling. We should never reach it — pausing on -1 keeps the
      // queue short — but closing the connection is far better than silently
      // dropping bytes if the assumption ever breaks.
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,

      open(ws: ServerWebSocket<BridgeData>) {
        open += 1;
        const socket = net.connect(target.port, target.host);
        ws.data.socket = socket;
        socket.setNoDelay(true);

        // Without this an unreachable target leaves the browser staring at a
        // connected WebSocket until the OS gives up, which can be minutes.
        socket.setTimeout(15_000, () => {
          if (socket.connecting) {
            log.warn(
              `bridge ${ws.data.peer}: ${target.host}:${target.port} did not answer`,
            );
            shutdown(ws, "connect timeout");
          }
        });

        socket.on("connect", () => {
          socket.setTimeout(0);
          log.debug(`bridge ${ws.data.peer} → ${target.host}:${target.port}`);
        });

        socket.on("data", (chunk: Buffer) => {
          const rc = ws.send(chunk);
          if (rc === 0) {
            // Should be unreachable given the pause below. If it ever happens
            // the stream is already corrupt, so fail loudly rather than let a
            // half-broken SSH session limp along.
            log.warn(
              `bridge ${ws.data.peer}: websocket dropped a frame — closing`,
            );
            shutdown(ws, "backpressure drop");
            return;
          }
          if (rc === -1) socket.pause();
        });

        socket.on("error", (err) => {
          log.debug(`bridge ${ws.data.peer} tcp error: ${err.message}`);
          shutdown(ws, "tcp error");
        });
        socket.on("close", () => shutdown(ws, "tcp closed"));
      },

      message(ws: ServerWebSocket<BridgeData>, message: string | Buffer) {
        const socket = ws.data.socket;
        if (!socket || socket.destroyed) return;
        if (socket.writableLength > MAX_PENDING_TO_SSHD) {
          log.warn(`bridge ${ws.data.peer}: client outran sshd — closing`);
          shutdown(ws, "write buffer full");
          return;
        }
        socket.write(
          typeof message === "string" ? Buffer.from(message) : message,
        );
      },

      drain(ws: ServerWebSocket<BridgeData>) {
        ws.data.socket?.resume();
      },

      close(ws: ServerWebSocket<BridgeData>) {
        shutdown(ws, "ws closed");
      },
    },
  };
}
