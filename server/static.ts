import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Required for WebAssembly.instantiateStreaming to take the fast path.
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Vite writes content-hashed filenames into assets/, so those can be cached forever. */
const IMMUTABLE = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

function cacheControl(urlPath: string): string {
  if (IMMUTABLE.test(urlPath)) return 'public, max-age=31536000, immutable';
  if (urlPath.endsWith('.html') || urlPath === '/') return 'no-cache';
  // ssh.wasm and wasm_exec.js are big but do change on upgrade: let the client
  // keep them and revalidate cheaply with an ETag.
  return 'public, max-age=0, must-revalidate';
}

function etagFor(stats: Stats, encoding: string): string {
  return `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}${encoding ? `-${encoding}` : ''}"`;
}

function pickEncoding(req: IncomingMessage): ('br' | 'gzip' | '')[] {
  const accept = String(req.headers['accept-encoding'] ?? '');
  const out: ('br' | 'gzip' | '')[] = [];
  if (/\bbr\b/.test(accept)) out.push('br');
  if (/\bgzip\b/.test(accept)) out.push('gzip');
  out.push('');
  return out;
}

const EXT_FOR_ENCODING = { br: '.br', gzip: '.gz', '': '' } as const;

async function statFile(p: string): Promise<Stats | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

export interface StaticServer {
  (req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean>;
}

/**
 * Serves the built web app.
 *
 * Two things here earn their keep: precompressed variants (ssh.wasm is ~20MB
 * raw and about a quarter of that as brotli, and it is on the critical path of
 * the very first page load), and an SPA fallback so deep links work.
 */
export function createStaticServer(root: string): StaticServer {
  const resolvedRoot = path.resolve(root);

  return async function serveStatic(req, res, urlPath) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return false;

    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return false;
    }
    if (decoded.includes('\0')) return false;

    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    let filePath = path.resolve(resolvedRoot, relative);

    // path.resolve collapses "..", so a single containment check is enough.
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) return false;

    let stats = await statFile(filePath);
    if (stats && filePath.endsWith(path.sep)) stats = null;

    // SPA fallback: anything that is not a real file and does not look like an
    // asset request gets index.html.
    if (!stats) {
      if (path.extname(relative) !== '') return false;
      filePath = path.join(resolvedRoot, 'index.html');
      stats = await statFile(filePath);
      if (!stats) return false;
      urlPath = '/index.html';
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';

    let encoding: 'br' | 'gzip' | '' = '';
    let servedPath = filePath;
    let servedStats = stats;
    for (const candidate of pickEncoding(req)) {
      if (candidate === '') break;
      const alt = `${filePath}${EXT_FOR_ENCODING[candidate]}`;
      const altStats = await statFile(alt);
      if (altStats) {
        encoding = candidate;
        servedPath = alt;
        servedStats = altStats;
        break;
      }
    }

    // The ETag tracks the original file so that switching encodings does not
    // silently reuse a cached body of the wrong shape.
    const etag = etagFor(stats, encoding);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cacheControl(urlPath));
    res.setHeader('ETag', etag);
    res.setHeader('Vary', 'Accept-Encoding');
    if (encoding) res.setHeader('Content-Encoding', encoding);

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return true;
    }

    res.setHeader('Content-Length', servedStats.size);
    if (method === 'HEAD') {
      res.writeHead(200).end();
      return true;
    }

    res.writeHead(200);
    const stream = createReadStream(servedPath);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  };
}
