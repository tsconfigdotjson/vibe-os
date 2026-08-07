import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseCliArgs, resolveConfig, savePersisted, type Config } from './config.ts';
import { startServer } from './index.ts';
import { SshCa, discoverHostKey } from './ssh-ca.ts';
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

function probeTcp(host: string, port: number, timeout = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

interface Check {
  label: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
}

async function doctor(config: Config): Promise<number> {
  const checks: Check[] = [];

  const bunMajor = Number((Bun.version ?? '0').split('.')[0]);
  checks.push({
    label: 'bun',
    ok: bunMajor >= 1,
    detail: bunMajor >= 1 ? `v${Bun.version}` : 'vibe-os runs on Bun 1+',
    fatal: true,
  });

  let sshKeygen = false;
  try {
    const { stdout, stderr } = await run('ssh-keygen', ['-l', '-f', '/nonexistent/vibe-os-probe']).catch((e: unknown) => {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (err.code === 'ENOENT') throw err;
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    });
    void stdout;
    void stderr;
    sshKeygen = true;
  } catch {
    sshKeygen = false;
  }
  checks.push({
    label: 'ssh-keygen',
    ok: sshKeygen,
    detail: sshKeygen ? 'found' : 'not on PATH — install openssh-client',
    fatal: true,
  });

  const sshd = await probeTcp(config.sshHost, config.sshPort);
  checks.push({
    label: 'sshd',
    ok: sshd,
    detail: sshd
      ? `reachable at ${config.sshHost}:${config.sshPort}`
      : `nothing listening on ${config.sshHost}:${config.sshPort} — windows will not connect`,
    fatal: true,
  });

  checks.push({
    label: 'tmux',
    ok: config.tmux,
    detail: config.tmux
      ? 'found — windows persist across reloads'
      : 'not installed — windows will be plain shells that die on reload (apt install tmux)',
  });

  const hostKey = await discoverHostKey(config.sshHost, config.sshPort);
  checks.push({
    label: 'host key',
    ok: hostKey !== null,
    detail: hostKey
      ? `${hostKey.split(' ')[0]} discovered — pinned, no trust prompt`
      : 'not discoverable — the browser will prompt once',
  });

  const ca = new SshCa(config.stateDir);
  let caState = 'not created yet (will be created on first start)';
  let caOk = true;
  try {
    await stat(ca.pubPath);
    await ca.ensure();
    const authorized = path.join(os.homedir(), '.ssh', 'authorized_keys');
    const contents = await readFile(authorized, 'utf8').catch(() => '');
    const blob = ca.publicKey.split(/\s+/)[1] ?? '';
    caOk = blob.length > 0 && contents.includes(blob);
    caState = caOk ? `trusted in ${authorized}` : `exists but is NOT in ${authorized}`;
  } catch {
    // never started — fine
  }
  checks.push({ label: 'ssh CA', ok: caOk, detail: caState });

  const built = await stat(path.join(config.webRoot, 'index.html')).then(
    () => true,
    () => false,
  );
  checks.push({
    label: 'web build',
    ok: built,
    detail: built ? config.webRoot : `missing at ${config.webRoot} — run bun run build`,
    fatal: true,
  });

  const wasm = await stat(path.join(config.webRoot, 'ssh.wasm')).then(
    (s) => s.size,
    () => 0,
  );
  checks.push({
    label: 'ssh.wasm',
    ok: wasm > 0,
    detail: wasm > 0 ? `${(wasm / 1024 / 1024).toFixed(1)} MB` : 'missing — will be fetched on start',
  });

  const bindable = await canBind(config.port, config.host);
  checks.push({
    label: `port ${config.port}`,
    ok: bindable,
    detail: bindable
      ? 'bindable'
      : `cannot bind as ${os.userInfo().username} — run: sudo setcap 'cap_net_bind_service=+ep' $(readlink -f "$(which bun)")`,
  });

  console.log('');
  let failed = 0;
  for (const check of checks) {
    const mark = check.ok ? color.green('✓') : check.fatal ? color.red('✗') : color.yellow('!');
    if (!check.ok && check.fatal) failed += 1;
    console.log(`  ${mark} ${color.bold(check.label.padEnd(12))} ${color.dim(check.detail)}`);
  }
  console.log('');
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
      return doctor(config);
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
