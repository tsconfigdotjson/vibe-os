// What a window actually runs when something logs in as it.
//
// This is the single source of truth for the tmux invocation behind a window,
// and it has two callers that must never disagree: the certificate signer,
// which bakes it into a `force-command` for the browser, and `vibe-os attach`,
// which runs it directly for someone arriving over SSH. Both resolve the same
// window id to the same command, so a terminal and a browser tab land in the
// same session, in the same worktree, with the same options set.
//
// It lives in its own module rather than in api.ts because attach.ts needs it
// too, and api.ts needs attach.ts — importing in a circle to share three pure
// functions is not a trade worth making.

import type { Config } from './config.ts';
import type { Profile } from './profiles.ts';

/** Single-quote for the login shell that runs a certificate's force-command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a profile window starts its pane with.
 *
 * **Quitting the harness ends the window.** tmux ends a session when its last
 * pane exits, and nothing is appended here to keep the pane alive, so leaving
 * Claude closes the window everywhere at once — the browser tile and any
 * terminal attached to the same session. That is deliberate: a window opened as
 * a role exists to run that role, and being dropped into a shell in the
 * worktree instead means every finished conversation leaves a window behind to
 * be tidied up by hand.
 *
 * It cuts both ways and the other edge is worth knowing. A harness that fails
 * to launch at all — the wrong command, or a PATH that does not reach it — also
 * exits immediately, so the window closes before anyone can read the error.
 * `vibe-os doctor` and the server log are where that shows up.
 *
 * Quoting happens at two levels and both are handled: every token is quoted
 * individually so a flag can contain spaces and cannot contain a second
 * command, and the whole string is quoted again by the caller.
 */
export function harnessCommand(profile: Profile): string | undefined {
  const executable = profile.harness === 'claude' ? 'claude' : profile.harness === 'custom' ? profile.command : null;
  if (!executable) return undefined;
  const argv = [executable, ...profile.args].map(shellQuote).join(' ');

  /*
   * The PATH a forced command gets is not the PATH you get when you log in.
   *
   * sshd runs a certificate's force-command as `$SHELL -c`, which for bash is
   * neither a login shell nor an interactive one — so `.profile` never runs,
   * and `~/.local/bin` is missing. That is exactly where Claude's native
   * installer puts its binary, and where most `curl | sh` installers put
   * theirs, so the harness fails with "command not found" while typing the
   * same name by hand in the same window works perfectly.
   *
   * Restored here rather than by asking for a login shell: `$SHELL -lc` would
   * mean another layer of quoting around an already twice-quoted string, and
   * a `.profile` is entitled to do surprising things like change directory,
   * which would undo the `-c` this window was started with.
   */
  return `export PATH="$HOME/.local/bin:$PATH"; exec ${argv}`;
}

/** Where a window's dtach socket lives. */
export function socketPath(config: Config, session: string): string {
  return `${config.stateDir}/sessions/${session}.sock`;
}

/**
 * Builds the command a window runs on login.
 *
 * The working directory is the point of the projects feature: the session
 * starts in the worktree of the workspace the window belongs to. That path is
 * looked up server-side from the window id — the browser never sends a
 * directory, so there is nothing to smuggle a path through. The same is true of
 * the profile: the window row says which one it was opened as, so the browser
 * never sends a command either.
 *
 * ── Why dtach and not tmux ───────────────────────────────────────────────────
 * A window needs exactly two things from a session manager: survive a reload,
 * and let a real terminal take over. tmux does both, and brings a full terminal
 * emulator with it — a second screen model that it keeps in sync with the
 * client by sending only the cells it believes have changed. Measured on one
 * window: 48,998 cursor hops and 2,124 erase-character sequences in a single
 * capture, in place of simply forwarding the program's output.
 *
 * That optimisation is the bug. If the client's grid and tmux's model ever
 * disagree about one cell, tmux will not send that cell again — it is certain
 * the client already has it right — so a momentary disagreement becomes
 * permanent, and text arrives with fragments of older frames wedged into it.
 * The pane itself stays perfect, which is why `capture-pane` always read
 * correctly while the browser did not, and why resizing a window cleaned it up:
 * a resize is the one thing that makes tmux throw the model away and repaint.
 *
 * dtach keeps no model. It holds the pty and moves bytes, so the program talks
 * to the browser's terminal directly and there is nothing to fall out of sync.
 * The scrollback that tmux would have kept was never worth anything here
 * anyway: a full-screen program like Claude runs on the alternate screen, where
 * nothing scrolls into history — measured `history_size=0` on every window.
 *
 * ── The shape of the command ─────────────────────────────────────────────────
 * `-n` creates the session detached and `-a` attaches to it, deliberately kept
 * as two invocations rather than one `-A`. It costs a liveness probe and buys
 * the ability to tell a client from the process that owns the pty: they differ
 * in argv, so "detach whoever is attached" is something the server can do
 * without risking the session itself.
 *
 * `-E` disables the detach character, because every key dtach reserves is a key
 * the program underneath cannot have — the same argument that ruled out
 * tmux's prefix. `-z` lets the suspend key through for the same reason. `-r
 * winch` asks the program to repaint on attach, which is how a reattached
 * window fills itself in without a screen model to replay.
 */
export function windowCommand(
  session: string,
  cwd: string,
  config: Config,
  profile?: Profile | null,
): string | undefined {
  if (!config.sessions) return undefined;

  const sock = socketPath(config, session);
  const harness = profile ? harnessCommand(profile) : undefined;
  // Falls back to the login shell, so a window with no profile is still a
  // session that survives a reload rather than a bare ssh command.
  const inner = `cd ${shellQuote(cwd)} && ${harness ?? 'exec "$SHELL"'}`;

  // `dtach -p` writes to a live socket and fails on a dead one, which makes it
  // a liveness probe. A socket left behind by a crashed session would otherwise
  // make every later attach fail with no way back except deleting it by hand.
  const probe = `dtach -p ${shellQuote(sock)} < /dev/null > /dev/null 2>&1`;
  const create = `dtach -n ${shellQuote(sock)} -E -z /bin/sh -c ${shellQuote(inner)}`;
  const attach = `exec dtach -a ${shellQuote(sock)} -E -z -r winch`;

  return [
    `mkdir -p ${shellQuote(`${config.stateDir}/sessions`)}`,
    `{ ${probe} || { rm -f ${shellQuote(sock)}; ${create}; }; }`,
    attach,
  ].join('; ');
}
