import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseCliArgs, resolveConfig, savePersisted, type Config } from './config.ts';
import { startServer } from './index.ts';
import { runDoctor, type Check } from './doctor.ts';
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
    --user <name>       unix user to log in as (default: current user)
    --no-tmux           plain login shells instead of persistent tmux sessions
    --tmux-status       show tmux's own status bar inside each window
    --no-tmux-theme     leave tmux's colours alone
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
  const home = process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : os.homedir();

  const unit = `[Unit]
Description=vibe-os — terminal multiplexer in the browser
After=network-online.target sshd.service
Wants=network-online.target

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
Environment=NODE_ENV=production
WorkingDirectory=${home}
ExecStart=${BUN} ${ENTRY} start${forwarded.length ? ` ${forwarded.join(' ')}` : ''}
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
