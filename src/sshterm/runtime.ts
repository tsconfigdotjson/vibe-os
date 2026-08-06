import type { SshSession, SshTermConfig } from './types';

/**
 * Loads and boots the sshterm Go/WASM runtime exactly once per page.
 *
 * The Go side (go/main.go) expects `window.sshApp` to already exist with an
 * `sshIsReady` callback. It then installs `window.sshApp.start`, invokes
 * `sshIsReady()`, and blocks forever on a channel — so a single instance
 * serves every terminal on the page.
 *
 * That sharing is the thing to keep in mind when building a multiplexer on top
 * of this: there is one Go runtime for the whole page, and an unhandled panic
 * in any one session takes down every other pane with it. `onRuntimeDead` below
 * exists so the app can notice and rebuild its panes instead of leaving the
 * user staring at frozen terminals.
 */

const base = import.meta.env.BASE_URL;

export interface RuntimeUrls {
  wasmUrl?: string;
  wasmExecUrl?: string;
}

let bootstrap: Promise<void> | null = null;
const deathListeners = new Set<() => void>();

/** Notified when the shared Go runtime exits or panics. Returns an unsubscribe. */
export function onRuntimeDead(listener: () => void): () => void {
  deathListeners.add(listener);
  return () => deathListeners.delete(listener);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-sshterm="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.dataset.sshterm = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function instantiate(wasmUrl: string, importObject: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  // instantiateStreaming requires an application/wasm content type. Not every
  // static file server sets it, so fall back to buffering the module.
  try {
    const result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), importObject);
    return result.instance;
  } catch {
    const bytes = await fetch(wasmUrl).then((r) => {
      if (!r.ok) throw new Error(`fetch ${wasmUrl}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    const result = await WebAssembly.instantiate(bytes, importObject);
    return result.instance;
  }
}

async function boot(urls: RuntimeUrls): Promise<void> {
  const wasmUrl = urls.wasmUrl ?? `${base}ssh.wasm`;
  const wasmExecUrl = urls.wasmExecUrl ?? `${base}wasm_exec.js`;

  await loadScript(wasmExecUrl);
  if (!window.Go) {
    throw new Error('wasm_exec.js did not define globalThis.Go');
  }

  // Must be in place before go.run() — main.go panics if it is missing.
  const ready = new Promise<void>((resolve) => {
    window.sshApp = {
      exited: null,
      sshIsReady: () => resolve(),
    };
  });

  const go = new window.Go();
  const instance = await instantiate(wasmUrl, go.importObject);

  // go.run() settles only if Go's main() returns or panics — and a panic in any
  // one session tears down the shared runtime. Drop the cached bootstrap so the
  // next session boots a fresh instance instead of calling into a dead one.
  void go.run(instance).then(markRuntimeDead, markRuntimeDead);

  await ready;
}

function markRuntimeDead(): void {
  bootstrap = null;
  if (window.sshApp) delete window.sshApp.start;
  for (const listener of deathListeners) {
    try {
      listener();
    } catch {
      // a broken listener must not stop the others
    }
  }
}

/** Boots the WASM runtime (idempotent) and resolves once `start` is available. */
export function loadSshRuntime(urls: RuntimeUrls = {}): Promise<void> {
  if (!bootstrap) {
    bootstrap = boot(urls).catch((err) => {
      // Let a later attempt retry instead of caching the failure forever.
      bootstrap = null;
      throw err;
    });
  }
  return bootstrap;
}

/**
 * Starts one SSH session bound to an xterm.js Terminal.
 *
 * Go reads `term` off the object and deletes it before JSON-decoding the rest,
 * so a fresh object is passed each time rather than the caller's config.
 */
export async function startSshSession(
  config: SshTermConfig,
  term: unknown,
  urls: RuntimeUrls = {},
): Promise<SshSession> {
  await loadSshRuntime(urls);
  const start = window.sshApp?.start;
  if (!start) {
    throw new Error('sshApp.start is unavailable — the WASM runtime failed to boot');
  }
  return start({ ...config, term });
}
