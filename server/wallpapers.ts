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

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { serialise, writeAtomic } from "./fsx.ts";
import { log } from "./log.ts";

export const MAX_WALLPAPER_BYTES = 16 * 1024 * 1024;

const SIGNATURES: {
  ext: string;
  mime: string;
  test: (b: Uint8Array) => boolean;
}[] = [
  {
    ext: "png",
    mime: "image/png",
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    ext: "jpg",
    mime: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "gif",
    mime: "image/gif",
    test: (b) =>
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    ext: "webp",
    mime: "image/webp",
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    ext: "avif",
    mime: "image/avif",
    test: (b) =>
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70 &&
      b[8] === 0x61 &&
      b[9] === 0x76 &&
      b[10] === 0x69 &&
      b[11] === 0x66,
  },
];

const ID_PATTERN = /^wp-[a-f0-9]{16}\.(png|jpg|gif|webp|avif)$/;

/**
 * Anything in Unicode's Control category, which a display name has no business
 * carrying: it is echoed back to the browser and written into the index file.
 */
const CONTROL_CHARS = /\p{Cc}/gu;

import type { DesktopPrefs, Wallpaper } from "../shared/wire.ts";

export type { DesktopPrefs, Wallpaper };

const DEFAULT_PREFS: DesktopPrefs = {
  wallpaper: null,
  fit: "cover",
  dim: 0.35,
};

/**
 * One rule for a prefs object, applied on the way in and on the way out.
 *
 * These were two implementations that disagreed: reading an out-of-range `dim`
 * fell back to the default, writing the same value clamped it to 0.9. Whichever
 * you believed, the other one was wrong.
 */
function sanitisePrefs(raw: unknown): DesktopPrefs {
  const v = (raw ?? {}) as Partial<DesktopPrefs>;
  const dim = Number(v.dim);
  return {
    wallpaper:
      typeof v.wallpaper === "string" && ID_PATTERN.test(v.wallpaper)
        ? v.wallpaper
        : null,
    fit: v.fit === "contain" || v.fit === "tile" ? v.fit : "cover",
    dim: Number.isFinite(dim)
      ? Math.min(0.9, Math.max(0, dim))
      : DEFAULT_PREFS.dim,
  };
}

/** Mime for a stored id, which is content-addressed and carries its extension. */
function mimeForId(id: string): string {
  return (
    SIGNATURES.find((s) => s.ext === id.split(".").pop())?.mime ??
    "application/octet-stream"
  );
}

function sniff(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length < 16) return null;
  return SIGNATURES.find((s) => s.test(bytes)) ?? null;
}

export class WallpaperStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly prefsPath: string;
  /**
   * The name index is read, modified and written back, which two concurrent
   * uploads would otherwise interleave — both read the old map, and the second
   * write drops the first's display name. Every mutation queues here instead.
   */
  private readonly queue = serialise();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "wallpapers");
    this.indexPath = path.join(this.dir, "index.json");
    this.prefsPath = path.join(stateDir, "desktop.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private async names(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as Record<
        string,
        string
      >;
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
      const mime = mimeForId(id);
      out.push({ id, name: names[id] ?? id, mime, size: file.size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Returns the stored wallpaper, or null if the id is unknown or malformed. */
  async read(
    id: string,
  ): Promise<{ file: ReturnType<typeof Bun.file>; mime: string } | null> {
    if (!ID_PATTERN.test(id)) return null;
    const file = Bun.file(path.join(this.dir, id));
    if (!(await file.exists())) return null;
    const mime = mimeForId(id);
    return { file, mime };
  }

  async save(bytes: Uint8Array, displayName: string): Promise<Wallpaper> {
    if (bytes.length === 0) throw new Error("empty upload");
    if (bytes.length > MAX_WALLPAPER_BYTES) {
      throw new Error(
        `image is larger than ${Math.round(MAX_WALLPAPER_BYTES / 1024 / 1024)}MB`,
      );
    }
    const kind = sniff(bytes);
    if (!kind)
      throw new Error("not a recognised image (png, jpeg, gif, webp or avif)");

    await this.init();
    const digest = createHash("sha256")
      .update(bytes)
      .digest("hex")
      .slice(0, 16);
    const id = `wp-${digest}.${kind.ext}`;
    await writeFile(path.join(this.dir, id), bytes, { mode: 0o600 });

    const clean =
      displayName.replace(CONTROL_CHARS, "").trim().slice(0, 80) || id;
    await this.queue(async () => {
      const names = await this.names();
      names[id] = clean;
      await writeAtomic(this.indexPath, JSON.stringify(names, null, 2), 0o600);
    });

    log.info(
      `stored wallpaper ${clean} (${(bytes.length / 1024).toFixed(0)}KB, ${kind.mime})`,
    );
    return { id, name: clean, mime: kind.mime, size: bytes.length };
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    try {
      await unlink(path.join(this.dir, id));
    } catch {
      return false;
    }
    await this.queue(async () => {
      const names = await this.names();
      delete names[id];
      await writeAtomic(this.indexPath, JSON.stringify(names, null, 2), 0o600);
    }).catch(() => {});

    // Do not leave the desktop pointing at something that no longer exists.
    const prefs = await this.prefs();
    if (prefs.wallpaper === id)
      await this.setPrefs({ ...prefs, wallpaper: null });
    return true;
  }

  async prefs(): Promise<DesktopPrefs> {
    try {
      return sanitisePrefs(
        JSON.parse(await readFile(this.prefsPath, "utf8")) as unknown,
      );
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  async setPrefs(next: DesktopPrefs): Promise<DesktopPrefs> {
    const clean = sanitisePrefs(next);
    await writeAtomic(this.prefsPath, JSON.stringify(clean, null, 2), 0o600);
    return clean;
  }
}
