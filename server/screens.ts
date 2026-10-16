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
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import { type IBuffer, type IBufferLine, Terminal } from "@xterm/headless";
import type { Activity, Turn } from "../shared/wire.ts";
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

/** A harness's input line: its prompt glyph, then whatever has been typed. */
const PROMPT_LINE = /^\s*[❯›]\s?(.*)$/;

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
 * Rows `from` to `to` of a buffer as plain text lines.
 *
 * A row the terminal wrapped is joined to the one it continues, and faint text
 * on `cursorRow` is left out (see `bufferText`).
 */
function rowsText(
  buf: IBuffer,
  from: number,
  to: number,
  cursorRow: number,
): string[] {
  const lines: string[] = [];
  for (let i = from; i < to; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    // Untrimmed until joined, or a space at the wrap point would be lost.
    const text =
      i === cursorRow ? withoutFaint(line) : line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const trimmed = lines.map((l) => l.trimEnd());
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "")
    trimmed.pop();
  return trimmed;
}

/**
 * The last `count` lines of a terminal, as plain text.
 *
 * A line the terminal wrapped is joined back to the one it continues, so a
 * long line reads as it was written rather than as the width it was drawn at.
 * Blank lines at the bottom, which are only the unused part of the screen, are
 * dropped.
 *
 * Faint text on the cursor's line is left out. That is where a harness draws a
 * placeholder or a suggested prompt, greyed out with SGR 2 (Claude's `Try
 * "…"`, Codex's hint), and as plain text it reads the same as something typed
 * and not yet sent. The cursor is the input caret in both, so its line is the
 * input line.
 */
export function bufferText(term: Terminal, count: number): string {
  const buf = term.buffer.active;
  return rowsText(buf, 0, buf.length, buf.baseY + buf.cursorY)
    .slice(-count)
    .join("\n");
}

/** What `Screen.since` returns: the history added after a cursor, and the screen. */
export interface Since {
  /** Lines that scrolled off the screen after the cursor, oldest first. */
  text: string;
  /** The screen as it is now, which can still be redrawn. */
  screen: string;
  /** Pass this back as `after` next time. */
  cursor: number;
  /** Some of what came after the cursor is no longer held. */
  truncated: boolean;
}

/**
 * A screen's state changes, and how the turn after a send is going.
 *
 * `null` for a state is a session that stopped running.
 */
export type ScreenEvent =
  | {
      type: "state";
      session: string;
      from: Activity | null;
      to: Activity | null;
      at: number;
    }
  | { type: "turn"; session: string; turn: Turn; at: number }
  | { type: "asleep" | "woke"; session: string; at: number };

/** The xterm internals the cursor needs: the normal buffer's line list. */
interface LineList {
  onTrim: (fn: (n: number) => void) => { dispose(): void };
}

/** A line's text with every faint cell read as a blank. */
function withoutFaint(line: IBufferLine): string {
  let text = "";
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    // The second half of a wide character has width 0 and no text of its own.
    if (!cell || cell.getWidth() === 0) continue;
    text += cell.isDim() ? " ".repeat(cell.getWidth()) : cell.getChars() || " ";
  }
  return text.trimEnd();
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
  /**
   * The state last announced to `onState`. It follows `activity()`, except
   * that it changes when the quiet timer fires rather than the moment the
   * quiet begins.
   */
  state: Activity = "idle";
  /** Called on the next output, once. How a send learns its turn began. */
  onOutput: (() => void) | null = null;
  private tty: string | null = null;
  private sizeCheckedAt = 0;
  private sizing = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The output cursor is `base + trimmed + baseY` of the normal buffer: rows
   * dropped off the top of the scrollback, plus rows in it. `base` moves
   * whenever xterm rebuilds the rows (a resize reflows them, a reset clears
   * them) so that the cursor never goes backwards.
   */
  private base = 0;
  private trimmed = 0;
  private lines: LineList | null = null;
  private trimWatch: { dispose(): void } | null = null;
  /** The highest cursor handed out. */
  private issued = 0;

  constructor(
    private readonly sock: string,
    private readonly socket: net.Socket,
    private readonly onState: (
      from: Activity | null,
      to: Activity | null,
    ) => void = () => {},
  ) {
    this.watchTrims();
  }

  feed(data: Buffer): void {
    this.lastOutputAt = Date.now();
    this.term.write(data);
    this.setState("busy");
    const hook = this.onOutput;
    this.onOutput = null;
    hook?.();
    // Quiet is the absence of output, so it takes a timer to notice. Reset on
    // every write; firing means nothing came for QUIET_MS.
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(this.quiet, QUIET_MS + 10);
    if (Date.now() - this.sizeCheckedAt > SIZE_CHECK_MS) void this.syncSize();
  }

  private readonly quiet = (): void => {
    this.quietTimer = null;
    const now = this.activity();
    if (now === "busy" && this.lastOutputAt !== null) {
      const left = QUIET_MS - (Date.now() - this.lastOutputAt);
      this.quietTimer = setTimeout(this.quiet, Math.max(left, 0) + 10);
      return;
    }
    this.setState(now);
  };

  private setState(to: Activity): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.onState(from, to);
  }

  /**
   * Follows the normal buffer's line list, which xterm replaces on a reset.
   *
   * Its trim event is the one count of rows dropped from the top that xterm
   * keeps, and it is not in the public API, so this reaches for it. If a
   * version of xterm moves it, the cursor still works, but counts from
   * whatever the scrollback holds.
   */
  private watchTrims(): void {
    const core = (
      this.term as unknown as {
        _core?: {
          _bufferService?: { buffers?: { normal?: { lines?: LineList } } };
        };
      }
    )._core;
    const lines = core?._bufferService?.buffers?.normal?.lines ?? null;
    if (lines === this.lines) return;
    this.trimWatch?.dispose();
    this.lines = lines;
    this.trimmed = 0;
    // The rows before a reset are gone. Count on from the last cursor handed
    // out, which is as far as any caller can have got.
    this.base = this.issued;
    this.trimWatch =
      lines?.onTrim((n) => {
        this.trimmed += n;
      }) ?? null;
  }

  /** How many rows have entered the scrollback since this screen began. */
  cursor(): number {
    this.watchTrims();
    const cursor = this.base + this.trimmed + this.term.buffer.normal.baseY;
    this.issued = Math.max(this.issued, cursor);
    return cursor;
  }

  /**
   * What has scrolled into the history since `after`, and the screen now.
   *
   * The history is fixed once written, so a caller who keeps the cursor sees
   * each line once. The screen is not: a harness redraws its live region and
   * input box in place, so it comes back whole every time.
   */
  since(after: number): Since {
    const cursor = this.cursor();
    const buf = this.term.buffer.normal;
    const held = cursor - buf.baseY; // the cursor at the top of the history
    // A cursor from the future belongs to an earlier screen, from before a
    // restart or a reconnect: everything held is new to that caller.
    const fresh = after > cursor;
    const start = fresh ? 0 : Math.max(after - held, 0);
    const active = this.term.buffer.active;
    const screen = rowsText(
      active,
      active.baseY,
      active.baseY + this.term.rows,
      active.baseY + active.cursorY,
    );
    return {
      text: rowsText(buf, start, buf.baseY, -1).join("\n"),
      screen: screen.join("\n"),
      cursor,
      truncated: fresh || after < held,
    };
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
   * What is typed at the prompt and not sent yet, or "" when nothing is.
   *
   * The input line is the lowest visible line that starts with a prompt glyph,
   * the way Claude and Codex draw it. Faint text is left out, as in
   * `bufferText`, because that is a suggestion rather than something typed.
   * Null when no such line is on screen, which is not the same as empty.
   */
  draft(): string | null {
    const buf = this.term.buffer.active;
    for (let i = buf.baseY + this.term.rows - 1; i >= buf.baseY; i--) {
      const line = buf.getLine(i);
      if (!line) continue;
      const m = PROMPT_LINE.exec(withoutFaint(line));
      if (m) return m[1].trim();
    }
    return null;
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
        this.resize(size.cols, size.rows);
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

  /**
   * Resizes the terminal, keeping the cursor where it was.
   *
   * xterm reflows the history to the new width, so rows wrap and unwrap and a
   * row's index means something different afterwards. The cursor is held
   * still across it rather than allowed to jump either way.
   */
  resize(cols: number, rows: number): void {
    const before = this.cursor();
    this.term.resize(cols, rows);
    this.base += before - this.cursor();
  }

  close(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.trimWatch?.dispose();
    this.socket.destroy();
    this.term.dispose();
  }
}

/** Where a window is with its last send. Kept in memory only. */
export interface TurnState {
  lastSendAt: number;
  turn: Turn;
}

/** Every running session's screen, keyed by session name. */
export class Screens {
  private readonly open = new Map<string, Screen>();
  private readonly pending = new Map<string, Promise<Screen | undefined>>();
  private readonly listeners = new Set<(e: ScreenEvent) => void>();
  private readonly turns = new Map<string, TurnState>();
  /** Sessions known to be hibernated, so their next screen is a wake. */
  private readonly asleep = new Set<string>();
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

  /** Calls `fn` with every event until the returned function is called. */
  subscribe(fn: (e: ScreenEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** How many subscribers there are, for tests that check none leak. */
  get subscribers(): number {
    return this.listeners.size;
  }

  private emit(e: ScreenEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        log.warn(`an event listener failed: ${String(err)}`);
      }
    }
  }

  /** The window's last send and how its turn is going, if it had one. */
  turnOf(session: string): TurnState | undefined {
    return this.turns.get(session);
  }

  /**
   * Records a send that starts a turn: text that was submitted, or keys.
   *
   * `at` is when it went in. Output since then means the window is already
   * answering, which happens when it draws before this is called.
   */
  noteSend(session: string, at: number): void {
    const screen = this.open.get(session);
    this.turns.set(session, { lastSendAt: at, turn: "pending" });
    if (screen && screen.lastOutputAt !== null && screen.lastOutputAt >= at) {
      this.setTurn(session, "working");
      if (screen.state !== "busy") this.setTurn(session, "done");
      return;
    }
    this.emit({ type: "turn", session, turn: "pending", at: Date.now() });
    if (screen) screen.onOutput = () => this.setTurn(session, "working");
  }

  private setTurn(session: string, turn: Turn): void {
    const t = this.turns.get(session);
    if (!t || t.turn === turn) return;
    t.turn = turn;
    this.emit({ type: "turn", session, turn, at: Date.now() });
  }

  /** Drops what is remembered about a session whose window was closed. */
  forget(session: string): void {
    this.turns.delete(session);
    this.asleep.delete(session);
  }

  /** Records a hibernation, which `Hibernator` does. */
  noteAsleep(session: string): void {
    this.asleep.add(session);
    this.emit({ type: "asleep", session, at: Date.now() });
  }

  private changed(
    session: string,
    from: Activity | null,
    to: Activity | null,
  ): void {
    this.emit({ type: "state", session, from, to, at: Date.now() });
    if (to !== "busy" && this.turns.get(session)?.turn === "working")
      this.setTurn(session, "done");
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
    // No session, or a hibernated one. Dialling a missing socket is not only
    // pointless: Bun can raise its ENOENT synchronously, inside
    // createConnection and before any listener exists, and that took the
    // whole server down on a read of a window's output.
    if (!existsSync(sock)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let socket: net.Socket;
      try {
        socket = net.createConnection(sock);
      } catch {
        resolve(undefined);
        return;
      }
      socket.once("error", () => resolve(undefined));
      socket.once("connect", () => {
        socket.write(packet(MSG_ATTACH));
        const screen = new Screen(sock, socket, (from, to) =>
          this.changed(session, from, to),
        );
        this.open.set(session, screen);
        if (this.asleep.delete(session))
          this.emit({ type: "woke", session, at: Date.now() });
        this.changed(session, null, screen.state);
        // A send still waiting for its first output carries on in this screen.
        if (this.turns.get(session)?.turn === "pending")
          screen.onOutput = () => this.setTurn(session, "working");
        socket.on("data", (data: Buffer) => screen.feed(data));
        socket.on("error", () => {});
        socket.on("close", () => {
          screen.close();
          if (this.open.get(session) !== screen) return;
          this.open.delete(session);
          this.changed(session, screen.state, null);
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
    // Hibernated before this server started, or while it was not looking.
    const socks = new Set(names.filter((n) => n.endsWith(".sock")));
    for (const n of names) {
      const sock = n.slice(0, -".resume".length);
      if (n.endsWith(".sock.resume") && !socks.has(sock))
        this.asleep.add(sock.slice(0, -".sock".length));
    }
    await Promise.all(
      [...socks]
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
