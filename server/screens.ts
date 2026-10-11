// Reading what a window shows, with no terminal attached.
//
// dtach keeps no copy of what a program has drawn. It moves bytes from the pty
// to whoever is attached and forgets them. So the server attaches as well: for
// every running session it holds one connection to the dtach socket, speaking
// dtach's own packet protocol, and feeds the output into a headless xterm. That
// gives the API a screen it can read as text, and the time of the last output,
// which is how an agent at work is told from one waiting at its prompt.
//
// The connection has to send MSG_ATTACH, because dtach only writes output to
// attached clients. It never sends a size, except once to ask for a repaint (see
// `repaint`), so the pty stays the size the browser or `vibe-os attach` gave it.
// And it is not a `dtach -a` process, so `clientsOn` does not count it and
// nothing about the one-client rule changes.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import { Terminal } from "@xterm/headless";
import type { Activity } from "../shared/wire.ts";
import type { Config } from "./config.ts";
import { sessionTty } from "./headless.ts";
import { log } from "./log.ts";
import { DETACHED_COLS, DETACHED_ROWS, socketPath } from "./session.ts";

const run = promisify(execFile);

/**
 * Output within this long means the program is busy.
 *
 * Every harness animates something while it works (Claude's spinner redraws
 * several times a second) and draws nothing at all while it waits for input,
 * so a second and a half of quiet is a clear line between the two.
 */
export const QUIET_MS = 1_500;
/** History kept per window, beyond the screen itself. */
const SCROLLBACK = 1_000;
/** How often to look for sessions started by something other than this server. */
const SYNC_MS = 5_000;
/** How often output may trigger a check that the pty is still the same size. */
const SIZE_CHECK_MS = 1_000;
/** How long the width stays one column short while asking for a repaint. */
const NUDGE_MS = 200;
const POLL_MS = 250;

/**
 * What a program waiting on a question looks like, as opposed to waiting at its
 * prompt.
 *
 * Matched against the visible screen only, so a question answered long ago and
 * scrolled away does not count. Claude's dialogs (trust this folder, allow this
 * command) and Codex's approvals all end in a "confirm" or "cancel" line, and
 * the rest are the shapes a numbered menu or a yes/no question take.
 */
export const QUESTION_PATTERNS: RegExp[] = [
  /enter to confirm/i,
  /esc to cancel/i,
  /^\s*[❯›]\s*\d+\.\s+\S/m,
  /\((y\/n)\)|\[(y\/n)\]/i,
];

// dtach's packet: a type byte, a length byte, then a `struct winsize` of four
// unsigned shorts, in the machine's own byte order. See dtach.h.
const MSG_ATTACH = 1;
const MSG_REDRAW = 4;
const REDRAW_WINCH = 3;
const PACKET_BYTES = 10;

export function packet(
  type: number,
  len = 0,
  size?: { rows: number; cols: number },
): Buffer {
  const buf = Buffer.alloc(PACKET_BYTES);
  buf[0] = type;
  buf[1] = len;
  if (size) {
    if (os.endianness() === "LE") {
      buf.writeUInt16LE(size.rows, 2);
      buf.writeUInt16LE(size.cols, 4);
    } else {
      buf.writeUInt16BE(size.rows, 2);
      buf.writeUInt16BE(size.cols, 4);
    }
  }
  return buf;
}

/** Whether a program is working, waiting on a question, or at its prompt. */
export function classify(
  lastOutputAt: number | null,
  now: number,
  visible: string,
): Activity {
  if (lastOutputAt !== null && now - lastOutputAt < QUIET_MS) return "busy";
  if (QUESTION_PATTERNS.some((p) => p.test(visible))) return "question";
  return "idle";
}

/** Reads `stty size`: rows, then columns. */
export function parseSize(out: string): { rows: number; cols: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
  if (!m) return null;
  const rows = Number(m[1]);
  const cols = Number(m[2]);
  return rows > 0 && cols > 0 ? { rows, cols } : null;
}

async function ttySize(
  tty: string,
): Promise<{ rows: number; cols: number } | null> {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  try {
    const { stdout } = await run("stty", [flag, tty, "size"], {
      timeout: 5_000,
    });
    return parseSize(stdout);
  } catch {
    return null;
  }
}

/**
 * The last `count` lines of a terminal, as plain text.
 *
 * A line the terminal wrapped is joined back to the one it continues, so a
 * long line reads as it was written rather than as the width it was drawn at.
 * Blank lines at the bottom, which are only the unused part of the screen, are
 * dropped.
 */
export function bufferText(term: Terminal, count: number): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    // Untrimmed until joined, or a space at the wrap point would be lost.
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const trimmed = lines.map((l) => l.trimEnd());
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "")
    trimmed.pop();
  return trimmed.slice(-count).join("\n");
}

/** One session's screen, kept up to date by its connection. */
export class Screen {
  readonly term = new Terminal({
    rows: DETACHED_ROWS,
    cols: DETACHED_COLS,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  /** When the program last drew anything, or null if not since we attached. */
  lastOutputAt: number | null = null;
  private tty: string | null = null;
  private sizeCheckedAt = 0;
  private sizing = false;

  constructor(
    private readonly sock: string,
    private readonly socket: net.Socket,
  ) {}

  feed(data: Buffer): void {
    this.lastOutputAt = Date.now();
    this.term.write(data);
    if (Date.now() - this.sizeCheckedAt > SIZE_CHECK_MS) void this.syncSize();
  }

  activity(now = Date.now()): Activity {
    return classify(this.lastOutputAt, now, this.visible());
  }

  /** What the screen shows right now: the bottom `rows` lines of the buffer. */
  visible(): string {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let i = buf.baseY; i < buf.baseY + this.term.rows; i++)
      out.push(buf.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n");
  }

  text(lines: number): string {
    return bufferText(this.term, lines);
  }

  /**
   * Follows the pty's size, which whoever attaches last decides.
   *
   * Checked when output arrives rather than on a timer, because a resize is
   * always followed by the program redrawing at the new size.
   */
  async syncSize(): Promise<{ rows: number; cols: number } | null> {
    if (this.sizing) return null;
    this.sizing = true;
    this.sizeCheckedAt = Date.now();
    try {
      this.tty ??= await sessionTty(this.sock);
      const size = this.tty ? await ttySize(this.tty) : null;
      if (
        size &&
        (size.rows !== this.term.rows || size.cols !== this.term.cols)
      )
        this.term.resize(size.cols, size.rows);
      return size;
    } finally {
      this.sizing = false;
    }
  }

  /**
   * Asks the program to draw its whole screen again, for a session that was
   * running before we attached.
   *
   * dtach's redraw sends SIGWINCH, but a program that finds its size unchanged
   * may not repaint (Claude does not). So the width goes one column narrower
   * and back. Whoever is attached sees one extra repaint.
   */
  async repaint(): Promise<void> {
    const size = await this.syncSize();
    if (!size || size.cols < 2) return;
    this.socket.write(
      packet(MSG_REDRAW, REDRAW_WINCH, { ...size, cols: size.cols - 1 }),
    );
    await Bun.sleep(NUDGE_MS);
    if (!this.socket.destroyed)
      this.socket.write(packet(MSG_REDRAW, REDRAW_WINCH, size));
  }

  close(): void {
    this.socket.destroy();
    this.term.dispose();
  }
}

/** Every running session's screen, keyed by session name. */
export class Screens {
  private readonly open = new Map<string, Screen>();
  private readonly pending = new Map<string, Promise<Screen | undefined>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: Config) {}

  /** Watches whatever is running now, then looks again every few seconds. */
  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const screen of this.open.values()) screen.close();
    this.open.clear();
  }

  get(session: string): Screen | undefined {
    return this.open.get(session);
  }

  /**
   * Attaches to a session if nothing is yet, and returns its screen.
   *
   * Undefined when the session is not running. `fresh` is for a session this
   * server has just created: it has drawn next to nothing yet, and asking it to
   * repaint would only make it draw its startup twice.
   */
  watch(
    session: string,
    opts: { fresh?: boolean } = {},
  ): Promise<Screen | undefined> {
    const open = this.open.get(session);
    if (open) return Promise.resolve(open);
    let attempt = this.pending.get(session);
    if (!attempt) {
      attempt = this.connect(session, opts.fresh === true).finally(() =>
        this.pending.delete(session),
      );
      this.pending.set(session, attempt);
    }
    return attempt;
  }

  private connect(
    session: string,
    fresh: boolean,
  ): Promise<Screen | undefined> {
    const sock = socketPath(this.config, session);
    return new Promise((resolve) => {
      const socket = net.createConnection(sock);
      socket.once("error", () => resolve(undefined));
      socket.once("connect", () => {
        socket.write(packet(MSG_ATTACH));
        const screen = new Screen(sock, socket);
        this.open.set(session, screen);
        socket.on("data", (data: Buffer) => screen.feed(data));
        socket.on("error", () => {});
        socket.on("close", () => {
          if (this.open.get(session) === screen) this.open.delete(session);
          screen.close();
        });
        log.debug(`watching ${session}`);
        if (fresh) void screen.syncSize();
        else void screen.repaint();
        resolve(screen);
      });
    });
  }

  /** Attaches to every socket in the sessions directory not already watched. */
  async sync(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(`${this.config.stateDir}/sessions`);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((n) => n.endsWith(".sock"))
        .map((n) => n.slice(0, -".sock".length))
        .filter((s) => !this.open.has(s))
        .map((s) => this.watch(s)),
    );
  }

  /**
   * Waits for a session to stop drawing, and says what it stopped on.
   *
   * The quiet has to be seen, not assumed: a session started a moment ago has
   * drawn nothing yet, which looks the same as one that has finished. So the
   * wait counts from when it began as if that were output, and always lasts at
   * least `QUIET_MS`. Returns "busy" if it was still going when time ran out.
   */
  async settle(session: string, timeoutMs: number): Promise<Activity> {
    const begun = Date.now();
    const deadline = begun + timeoutMs;
    for (;;) {
      const screen = this.get(session) ?? (await this.watch(session));
      const now = Date.now();
      const state = screen
        ? classify(
            Math.max(screen.lastOutputAt ?? 0, begun),
            now,
            screen.visible(),
          )
        : "idle";
      if (state !== "busy" || now > deadline) return state;
      await Bun.sleep(POLL_MS);
    }
  }

  /** Waits for any output after `since`. False if none came in time. */
  async drewSince(
    session: string,
    since: number,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.get(session)?.lastOutputAt ?? null;
      if (at !== null && at > since) return true;
      if (Date.now() > deadline) return false;
      await Bun.sleep(POLL_MS / 5);
    }
  }
}
