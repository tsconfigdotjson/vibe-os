import path from 'node:path';
import { EMBEDDED, BUILD_ID } from './assets.generated.ts';

/**
 * Serves the built web app.
 *
 * Two things earn their keep here: precompressed variants (ssh.wasm is ~20MB
 * raw and about a fifth of that as brotli, and it is on the critical path of
 * the very first page load), and an SPA fallback so deep links work.
 *
 * Assets resolve from the embedded manifest first, then from disk. In a
 * compiled binary the manifest holds everything and the disk is never touched;
 * under `bun run` the manifest is empty and everything comes off disk. Both
 * paths end at Bun.file, so there is only one code path to get right.
 */

/** Vite writes content-hashed filenames into assets/, so those cache forever. */
const IMMUTABLE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Required for WebAssembly.instantiateStreaming to take the fast path.
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function cacheControl(urlPath: string): string {
  if (IMMUTABLE.test(urlPath)) return 'public, max-age=31536000, immutable';
  if (urlPath.endsWith('.html') || urlPath === '/') return 'no-cache';
  // ssh.wasm and wasm_exec.js are big but do change on upgrade: let the client
  // keep them and revalidate cheaply with an ETag.
  return 'public, max-age=0, must-revalidate';
}

function encodingsFor(req: Request): ('br' | 'gzip')[] {
  const accept = req.headers.get('accept-encoding') ?? '';
  const out: ('br' | 'gzip')[] = [];
  if (/\bbr\b/.test(accept)) out.push('br');
  if (/\bgzip\b/.test(accept)) out.push('gzip');
  return out;
}

const SUFFIX = { br: '.br', gzip: '.gz' } as const;

export function createStaticServer(webRoot: string) {
  const root = path.resolve(webRoot);

  /** Resolves a repo-relative asset path to something Bun.file can open. */
  const locate = async (relative: string): Promise<string | null> => {
    const embedded = EMBEDDED[`/${relative}`];
    if (embedded) return embedded;

    const onDisk = path.resolve(root, relative);
    // path.resolve collapses "..", so one containment check is enough.
    if (onDisk !== root && !onDisk.startsWith(root + path.sep)) return null;
    return (await Bun.file(onDisk).exists()) ? onDisk : null;
  };

  return async function serveStatic(req: Request, urlPath: string): Promise<Response | null> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;

    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;

    let relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    let resolved = await locate(relative);

    // SPA fallback: anything that is not a real file and does not look like an
    // asset request gets index.html.
    if (!resolved) {
      if (path.extname(relative) !== '') return null;
      relative = 'index.html';
      resolved = await locate(relative);
      if (!resolved) return null;
      urlPath = '/index.html';
    }

    const type = MIME[path.extname(relative).toLowerCase()] ?? 'application/octet-stream';

    let encoding: 'br' | 'gzip' | null = null;
    let body = Bun.file(resolved);
    for (const candidate of encodingsFor(req)) {
      const alt = await locate(`${relative}${SUFFIX[candidate]}`);
      if (alt) {
        encoding = candidate;
        body = Bun.file(alt);
        break;
      }
    }

    // `.size` works for both real files and files embedded in a compiled
    // binary; `.stat()` returns undefined for the latter. Embedded assets have
    // no mtime either, so BUILD_ID stands in as the thing that changes when the
    // bytes do. The encoding is folded in so switching between br/gzip/identity
    // can never reuse a cached body of the wrong shape.
    const size = body.size;
    let version = BUILD_ID;
    if (!EMBEDDED[`/${relative}`]) {
      const st = await Promise.resolve(body.stat()).catch(() => null);
      if (st) version = Math.floor(st.mtimeMs).toString(16);
    }
    const etag = `W/"${size.toString(16)}-${version}${encoding ? `-${encoding}` : ''}"`;

    const headers = new Headers({
      'content-type': type,
      'cache-control': cacheControl(urlPath),
      etag,
      vary: 'Accept-Encoding',
    });
    if (encoding) headers.set('content-encoding', encoding);

    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers });
    }

    headers.set('content-length', String(size));
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(body, { status: 200, headers });
  };
}
