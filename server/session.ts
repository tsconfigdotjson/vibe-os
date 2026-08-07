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

/**
 * Builds the command a window runs on login.
 *
 * `-c` is the point of the projects feature: the session starts in the worktree
 * of the workspace the window belongs to. That path is looked up server-side
 * from the window id — the browser never sends a directory, so there is nothing
 * to smuggle a path through. The same is true of the profile: the window row
 * says which one it was opened as, so the browser never sends a command either.
 *
 * `new-session -A` attaches if the session exists and creates it otherwise, so
 * a window reattaches to exactly what it was running before a reload. That also
 * makes the harness safe to pass here: tmux ignores a shell-command when it
 * attaches, so a reload rejoins the running Claude rather than starting a
 * second one on top of it.
 */
export function windowCommand(
  session: string,
  cwd: string,
  config: Config,
  profile?: Profile | null,
): string | undefined {
  if (!config.tmux) return undefined;
  const harness = profile ? harnessCommand(profile) : undefined;
  const parts = [
    `tmux -u new-session -A -s ${shellQuote(session)} -c ${shellQuote(cwd)}` +
      (harness ? ` ${shellQuote(harness)}` : ''),
  ];

  // Session options, never global (`set -g`): a vibe-os window must not restyle
  // tmux sessions the user started themselves on the same server.
  const cmds: string[] = [];

  /*
   * Let a program inside the pane put something on the browser's clipboard.
   *
   * When Claude copies, it emits OSC 52. tmux's default is `external`, which
   * despite the name means it will set the outer clipboard from its *own* copy
   * mode but ignores the same sequence coming from an application — so a copy
   * inside Claude goes nowhere. `on` accepts it and passes it out to the
   * terminal, where the browser side turns it into a real clipboard write.
   *
   * Measured rather than assumed: with `external` the sequence never reaches
   * xterm at all; with `on` it arrives.
   */
  cmds.push('set set-clipboard on');

  /*
   * Deliberately *not* setting `window-size latest` here.
   *
   * It is the obvious fix for two clients of different sizes dragging a session
   * down to the smaller of them, and it is the wrong layer to fix it at: a
   * window is meant to have exactly one client, and both ways of popping one
   * out unmount the desktop's terminal to keep that true. Adding the option
   * would paper over a broken handoff rather than surface it, and it only
   * exists in tmux 2.9 and later — an unknown option here would take the whole
   * chained command with it, which means failing to open a window at all on an
   * older box in exchange for a case that should not arise.
   */

  if (!config.tmuxStatus) {
    // The window's own title bar already carries the session name and state.
    cmds.push('set status off');
  }
  if (config.tmuxTheme) {
    if (config.tmuxStatus) {
      cmds.push(
        'set status-style "bg=#10141c fg=#9aa3b6"',
        'set status-left-style "fg=#56cfe1 bold"',
        'set window-status-current-style "fg=#dfe5f0 bold"',
        'set status-right "#[fg=#667085]#H"',
      );
    }
    cmds.push('set pane-border-style "fg=#1b2230"', 'set pane-active-border-style "fg=#56cfe1"');
  }
  return [...parts, ...cmds].join(' \\; ');
}
