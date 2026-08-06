// vibe-os is its own short-lived SSH certificate authority.
//
// The browser generates an ed25519 keypair inside the WASM sandbox and keeps
// the private half in IndexedDB — it never leaves the tab. It POSTs only the
// public half here, and gets back a certificate signed by this CA, valid for a
// few hours. The VPS trusts exactly one line in ~/.ssh/authorized_keys:
//
//     cert-authority ssh-ed25519 AAAA... vibe-os-ca
//
// That is the whole enrollment story: no key to copy and paste, no private key
// on the wire, no sshd_config edit, and no root. Revoking access to every
// browser that ever connected is deleting that one line.
//
// Certificates also carry a per-pane `force-command` critical option, which is
// how each pane lands in its own persistent tmux session (see certificate.ts's
// caller). sshd allocates the PTY because the client asks for a shell, then
// runs the forced command inside it — so resize and job control behave.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, writeFile, appendFile, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { log } from './log.js';

const run = promisify(execFile);

/** Public key types we are willing to sign. Certificates are rejected. */
const SIGNABLE_KEY_TYPE =
  /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

const MAX_PUBKEY_BYTES = 8 * 1024;

export interface SignOptions {
  /** Public key in authorized_keys form, as posted by the browser. */
  publicKey: string;
  /** Unix user the certificate is valid for. */
  principal: string;
  /** Human-readable identity; sshd logs this on every login. */
  identity: string;
  /** Optional forced command, e.g. `tmux new-session -A -s vibe-1`. */
  forceCommand?: string;
  /** Certificate lifetime in seconds. */
  ttlSeconds: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirms ssh-keygen is on PATH.
 *
 * The probe has to be side-effect free: several of ssh-keygen's flags generate
 * key material as a side effect (`-A` writes host keys), so this asks it to
 * fingerprint a path that cannot exist. That always exits non-zero — the only
 * outcome we care about is whether the binary was found at all.
 */
export async function requireSshKeygen(): Promise<void> {
  try {
    await run('ssh-keygen', ['-l', '-f', '/nonexistent/vibe-os-probe'], { timeout: 5_000 });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('ssh-keygen was not found on PATH — install openssh-client');
    }
  }
}

export class SshCa {
  readonly keyPath: string;
  readonly pubPath: string;
  private publicKeyLine = '';
  private serialCounter = 0n;

  constructor(stateDir: string) {
    this.keyPath = path.join(stateDir, 'ca');
    this.pubPath = path.join(stateDir, 'ca.pub');
  }

  /** The CA's public key in authorized_keys form, without the trailing newline. */
  get publicKey(): string {
    if (!this.publicKeyLine) throw new Error('CA not initialised — call ensure() first');
    return this.publicKeyLine;
  }

  get fingerprintPromise(): Promise<string> {
    return run('ssh-keygen', ['-l', '-f', this.pubPath])
      .then(({ stdout }) => stdout.trim())
      .catch(() => 'unknown');
  }

  /** Creates the CA keypair if it does not exist yet. Idempotent. */
  async ensure(): Promise<void> {
    await mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.keyPath), 0o700).catch(() => {});

    if (!(await exists(this.keyPath))) {
      // ssh-keygen refuses to overwrite without prompting, so a stale .pub with
      // no private half has to go first.
      await rm(this.pubPath, { force: true });
      await run('ssh-keygen', [
        '-q',
        '-t', 'ed25519',
        '-f', this.keyPath,
        '-N', '',
        '-C', `vibe-os-ca@${os.hostname()}`,
      ]);
      await chmod(this.keyPath, 0o600).catch(() => {});
      log.ok(`generated SSH certificate authority at ${this.keyPath}`);
    }

    this.publicKeyLine = (await readFile(this.pubPath, 'utf8')).trim();
    if (!this.publicKeyLine) throw new Error(`${this.pubPath} is empty`);
  }

  /**
   * Adds the `cert-authority` line to authorized_keys so sshd will accept any
   * certificate this CA signs. Idempotent — matches on the key blob, so a
   * hand-edited comment or extra options on the line are left alone.
   */
  async trustInAuthorizedKeys(homeDir: string): Promise<'added' | 'present'> {
    const sshDir = path.join(homeDir, '.ssh');
    const file = path.join(sshDir, 'authorized_keys');

    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    await chmod(sshDir, 0o700).catch(() => {});

    const blob = this.publicKey.split(/\s+/)[1];
    if (!blob) throw new Error('malformed CA public key');

    let current = '';
    if (await exists(file)) current = await readFile(file, 'utf8');
    if (current.includes(blob)) return 'present';

    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    await appendFile(
      file,
      `${prefix}# added by vibe-os — trusts browser-held keys certified by this host\ncert-authority ${this.publicKey}\n`,
      { mode: 0o600 },
    );
    await chmod(file, 0o600).catch(() => {});
    return 'added';
  }

  /**
   * Signs a browser-supplied public key.
   *
   * Everything reaching ssh-keygen goes through an argv array, never a shell,
   * so a hostile `forceCommand` or public key cannot break out into command
   * execution. The key itself is still validated because ssh-keygen will
   * happily sign anything shaped like a key, and we do not want to mint
   * certificates from certificates.
   */
  async signUserCert(opts: SignOptions): Promise<string> {
    const publicKey = normalisePublicKey(opts.publicKey);

    const tmp = path.join(os.tmpdir(), `vibe-os-sign-${process.pid}-${this.nextSerial()}`);
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    const keyFile = path.join(tmp, 'id.pub');
    const certFile = path.join(tmp, 'id-cert.pub');

    try {
      await writeFile(keyFile, `${publicKey}\n`, { mode: 0o600 });

      const args = [
        '-q',
        '-s', this.keyPath,
        '-I', opts.identity,
        '-n', opts.principal,
        // A little slack on the lower bound: the browser's clock is not ours.
        '-V', `-5m:+${Math.max(1, Math.round(opts.ttlSeconds / 60))}m`,
        '-z', String(this.nextSerial()),
      ];
      if (opts.forceCommand) args.push('-O', `force-command=${opts.forceCommand}`);
      args.push(keyFile);

      await run('ssh-keygen', args, { timeout: 15_000 });
      const cert = await readFile(certFile, 'utf8');
      if (!cert.includes('-cert-v01@openssh.com')) {
        throw new Error('ssh-keygen did not produce a certificate');
      }
      return cert;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private nextSerial(): bigint {
    this.serialCounter += 1n;
    return BigInt(Date.now()) * 1000n + (this.serialCounter % 1000n);
  }
}

/** Validates and trims a public key posted by the browser. Throws on anything suspect. */
export function normalisePublicKey(raw: string): string {
  if (raw.length > MAX_PUBKEY_BYTES) throw new Error('public key too large');

  const line = raw.trim();
  if (line.includes('\n') || line.includes('\r')) throw new Error('public key must be a single line');

  const [type, blob] = line.split(/\s+/, 2);
  if (!type || !blob) throw new Error('malformed public key');
  if (type.includes('-cert-v01@openssh.com')) throw new Error('refusing to certify a certificate');
  if (!SIGNABLE_KEY_TYPE.test(type)) throw new Error(`unsupported key type: ${type}`);
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(blob)) throw new Error('malformed public key body');

  // The base64 blob must decode to a key whose embedded type matches the
  // declared one — otherwise a caller could mislabel a key to slip past the
  // type check above.
  const decoded = Buffer.from(blob, 'base64');
  if (decoded.length < 4) throw new Error('malformed public key body');
  const nameLength = decoded.readUInt32BE(0);
  if (nameLength > 64 || decoded.length < 4 + nameLength) throw new Error('malformed public key body');
  const embedded = decoded.subarray(4, 4 + nameLength).toString('ascii');
  if (embedded !== type) throw new Error('public key type does not match its body');

  // Re-emit without any client-supplied comment.
  return `${type} ${blob}`;
}

/**
 * Finds this host's SSH host key so the browser can pin it and skip the
 * trust-on-first-use prompt.
 *
 * The order matters: it mirrors the order golang.org/x/crypto/ssh offers host
 * key algorithms, so the key we pin is the one sshd will actually present.
 * If none is readable we return null and the browser falls back to prompting.
 */
/**
 * OpenSSH-style SHA256 fingerprint of a public key line.
 *
 * Computed here rather than in the browser because `crypto.subtle` does not
 * exist on a non-secure origin, and plain HTTP on a bare IP — the default way
 * this thing gets run — is exactly that.
 */
export function fingerprint(publicKeyLine: string): string | null {
  const blob = publicKeyLine.trim().split(/\s+/)[1];
  if (!blob) return null;
  try {
    const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64');
    return `SHA256:${digest.replace(/=+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Host key types in the order the client will actually pick them.
 *
 * This is golang.org/x/crypto/ssh's `supportedHostKeyAlgos` order, which puts
 * ECDSA ahead of Ed25519 — the opposite of what OpenSSH does, and the opposite
 * of what looks reasonable. Getting it wrong is not harmless: pinning a key the
 * server holds but does not present makes every pane report the host key as
 * *changed*, which reads like an attack rather than a misconfiguration.
 */
const HOST_KEY_TYPES = ['ecdsa', 'rsa', 'ed25519'] as const;

/**
 * Finds the host key the SSH target will actually present, so the browser can
 * pin it and skip the trust-on-first-use prompt.
 *
 * Asking the target with ssh-keyscan beats reading /etc/ssh/*.pub: it works
 * when the bridge points somewhere other than this machine, it needs no file
 * permissions, and it cannot pin a key that sshd is not actually serving.
 * Reading the local files stays as a fallback for when ssh-keyscan is missing.
 *
 * The type order matters — the pinned key has to be the one that wins
 * negotiation, not merely one the server happens to hold. Returns null if
 * nothing is discoverable, and the browser prompts once instead.
 */
export async function discoverHostKey(host: string, port: number): Promise<string | null> {
  for (const type of HOST_KEY_TYPES) {
    try {
      const { stdout } = await run('ssh-keyscan', ['-t', type, '-p', String(port), '-T', '5', host], {
        timeout: 10_000,
      });
      // Output is "<host> <type> <base64>". The leading host field is not part
      // of the key, and sshterm keys its known-hosts entry by endpoint name.
      const line = stdout.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      const parts = line?.trim().split(/\s+/);
      if (parts && parts.length >= 3) return `${parts[1]} ${parts[2]}`;
    } catch {
      // server does not offer this type, or no ssh-keyscan — try the next
    }
  }

  for (const type of HOST_KEY_TYPES) {
    try {
      const line = (await readFile(`/etc/ssh/ssh_host_${type}_key.pub`, 'utf8')).trim().split('\n')[0]?.trim();
      if (line) return line;
    } catch {
      // unreadable or absent — try the next
    }
  }
  return null;
}
