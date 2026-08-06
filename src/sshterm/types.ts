/**
 * Types mirroring the Go config struct in
 * github.com/c2FmZQ/sshterm/go/config/config.go
 *
 * The WASM module receives this object (minus `term`) as JSON, so everything
 * here must stay JSON-serializable.
 */

export interface CertificateAuthority {
  name: string;
  /** OpenSSH public key line, e.g. "ssh-ed25519 AAAA..." */
  publicKey: string;
  /** Hostname patterns this CA is trusted for, e.g. ["*.example.com"] */
  hostnames?: string[];
}

export interface Endpoint {
  /** Name used by the `ssh user@<name>` command. */
  name: string;
  /** WebSocket URL. Relative URLs ("./websocket") resolve against the page. */
  url: string;
}

export interface KnownHost {
  name: string;
  /** OpenSSH public key line. Omit to be prompted on first connect. */
  key?: string;
}

export interface GenerateKey {
  name: string;
  type?: 'ed25519' | 'ecdsa' | 'rsa';
  bits?: number;
  /**
   * URL that turns this key into a certificate. The app POSTs the public key
   * as text/plain and expects a signed certificate back, also text/plain. Must
   * be absolute — the Go HTTP client cannot resolve a relative URL.
   */
  identityProvider?: string;
  addToAgent?: boolean;
}

export interface AutoConnect {
  /** If unset, the user is prompted. */
  username?: string;
  hostname: string;
  identity?: string;
  /**
   * Careful: setting this takes the `session.Run(command)` path in upstream,
   * which allocates no PTY and wires up no resize handling. vibe-os leaves it
   * unset and puts the command in the certificate's force-command instead, so
   * sshd runs it inside a real PTY.
   */
  command?: string;
  forwardAgent?: boolean;
  jumpHosts?: string;
}

export interface SshTermConfig {
  /** IndexedDB database name. Defaults to "sshterm". */
  dbName?: string;
  theme?: string;
  /** Forces persistence on/off; the user cannot change it from the app. */
  persist?: boolean;
  certificateAuthorities?: CertificateAuthority[];
  endpoints?: Endpoint[];
  hosts?: KnownHost[];
  generateKeys?: GenerateKey[];
  /** When set, connects immediately and disables interactive commands. */
  autoConnect?: AutoConnect;
}

/** Handle returned by window.sshApp.start(). */
export interface SshSession {
  close: () => void;
  /** Resolves with "closed" or "exited" when the session ends. */
  done: Promise<string>;
}

export type SshStatus = 'loading' | 'ready' | 'ended' | 'error';

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run: (instance: WebAssembly.Instance) => Promise<void>;
}

declare global {
  interface Window {
    /**
     * The contract with ssh.wasm: this object must exist before the Go
     * runtime starts. Go calls sshIsReady() and sets start().
     */
    sshApp?: {
      ready?: Promise<void>;
      sshIsReady?: () => void;
      exited?: string | null;
      start?: (cfg: SshTermConfig & { term: unknown }) => Promise<SshSession>;
    };
    Go?: new () => GoRuntime;
  }
}
