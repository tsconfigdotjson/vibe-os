// The WebSocket ↔ TCP byte pipe.
//
// This is the piece that replaces tlsproxy from the POC. It is deliberately
// dumb: it moves bytes between the browser's WebSocket and a TCP socket and
// understands nothing about SSH. The SSH protocol — key exchange, auth,
// channels, the lot — runs inside the browser's WASM sandbox, so this process
// never sees plaintext and holds no SSH credentials for the session.

import net from 'node:net';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { log } from './log.js';

export interface BridgeTarget {
  host: string;
  port: number;
}

export interface BridgeOptions {
  target: BridgeTarget;
  /** Returns null when the request is allowed, or a reason to reject it. */
  authorize: (req: IncomingMessage) => string | null;
  maxConnections?: number;
}

export interface Bridge {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
  readonly connections: number;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

/**
 * Rejects cross-origin upgrades.
 *
 * A browser will happily let any page on the internet open a WebSocket to a
 * host it can route to, and unlike fetch there is no preflight to stop it.
 * Since the app is always served from the same origin it talks to, anything
 * with a foreign Origin is either a mistake or an attack.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const max = options.maxConnections ?? 64;
  let connections = 0;

  const onConnection = (ws: WebSocket, req: IncomingMessage) => {
    const peer = req.socket.remoteAddress ?? '?';
    connections += 1;

    const tcp = net.connect(options.target.port, options.target.host);
    const stream = createWebSocketStream(ws);
    let closed = false;

    const shutdown = (why: string) => {
      if (closed) return;
      closed = true;
      connections -= 1;
      log.debug(`bridge ${peer} closed (${why}); ${connections} open`);
      stream.destroy();
      tcp.destroy();
      // 1011 = internal error; a clean end has already closed the socket.
      if (ws.readyState === ws.OPEN) ws.close();
    };

    tcp.setNoDelay(true);
    tcp.on('connect', () => {
      log.debug(`bridge ${peer} → ${options.target.host}:${options.target.port}`);
      // Piping through the duplex rather than shuttling messages by hand keeps
      // backpressure intact in both directions: a slow browser cannot make the
      // server buffer an unbounded amount of sshd output, and vice versa.
      stream.pipe(tcp);
      tcp.pipe(stream);
    });

    tcp.on('error', (err) => {
      log.debug(`bridge ${peer} tcp error: ${err.message}`);
      shutdown('tcp error');
    });
    tcp.on('close', () => shutdown('tcp closed'));
    stream.on('error', () => shutdown('ws stream error'));
    ws.on('error', () => shutdown('ws error'));
    ws.on('close', () => shutdown('ws closed'));
  };

  wss.on('connection', onConnection);

  return {
    handleUpgrade(req, socket, head) {
      if (!originAllowed(req)) {
        log.warn(`rejected cross-origin websocket upgrade from ${req.headers.origin}`);
        return rejectUpgrade(socket, 403, 'Forbidden');
      }
      const denied = options.authorize(req);
      if (denied) {
        log.warn(`rejected websocket upgrade: ${denied}`);
        return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      if (connections >= max) {
        log.warn(`rejected websocket upgrade: ${max} connection limit reached`);
        return rejectUpgrade(socket, 503, 'Service Unavailable');
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close() {
      wss.close();
    },
    get connections() {
      return connections;
    },
  };
}
