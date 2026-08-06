// Let's Encrypt via HTTP-01.
//
// We already own port 80, which is exactly what the HTTP-01 challenge needs, so
// there is no separate listener and nothing to coordinate: the challenge
// responder is just another route on the plain-HTTP server, checked before the
// redirect-to-HTTPS rule.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { log } from './log.ts';

const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
/** Renew this far ahead of expiry. Let's Encrypt certs last 90 days. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  key: string;
  cert: string;
}

export interface AcmeOptions {
  domain: string;
  email?: string;
  staging: boolean;
  stateDir: string;
}

export class Acme {
  private challenges = new Map<string, string>();
  private readonly dir: string;

  constructor(private readonly options: AcmeOptions) {
    this.dir = path.join(options.stateDir, 'tls');
  }

  /** Serves the HTTP-01 challenge. Must run before any HTTPS redirect. */
  handleChallenge(url: URL): Response | null {
    if (!url.pathname.startsWith(CHALLENGE_PREFIX)) return null;
    const token = url.pathname.slice(CHALLENGE_PREFIX.length);
    const value = this.challenges.get(token);
    if (!value) return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(value, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }

  private paths() {
    return {
      key: path.join(this.dir, `${this.options.domain}.key`),
      cert: path.join(this.dir, `${this.options.domain}.crt`),
      account: path.join(this.dir, 'account.key'),
    };
  }

  private async loadExisting(): Promise<TlsMaterial | null> {
    const { key, cert } = this.paths();
    try {
      const [keyPem, certPem] = await Promise.all([readFile(key, 'utf8'), readFile(cert, 'utf8')]);
      const acme = await import('acme-client');
      const info = acme.crypto.readCertificateInfo(certPem);
      const remaining = info.notAfter.getTime() - Date.now();
      if (remaining > RENEW_BEFORE_MS) {
        log.ok(`reusing TLS certificate for ${this.options.domain} (expires ${info.notAfter.toISOString().slice(0, 10)})`);
        return { key: keyPem, cert: certPem };
      }
      log.info(`TLS certificate for ${this.options.domain} expires soon — renewing`);
      return null;
    } catch {
      return null;
    }
  }

  /** Returns usable key/cert material, ordering a new certificate if needed. */
  async obtain(): Promise<TlsMaterial> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });

    const existing = await this.loadExisting();
    if (existing) return existing;

    const acme = await import('acme-client');
    const { key: keyPath, cert: certPath, account: accountPath } = this.paths();

    let accountKey: Buffer;
    try {
      accountKey = await readFile(accountPath);
    } catch {
      accountKey = await acme.crypto.createPrivateKey();
      await writeFile(accountPath, accountKey, { mode: 0o600 });
    }

    const client = new acme.Client({
      directoryUrl: this.options.staging
        ? acme.directory.letsencrypt.staging
        : acme.directory.letsencrypt.production,
      accountKey,
    });

    log.info(`requesting a TLS certificate for ${this.options.domain}…`);
    const [privateKey, csr] = await acme.crypto.createCsr({ commonName: this.options.domain });

    const cert = await client.auto({
      csr,
      email: this.options.email,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type !== 'http-01') return;
        this.challenges.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        this.challenges.delete(challenge.token);
      },
    });

    const keyPem = privateKey.toString();
    const certPem = cert.toString();
    await writeFile(keyPath, keyPem, { mode: 0o600 });
    await writeFile(certPath, certPem, { mode: 0o644 });
    log.ok(`TLS certificate issued for ${this.options.domain}`);

    return { key: keyPem, cert: certPem };
  }
}
