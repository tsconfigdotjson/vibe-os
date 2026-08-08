import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopPrefs, Wallpaper } from "../../shared/wire";
import { describeError, request } from "../data";

/** The routes this hook owns, named so they are not spelled out at five sites. */
const WALLPAPERS = "/api/wallpapers";
const DESKTOP = "/api/desktop";

/** Matches the server's DEFAULT_PREFS; what shows before /api/desktop answers. */
const DEFAULT_PREFS: DesktopPrefs = {
  wallpaper: null,
  fit: "cover",
  dim: 0.35,
};

/** The URL that renders a stored wallpaper. */
export const wallpaperUrl = (id: string): string => `${WALLPAPERS}/${id}`;

/**
 * Wallpaper choice lives on the server rather than in localStorage, so the same
 * desktop appears on every device you open it from and survives clearing site
 * data. Uploads are content-addressed server-side; the id is the hash.
 */
export function useWallpaper() {
  const [list, setList] = useState<Wallpaper[]>([]);
  const [prefs, setPrefs] = useState<DesktopPrefs>(DEFAULT_PREFS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which save is the newest.
   *
   * The dim slider fires a PUT per pointer move, and the responses are not
   * guaranteed to come back in order — so without this the reply to an earlier,
   * lower value could land last and drag the slider backwards under the cursor.
   * Only the newest request is allowed to write state.
   */
  const saveSeq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [wallpapers, desktop] = await Promise.all([
        request<Wallpaper[]>(WALLPAPERS),
        request<DesktopPrefs>(DESKTOP),
      ]);
      setList(wallpapers);
      // A save in flight is newer than anything this refresh just read.
      if (saveSeq.current === 0) setPrefs(desktop);
      return desktop;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (next: DesktopPrefs) => {
    setPrefs(next); // optimistic: the desktop should react immediately
    saveSeq.current += 1;
    const seq = saveSeq.current;
    try {
      const stored = await request<DesktopPrefs>(DESKTOP, {
        method: "PUT",
        body: next,
      });
      if (seq === saveSeq.current) setPrefs(stored);
    } catch (err) {
      setError(describeError(err));
    } finally {
      if (seq === saveSeq.current) saveSeq.current = 0;
    }
  }, []);

  const upload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const stored = await request<Wallpaper>(
          `${WALLPAPERS}?name=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            raw: file,
            headers: {
              "content-type": file.type || "application/octet-stream",
            },
          },
        );
        // Build on what the server just told us, not on the `prefs` this
        // closure captured at render time — refresh has since replaced it, and
        // saving the stale copy would put the old fit and dim back.
        const current = (await refresh()) ?? prefs;
        await save({ ...current, wallpaper: stored.id });
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [prefs, refresh, save],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await request<void>(wallpaperUrl(id), { method: "DELETE" });
      } catch (err) {
        // A delete that fails used to look exactly like one that succeeded.
        setError(describeError(err));
      }
      await refresh();
    },
    [refresh],
  );

  return {
    list,
    prefs,
    busy,
    error,
    save,
    upload,
    remove,
  };
}

export type { DesktopPrefs, Wallpaper };
