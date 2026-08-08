// Popping a terminal out to a real terminal.
//
// A window is a dtach session, and dtach does not care who attaches to it. The
// browser reaches it through the WASM/bridge/sshd path; someone on the tailnet
// can reach the same session with plain `ssh`, and land in exactly the same
// worktree running exactly the same thing — because both ask session.ts for the
// command rather than composing one of their own.
//
// The only rule that has to survive is the one the pop-out already enforces:
// **one client per session**. dtach lets several attach at once and sizes the
// pty to whoever most recently arrived, so a desktop window and a full-screen
// terminal attached together would fight over the size. The browser pop-out
// solves that by unmounting the desktop's terminal and gossiping over a
// BroadcastChannel. An SSH client cannot join that conversation, so the handoff
// is recorded on the window row instead — durable across a reload, and undone
// by killing the attached client, which is the server-side equivalent of
// closing the pop-out window.
//
// Killing "the client" is safe because of how session.ts starts things: the
// process that owns the pty is `dtach -n <socket> …` and every attachment is
// `dtach -a <socket>`. They differ in argv, so the two are never confused.

import { execFile } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, desc } from 'drizzle-orm';

import { type Db, windows, workspaces, projects, profiles } from './db.ts';
import type { Config } from './config.ts';
import { getProfile } from './profiles.ts';
import { windowCommand, shellQuote, socketPath } from './session.ts';
import { IS_COMPILED } from './runtime.ts';
import { log } from './log.ts';

const run = promisify(execFile);

/**
 * How long a handoff nobody ever used is left alone.
 *
 * This only applies before the first client shows up. A handoff is made the
 * moment you pick "SSH session", which is necessarily *before* you have pasted
 * the command anywhere — so for a while the row says the terminal is out there
 * and nobody is attached yet. Reaping on that would take the window back
 * while the command is still on the clipboard, and then the terminal you
 * eventually paste into becomes a second client, which is the one thing the
 * handoff exists to prevent.
 *
 * Generous, because the case it guards is "I got distracted", and because it
 * costs nothing: once a client has attached, `handoffSeen` takes over and its
 * departure is reaped straight away rather than waiting this out.
 */
const HANDOFF_GRACE_MS = 15 * 60_000;

/** A ref is `<workspace>-<index>`; the `vibe-` session prefix is optional. */
const REF = /^(?:vibe-)?([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/;
const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AttachTarget {
  windowId: string;
  /** What a person types: `quiet-amber-otter-1`. */
  ref: string;
  session: string;
  cwd: string;
  profileId: string | null;
  workspace: string;
  project: string;
  /** The role the window was opened as, when it has one. */
  role: string | null;
}

export interface SshEndpoint {
  user: string;
  host: string;
  port: number;
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * Turns a ref or a window id into everything needed to attach.
 *
 * Both spellings are accepted because they serve different callers: the UI has
 * an opaque window id in hand, and a person at a shell prompt has the label off
 * the title bar. A ref is matched against the workspace name and window index
 * that produce the session name, so what you type is what the socket is called.
 */
export function resolveTarget(db: Db, refOrId: string): AttachTarget | undefined {
  const rows = db
    .select({
      windowId: windows.id,
      idx: windows.idx,
      profileId: windows.profileId,
      workspace: workspaces.name,
      cwd: workspaces.path,
      lastOpenedAt: workspaces.lastOpenedAt,
      project: projects.name,
      role: profiles.name,
    })
    .from(windows)
    .innerJoin(workspaces, eq(windows.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .leftJoin(profiles, eq(windows.profileId, profiles.id));

  /*
   * The id is tried first, and both are tried — the obvious shape, matching on
   * whichever pattern the input looks like, is wrong.
   *
   * Window ids are UUIDs, and the last group of a UUID is twelve hex digits
   * that are sometimes all decimal: `…-a716-446655440001` is a perfectly
   * ordinary id that also parses as the ref "workspace …-a716, window
   * 446655440001". Choosing by shape would send that id down the ref path,
   * find nothing, and give up — an intermittent failure in the API, which
   * passes ids, on roughly one window in two hundred.
   */
  const trimmed = refOrId.trim();
  const match = REF.exec(trimmed);
  const found =
    (WINDOW_ID.test(trimmed) ? rows.where(eq(windows.id, trimmed)).all()[0] : undefined) ??
    (match
      ? rows
          .where(and(eq(workspaces.name, match[1]), eq(windows.idx, Number(match[2]))))
          // Workspace names are three random words, so a collision across two
          // projects is vanishingly unlikely rather than impossible. Preferring
          // the one you touched most recently beats picking by row order.
          .orderBy(desc(workspaces.lastOpenedAt))
          .all()[0]
      : undefined);

  if (!found) return undefined;
  return {
    windowId: found.windowId,
    ref: `${found.workspace}-${found.idx}`,
    session: `vibe-${found.workspace}-${found.idx}`,
    cwd: found.cwd,
    profileId: found.profileId,
    workspace: found.workspace,
    project: found.project,
    role: found.role,
  };
}

/** Every window that could be attached to, newest workspace first. */
export function listTargets(db: Db): AttachTarget[] {
  return db
    .select({
      windowId: windows.id,
      idx: windows.idx,
      profileId: windows.profileId,
      workspace: workspaces.name,
      cwd: workspaces.path,
      project: projects.name,
      role: profiles.name,
    })
    .from(windows)
    .innerJoin(workspaces, eq(windows.workspaceId, workspaces.id))
    .innerJoin(projects, eq(workspaces.projectId, projects.id))
    .leftJoin(profiles, eq(windows.profileId, profiles.id))
    .orderBy(desc(workspaces.lastOpenedAt), windows.idx)
    .all()
    .map((r) => ({
      windowId: r.windowId,
      ref: `${r.workspace}-${r.idx}`,
      session: `vibe-${r.workspace}-${r.idx}`,
      cwd: r.cwd,
      profileId: r.profileId,
      workspace: r.workspace,
      project: r.project,
      role: r.role,
    }));
}

/** The session command for a target — the same one the certificate forces. */
export function commandFor(db: Db, config: Config, target: AttachTarget): string | undefined {
  const profile = target.profileId ? getProfile(db, target.profileId) : undefined;
  return windowCommand(target.session, target.cwd, config, profile);
}

// ── talking to dtach ─────────────────────────────────────────────────────────

/** Sessions with something still holding the other end of their socket. */
export async function liveSessions(config: Config): Promise<Set<string>> {
  try {
    const dir = `${config.stateDir}/sessions`;
    const names = await readdir(dir);
    const live = new Set<string>();
    await Promise.all(
      names
        .filter((n) => n.endsWith('.sock'))
        .map(async (n) => {
          // Writing nothing to the socket succeeds only if something is still
          // holding the other end, which is what separates a live session from
          // a socket a crashed one left behind.
          const ok = await run('dtach', ['-p', `${dir}/${n}`], { timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          if (ok) live.add(n.replace(/\.sock$/, ''));
        }),
    );
    return live;
  } catch {
    // No sessions directory yet: nothing has ever been opened.
    return new Set();
  }
}

/**
 * Processes currently attached to a session.
 *
 * A client is `dtach -a <socket>`; the process that owns the pty is
 * `dtach -n <socket> …`. They differ in argv precisely so this can tell them
 * apart — matching too loosely here would mean "detach the clients" killing the
 * session along with them.
 */
export async function clientsOn(config: Config, session: string): Promise<string[]> {
  const sock = socketPath(config, session);
  try {
    const { stdout } = await run('pgrep', ['-f', `^dtach -a ${sock}`], { timeout: 10_000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // pgrep exits non-zero when nothing matches.
    return [];
  }
}

/**
 * Kicks every client off a session, leaving the session itself running.
 *
 * This is what "Bring it back" does to a terminal, and the exact counterpart of
 * closing a browser pop-out: the attached dtach exits, the forced command it
 * was running returns, and the ssh session ends. What was running is untouched
 * — the process that owns the pty is a different process and is left alone.
 */
export async function detachClients(config: Config, session: string): Promise<void> {
  const pids = await clientsOn(config, session);
  for (const pid of pids) {
    await run('kill', [pid], { timeout: 10_000 }).catch(() => {
      // Already gone between listing and killing; that is the desired state.
    });
  }
}

/** Ends a session outright: the program exits and the socket is removed. */
export async function killSession(config: Config, session: string): Promise<void> {
  const sock = socketPath(config, session);
  await run('pkill', ['-f', `^dtach -n ${sock}`], { timeout: 10_000 }).catch(() => {});
  await rm(sock, { force: true }).catch(() => {});
}

// ── where to point ssh ───────────────────────────────────────────────────────

/**
 * The endpoint to print in an ssh command.
 *
 * `config.sshHost` is the wrong answer and the tempting one: it is where the
 * *bridge* dials, which is `127.0.0.1` in every recommended deployment. So is
 * `os.hostname()`, which on a VPS is something like `ubuntu-2gb-fsn1` and
 * resolves nowhere.
 *
 * The right answer is the host the browser is already talking to. If you
 * reached the desktop at `vibe-os.tail76dd79.ts.net`, ssh to that name works —
 * it is the same machine, and on a tailnet it is the same name sshd answers on.
 * `--ssh-advertise` overrides it for the case where the two genuinely differ,
 * such as a reverse proxy in front of the web port.
 */
/**
 * The origin a person could actually type, as opposed to the one we were dialled on.
 *
 * Behind `tailscale serve` — the recommended deployment — the connection that
 * reaches this process is plain HTTP to `127.0.0.1:7681`, so `url.origin` says
 * `http://…` for a site that is only served over HTTPS. The forwarded headers
 * carry the truth: measured on the box, serve sends `X-Forwarded-Proto: https`
 * and `X-Forwarded-Host` alongside a `Host` it leaves intact.
 *
 * Trusting a client-supplied header is fine here and only here: the result is
 * a string echoed back to the caller who sent it. Someone forging these is
 * writing their own copy of a command they already have.
 */
export function publicOrigin(req: Request, url: URL): string {
  const first = (name: string) => req.headers.get(name)?.split(',')[0].trim();
  const proto = first('x-forwarded-proto') || url.protocol.replace(':', '');
  return `${proto}://${publicHost(req, url)}`;
}

/** The host a person would type, from the same forwarded headers. */
export function publicHost(req: Request, url: URL): string {
  const first = (name: string) => req.headers.get(name)?.split(',')[0].trim();
  return first('x-forwarded-host') || first('host') || url.host;
}

export function sshEndpoint(config: Config, requestHost: string): SshEndpoint {
  const advertised = config.sshAdvertise?.trim();
  if (advertised) {
    const [host, port] = advertised.split(':');
    return { user: config.user, host, port: port ? Number(port) : 22 };
  }
  // Strips the web port, which is rarely 22 and never relevant to ssh.
  return { user: config.user, host: requestHost.replace(/:\d+$/, ''), port: 22 };
}

/**
 * How to spell "run vibe-os" on the far side of an ssh command.
 *
 * `ssh host <command>` runs it through `$SHELL -c`, which is neither a login
 * shell nor an interactive one, so the PATH is sshd's default rather than the
 * one `.profile` builds. A binary in `/usr/local/bin` — where the install
 * instructions put it — is on that PATH and can be named bare. Anywhere else,
 * and `~/.local/bin` in particular, has to be spelled out in full or the
 * command fails with "not found" for someone who can run it fine by hand.
 */
export function invocation(): string {
  const DEFAULT_PATH = new Set(['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']);
  if (!IS_COMPILED) {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');
    return `${process.execPath} ${entry}`;
  }
  const exe = process.execPath;
  return DEFAULT_PATH.has(path.dirname(exe)) ? path.basename(exe) : exe;
}

export interface AttachForm {
  key: 'command' | 'url';
  /** What this one is, in a few words. The UI puts it above the command. */
  hint: string;
  command: string;
}

export interface AttachInfo {
  ref: string;
  session: string;
  cwd: string;
  workspace: string;
  project: string;
  role: string | null;
  endpoint: SshEndpoint;
  /** Ways to reach this window, best first. See `attachForms`. */
  forms: AttachForm[];
  /**
   * The whole ssh-and-dtach command, depending on nothing on the far side.
   *
   * Not offered as a way to attach — it is far too long for anyone to want —
   * but it is what `/t/<ref>` executes, so it lives here with the rest.
   */
  raw: string;
}

/** `ssh -t [-p n] user@host …`, with the tail supplied by the caller. */
function sshPrefix(endpoint: SshEndpoint): string {
  const port = endpoint.port === 22 ? '' : ` -p ${endpoint.port}`;
  return `ssh -t${port} ${endpoint.user}@${endpoint.host}`;
}

/**
 * The two ways to reach a window, in the order they deserve to be offered.
 *
 * The URL's whole appeal is being short enough to type from memory once you
 * know a window's name — and a token gate takes that away, because the token
 * has to ride along in the query string for `curl` to get past the gate. What
 * is left is a hundred characters of opaque string that also puts the token in
 * your shell history, which is worse in every respect than the ssh command
 * sitting next to it.
 *
 * So the order flips with the gate. Ungated, the URL is the nicer answer and
 * goes first. Gated, ssh does.
 *
 * The ssh form has no such caveat: `invocation()` spells out an absolute path
 * whenever the binary is not somewhere sshd's PATH would find it, so it
 * resolves either way.
 */
export function attachForms(ssh: string, url: string, gated: boolean): AttachForm[] {
  const forms: AttachForm[] = [
    { key: 'command', hint: 'ssh, straight to the session', command: ssh },
    { key: 'url', hint: 'a URL the server resolves for you', command: url },
  ];
  return gated ? forms : forms.reverse();
}

/** Everything the UI needs to offer an SSH handoff. */
export function attachInfo(
  db: Db,
  config: Config,
  refOrId: string,
  origin: string,
  requestHost: string,
): AttachInfo | undefined {
  const target = resolveTarget(db, refOrId);
  if (!target) return undefined;
  const command = commandFor(db, config, target);
  if (!command) return undefined;

  const endpoint = sshEndpoint(config, requestHost);

  // The token rides in the URL when the gate is on, because the thing fetching
  // it is curl, which has no cookie and no session to establish. See
  // Gate.checkAllowingParam — this is the one route that accepts it that way.
  const query = config.token ? `?token=${encodeURIComponent(config.token)}` : '';

  return {
    ref: target.ref,
    session: target.session,
    cwd: target.cwd,
    workspace: target.workspace,
    project: target.project,
    role: target.role,
    endpoint,
    forms: attachForms(
      `${sshPrefix(endpoint)} ${invocation()} attach ${target.ref}`,
      `sh -c "$(curl -sSL '${origin}/t/${target.ref}${query}')"`,
      config.token !== null,
    ),
    raw: `${sshPrefix(endpoint)} -- ${shellQuote(command)}`,
  };
}

/**
 * The script behind `/t/<ref>`.
 *
 * Written to be read before it is run: `curl <url>` on its own shows you a
 * commented three-line file, and the `sh -c "$(…)"` form runs exactly what you
 * just looked at. That form matters — `curl … | sh` makes the script's stdin
 * the pipe, so the `ssh -t` inside it has no terminal to attach to and dtach
 * fails on arrival.
 */
export function attachScript(info: AttachInfo): string {
  const where = info.role ? `${info.role} in ${info.project}/${info.workspace}` : `${info.project}/${info.workspace}`;
  return [
    '#!/bin/sh',
    `# vibe-os — attach to ${info.ref} (${where})`,
    '#',
    '# Run it with:  sh -c "$(curl -sSL <this-url>)"',
    '# Not with a pipe: `curl … | sh` leaves ssh without a terminal.',
    '',
    `exec ${info.raw}`,
    '',
  ].join('\n');
}

// ── the handoff ──────────────────────────────────────────────────────────────

export type Handoff = 'ssh' | null;

/**
 * Records that a window's terminal has been handed to an ssh client — or taken
 * back, which also kicks whoever is attached.
 *
 * Persisted rather than kept in the desktop's memory because the whole point is
 * that you close the laptop and the terminal keeps running. The browser
 * pop-out can gossip over a BroadcastChannel because both ends are documents on
 * one origin; an ssh client has no such channel, so the row is the record.
 */
export async function setHandoff(db: Db, config: Config, windowId: string, mode: Handoff): Promise<boolean> {
  const target = resolveTarget(db, windowId);
  if (!target) return false;

  if (config.sessions) {
    /*
     * Both directions detach every client, and the reason differs.
     *
     * Taking it back is the obvious one: the terminal has to let go, and this
     * is the server-side equivalent of closing a browser pop-out. It happens
     * before the flag is cleared, so a failure leaves the row saying the
     * terminal is still out there, which is the honest state.
     *
     * Handing it out is the subtle one. The desktop that asked has already
     * unmounted its terminal — but any *other* desktop showing this workspace
     * has not heard yet, and until it polls it is still a client. The
     * terminal would then arrive as a second one and the session would shrink
     * to whichever is smaller. Broadcasting to sibling tabs closes that for one
     * browser; only the server can close it for another machine, and it closes
     * it here to zero rather than to a poll interval. Nothing is lost: a client
     * detaching is not a session ending, and the browsers reconnect or show the
     * handoff as soon as they catch up.
     */
    await detachClients(config, target.session);
    log.info(mode === 'ssh' ? `handed ${target.session} to a terminal` : `reclaimed ${target.session} from its terminal`);
  }

  db.update(windows)
    .set({ handoff: mode, handoffAt: mode ? Date.now() : null, handoffSeen: 0 })
    .where(eq(windows.id, windowId))
    .run();
  return true;
}

/**
 * Clears handoffs whose terminal has gone away.
 *
 * Without this a window stays a placeholder forever after you close the ssh
 * session — the desktop would be waiting for a client that will never come
 * back, and the only way out is a button you would have to know to press. With
 * it, closing the terminal hands the window back on the next poll.
 *
 * The two cases are deliberately not treated the same, because "nobody has
 * attached yet" and "the terminal that was attached has gone" look identical
 * in `list-clients` and mean opposite things. Once a client has been seen the
 * session is known to have been claimed, so its disappearance is real and gets
 * reaped at once; before that, an empty list is just someone still finding
 * their terminal window, and only the grace period settles it.
 *
 * Runs on the window list, which the desktop polls while anything is out, and
 * only ever does session work for windows that are actually handed off.
 */
export async function reapStaleHandoffs(db: Db, config: Config): Promise<void> {
  if (!config.sessions) return;
  const outstanding = db.select().from(windows).where(eq(windows.handoff, 'ssh')).all();
  if (outstanding.length === 0) return;

  const now = Date.now();
  for (const row of outstanding) {
    const target = resolveTarget(db, row.id);
    if (!target) continue;

    if ((await clientsOn(config, target.session)).length > 0) {
      // First sighting. From here on, an empty client list means it left.
      if (!row.handoffSeen) {
        db.update(windows).set({ handoffSeen: 1 }).where(eq(windows.id, row.id)).run();
        log.debug(`${target.session} picked up by a terminal`);
      }
      continue;
    }

    if (!row.handoffSeen && now - (row.handoffAt ?? 0) < HANDOFF_GRACE_MS) continue;

    db.update(windows).set({ handoff: null, handoffAt: null, handoffSeen: 0 }).where(eq(windows.id, row.id)).run();
    log.info(
      row.handoffSeen
        ? `${target.session} was left by its terminal — handing it back to the desktop`
        : `${target.session} was never picked up — handing it back to the desktop`,
    );
  }
}
