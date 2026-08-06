// Wallpaper storage.
//
// Stored content-addressed: the filename is derived from a hash of the bytes,
// never from anything the client sent. That removes path traversal as a
// category rather than trying to sanitise around it, and deduplicates uploads
// for free. The user's chosen display name lives in a side index.
//
// The type is decided by sniffing magic bytes, not by trusting Content-Type or
// a file extension. These files are served back to a browser, so letting a
// caller label an HTML document as an image would be a stored-XSS primitive.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { log } from './log.ts';

export const MAX_WALLPAPER_BYTES = 16 * 1024 * 1024;

const SIGNATURES: { ext: string; mime: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    ext: 'avif',
    mime: 'image/avif',
    test: (b) =>
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66,
  },
];

const ID_PATTERN = /^wp-[a-f0-9]{16}\.(png|jpg|gif|webp|avif)$/;

export interface Wallpaper {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface DesktopPrefs {
  wallpaper: string | null;
  fit: 'cover' | 'contain' | 'tile';
  /** 0…0.9 scrim over the wallpaper. Terminals have to stay readable. */
  dim: number;
}

const DEFAULT_PREFS: DesktopPrefs = { wallpaper: null, fit: 'cover', dim: 0.35 };

function sniff(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length < 16) return null;
  return SIGNATURES.find((s) => s.test(bytes)) ?? null;
}

export class WallpaperStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly prefsPath: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'wallpapers');
    this.indexPath = path.join(this.dir, 'index.json');
    this.prefsPath = path.join(stateDir, 'desktop.json');
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private async names(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.indexPath, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async list(): Promise<Wallpaper[]> {
    await this.init();
    const names = await this.names();
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const out: Wallpaper[] = [];
    for (const id of entries) {
      if (!ID_PATTERN.test(id)) continue;
      const file = Bun.file(path.join(this.dir, id));
      const mime = SIGNATURES.find((s) => s.ext === id.split('.').pop())?.mime ?? 'application/octet-stream';
      out.push({ id, name: names[id] ?? id, mime, size: file.size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Returns the stored wallpaper, or null if the id is unknown or malformed. */
  async read(id: string): Promise<{ file: ReturnType<typeof Bun.file>; mime: string } | null> {
    if (!ID_PATTERN.test(id)) return null;
    const file = Bun.file(path.join(this.dir, id));
    if (!(await file.exists())) return null;
    const mime = SIGNATURES.find((s) => s.ext === id.split('.').pop())?.mime ?? 'application/octet-stream';
    return { file, mime };
  }

  async save(bytes: Uint8Array, displayName: string): Promise<Wallpaper> {
    if (bytes.length === 0) throw new Error('empty upload');
    if (bytes.length > MAX_WALLPAPER_BYTES) {
      throw new Error(`image is larger than ${Math.round(MAX_WALLPAPER_BYTES / 1024 / 1024)}MB`);
    }
    const kind = sniff(bytes);
    if (!kind) throw new Error('not a recognised image (png, jpeg, gif, webp or avif)');

    await this.init();
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const id = `wp-${digest}.${kind.ext}`;
    await writeFile(path.join(this.dir, id), bytes, { mode: 0o600 });

    const clean = displayName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || id;
    const names = await this.names();
    names[id] = clean;
    await writeFile(this.indexPath, JSON.stringify(names, null, 2), { mode: 0o600 });

    log.info(`stored wallpaper ${clean} (${(bytes.length / 1024).toFixed(0)}KB, ${kind.mime})`);
    return { id, name: clean, mime: kind.mime, size: bytes.length };
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    try {
      await unlink(path.join(this.dir, id));
    } catch {
      return false;
    }
    const names = await this.names();
    delete names[id];
    await writeFile(this.indexPath, JSON.stringify(names, null, 2), { mode: 0o600 }).catch(() => {});

    // Do not leave the desktop pointing at something that no longer exists.
    const prefs = await this.prefs();
    if (prefs.wallpaper === id) await this.setPrefs({ ...prefs, wallpaper: null });
    return true;
  }

  async prefs(): Promise<DesktopPrefs> {
    try {
      const raw = JSON.parse(await readFile(this.prefsPath, 'utf8')) as Partial<DesktopPrefs>;
      return {
        wallpaper: typeof raw.wallpaper === 'string' && ID_PATTERN.test(raw.wallpaper) ? raw.wallpaper : null,
        fit: raw.fit === 'contain' || raw.fit === 'tile' ? raw.fit : 'cover',
        dim: typeof raw.dim === 'number' && raw.dim >= 0 && raw.dim <= 0.9 ? raw.dim : DEFAULT_PREFS.dim,
      };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  async setPrefs(next: DesktopPrefs): Promise<DesktopPrefs> {
    const clean: DesktopPrefs = {
      wallpaper: typeof next.wallpaper === 'string' && ID_PATTERN.test(next.wallpaper) ? next.wallpaper : null,
      fit: next.fit === 'contain' || next.fit === 'tile' ? next.fit : 'cover',
      dim: Math.min(0.9, Math.max(0, Number(next.dim) || 0)),
    };
    await writeFile(this.prefsPath, JSON.stringify(clean, null, 2), { mode: 0o600 });
    return clean;
  }
}
