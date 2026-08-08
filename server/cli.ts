import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

import { parseCliArgs, resolveConfig, savePersisted, type Config } from './config.ts';
import { startServer } from './index.ts';
import { runDoctor, homeFor, type Check } from './doctor.ts';
import { IS_COMPILED } from './runtime.ts';
import { openDb } from './db.ts';
import { resolveTarget, listTargets, commandFor, liveSessions, pendingHandoff, type AttachTarget } from './attach.ts';
import { log, color } from './log.ts';
import pkg from '../package.json' with { type: 'json' };

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(PKG_ROOT, 'server', 'cli.ts');
const BUN = process.execPath;

const HELP = `
  ${color.bold('vibe-os')} — a terminal multiplexer in the browser

  ${color.bold('Usage')}
    vibe-os [start]              serve the UI and the SSH bridge
    vibe-os attach [window]      attach a real terminal to a window's session
    vibe-os doctor               check this machine is ready
    vibe-os install-service      write and enable a systemd unit (needs root)
    vibe-os fetch-wasm           (re)download the SSH WASM runtime

  ${color.bold('Options')}
    --port <n>          HTTP port (default 80)
    --host <addr>       bind address (default 0.0.0.0)
    --domain <fqdn>     provision a Let's Encrypt certificate and serve HTTPS
    --email <addr>      contact address for Let's Encrypt
    --acme-staging      use the Let's Encrypt staging environment
    --tls-port <n>      HTTPS port (default 443)

    --token [value]     require a token; generates and remembers one if omitted
    --no-token          disable the gate (default, prints a warning)

    --ssh-host <addr>   SSH target for the bridge (default 127.0.0.1)
    --ssh-port <n>      SSH target port (default 22)
    --ssh-advertise <host[:port]>
                        host to print in attach commands, when it is not the
                        one the browser reached the desktop on
    --user <name>       unix user to log in as (default: current user)
    --no-sessions       plain login shells instead of persistent dtach sessions
    --cert-ttl <secs>   certificate lifetime (default 43200)

    --workspace <dir>   root for projects and worktrees (default ~/workspace)
    --state-dir <dir>   CA and TLS material (default ~/.vibe-os)
    --web-root <dir>    built web assets

    -h, --help          show this
    -v, --version       print the version
`;

function version(): string {
  return pkg.version;
}

/**
 * Prints the check list.
 *
 * Failures carry the command that fixes them, indented underneath, because the
 * person reading this is on a fresh box and should not have to go and look it
 * up somewhere else.
 */
function printChecks(checks: Check[]): number {
  console.log('');
  let failed = 0;
  for (const check of checks) {
    const mark = check.ok ? color.green('\u2713') : check.fatal ? color.red('\u2717') : color.yellow('!');
    if (!check.ok && check.fatal) failed += 1;
    console.log(`  ${mark} ${color.bold(check.label.padEnd(14))} ${color.dim(check.detail)}`);
    if (!check.ok && check.fix) console.log(`    ${' '.repeat(14)} ${color.cyan(check.fix)}`);
  }
  console.log('');
  if (failed > 0) {
    console.log(`  ${color.red(`${failed} blocking problem${failed === 1 ? '' : 's'}.`)} vibe-os will not work until these are fixed.`);
    console.log('');
  }
  return failed > 0 ? 1 : 0;
}

const UNIT_PATH = '/etc/systemd/system/vibe-os.service';

async function installService(config: Config, argv: string[]): Promise<number> {
  if (process.getuid?.() !== 0) {
    log.error('install-service must run as root (try: sudo vibe-os install-service …)');
    return 1;
  }

  // Forward the flags used here to the unit so the service behaves identically.
  const forwarded = argv.filter((a) => a !== 'install-service');

  const user = process.env.SUDO_USER ?? config.user;
  if (!user || user === 'unknown' || user === 'root') {
    log.error(
      `refusing to install a unit that runs as ${user || 'an unknown user'} — ` +
        'windows would get a root shell, and the CA line would land in root\'s home.',
    );
    log.error('run this with sudo from your own account, or pass --user <name>.');
    return 1;
  }

  // Asked for, not built from a template: a home directory is whatever the
  // passwd entry says, and /home/<user> is only usually right.
  const home = await homeFor(user);
  if (!home) {
    log.error(`could not resolve a home directory for ${user}`);
    return 1;
  }

  /**
   * A compiled binary is its own entry point.
   *
   * `process.execPath` plus the source path is right from a checkout and wrong
   * everywhere else: inside a standalone executable the source lives at a
   * virtual `/$bunfs/` path that exists only while the process is running. The
   * generated unit would pass that path as the subcommand and fail on every
   * boot — on precisely the install the VPS instructions recommend.
   */
  const command = IS_COMPILED ? process.execPath : `${BUN} ${ENTRY}`;

  const unit = `[Unit]
Description=vibe-os — terminal multiplexer in the browser
After=network-online.target sshd.service
Wants=network-online.target

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
# systemd hands a service a minimal PATH, which omits the ~/.local/bin that the
# Claude installer — and most "curl | sh" installers — write to. A login shell
# gets it from .profile, so without this the harness a window launches resolves
# and the server's own lookup of the same binary does not.
Environment=PATH=${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NODE_ENV=production
WorkingDirectory=${home}
ExecStart=${command} start${forwarded.length ? ` ${forwarded.join(' ')}` : ''}
Restart=on-failure
RestartSec=2
# Lets an unprivileged user bind port 80 without setcap on the node binary.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
`;

  await writeFile(UNIT_PATH, unit, { mode: 0o644 });
  log.ok(`wrote ${UNIT_PATH}`);

  await run('systemctl', ['daemon-reload']);
  await run('systemctl', ['enable', '--now', 'vibe-os']);
  log.ok('enabled and started vibe-os.service');
  console.log('');
  console.log(`  logs:    ${color.cyan('journalctl -u vibe-os -f')}`);
  console.log(`  restart: ${color.cyan('systemctl restart vibe-os')}`);
  console.log('');
  return 0;
}

/**
 * Lets someone pick a window when they did not name one.
 *
 * The reason this exists: on your own laptop you do not have a window id or a
 * ref, you have "the thing I was doing yesterday". `ssh -t box vibe-os attach`
 * with nothing after it is the command worth remembering, and this is what
 * makes it answerable.
 *
 * Returns undefined when the person backs out, which must not be confused with
 * a failure — quitting the picker is a perfectly good outcome.
 */
async function pickTarget(config: Config, targets: AttachTarget[]): Promise<AttachTarget | undefined> {
  const live = await liveSessions(config);
  console.log('');
  console.log(`  ${color.bold(color.cyan('vibe-os'))} ${color.dim(`· ${targets.length} window${targets.length === 1 ? '' : 's'}`)}`);
  console.log('');
  targets.forEach((t, i) => {
    const n = color.bold(String(i + 1).padStart(3));
    const state = live.has(t.session) ? color.green('live') : color.dim('idle');
    const role = t.role ?? color.dim('terminal');
    console.log(`  ${n}  ${state}  ${t.ref.padEnd(28)} ${role.padEnd(22)} ${color.dim(`${t.project}/${t.workspace}`)}`);
  });
  console.log('');

  // Closed before anything is spawned: dtach needs the terminal in raw mode and
  // readline holds it in canonical mode until it lets go.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  attach [1-${targets.length}, q to quit]: `);
  rl.close();

  const choice = Number(answer.trim());
  if (!Number.isInteger(choice) || choice < 1 || choice > targets.length) return undefined;
  return targets[choice - 1];
}

/**
 * Attaches this terminal to a window's session.
 *
 * The command comes from session.ts, which is the same place the certificate
 * signer gets it — so arriving over ssh puts you in the same session, in the
 * same worktree, running the same harness as the browser would. Composing a
 * dtach invocation here instead would be one line shorter and would drift away
 * from the browser's the first time either changed.
 */
async function attach(config: Config, ref: string | undefined): Promise<number> {
  if (!config.sessions) {
    log.error('attach needs dtach — this server runs plain login shells (--no-sessions)');
    return 1;
  }

  const db = openDb(config.stateDir);
  const targets = listTargets(db);
  if (targets.length === 0) {
    log.error(`no windows in ${config.stateDir}`);
    // Almost always the cause: sshd logged you in as someone else, so the
    // state directory resolved to a different home and vibe-os made an empty
    // database there rather than reading the one with the windows in it.
    log.error(`open the desktop and make one, or check you are logged in as the user vibe-os runs as`);
    return 1;
  }

  // With no argument, prefer the window the desktop just handed over: the
  // ssh:// link cannot name one, so this is what closes that gap.
  const target = ref ? resolveTarget(db, ref) : (pendingHandoff(db) ?? (await pickTarget(config, targets)));
  if (ref && !target) {
    log.error(`no window called ${ref}`);
    console.log('');
    for (const t of targets) console.log(`    ${t.ref}`);
    console.log('');
    return 1;
  }
  if (!target) return 0;

  const command = commandFor(db, config, target);
  if (!command) {
    log.error(`could not build a command for ${target.ref}`);
    return 1;
  }

  /*
   * Run through a shell, because that is what the string is written for.
   *
   * It is the same string sshd hands to `$SHELL -c` as a forced command, `\;`
   * separators and two layers of quoting included. Handing it to a shell here
   * is what makes the two paths identical rather than merely similar.
   *
   * spawnSync rather than a detached child: dtach needs this terminal, and the
   * exit code needs to be ours. There is no exec() to replace the process with
   * in a Bun binary, so this one stays resident and idle for the session.
   */
  const child = spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });
  if (child.error) {
    log.error(`could not start the session: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    console.log(HELP);
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0] ?? 'start';

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(version());
    return 0;
  }

  const config = await resolveConfig(values);

  switch (command) {
    case 'start': {
      // A generated token is only useful if it survives a restart.
      if (config.token) await savePersisted(config.stateDir, { token: config.token });
      await startServer(config);
      return -1; // keep running
    }
    case 'attach':
      return attach(config, positionals[1]);
    case 'doctor':
      return printChecks(await runDoctor(config));
    case 'install-service':
      return installService(config, argv);
    case 'fetch-wasm': {
      const script = path.join(PKG_ROOT, 'scripts', 'fetch-wasm.mjs');
      await run(process.execPath, [script], { maxBuffer: 1024 * 1024 }).then(({ stdout }) => process.stdout.write(stdout));
      return 0;
    }
    case 'help':
      console.log(HELP);
      return 0;
    default:
      log.error(`unknown command: ${command}`);
      console.log(HELP);
      return 1;
  }
}
