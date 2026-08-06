import { useCallback, useEffect, useState } from 'react';

export interface Wallpaper {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface DesktopPrefs {
  wallpaper: string | null;
  fit: 'cover' | 'contain' | 'tile';
  dim: number;
}

/**
 * Wallpaper choice lives on the server rather than in localStorage, so the same
 * desktop appears on every device you open it from and survives clearing site
 * data. Uploads are content-addressed server-side; the id is the hash.
 */
export function useWallpaper() {
  const [list, setList] = useState<Wallpaper[]>([]);
  const [prefs, setPrefs] = useState<DesktopPrefs>({ wallpaper: null, fit: 'cover', dim: 0.35 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [wallpapers, desktop] = await Promise.all([
        fetch('/api/wallpapers').then((r) => r.json() as Promise<Wallpaper[]>),
        fetch('/api/desktop').then((r) => r.json() as Promise<DesktopPrefs>),
      ]);
      setList(wallpapers);
      setPrefs(desktop);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (next: DesktopPrefs) => {
    setPrefs(next); // optimistic: the desktop should react immediately
    try {
      const res = await fetch('/api/desktop', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`saving preferences failed (HTTP ${res.status})`);
      setPrefs((await res.json()) as DesktopPrefs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/wallpapers?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        const body = (await res.json()) as Wallpaper | { error: string };
        if (!res.ok) throw new Error('error' in body ? body.error : `upload failed (HTTP ${res.status})`);
        await refresh();
        await save({ ...prefs, wallpaper: (body as Wallpaper).id });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [prefs, refresh, save],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/wallpapers/${id}`, { method: 'DELETE' }).catch(() => {});
      await refresh();
    },
    [refresh],
  );

  return { list, prefs, busy, error, save, upload, remove, dismissError: () => setError(null) };
}
