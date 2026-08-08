import { useEffect, useRef, useState } from "react";
import type { DesktopPrefs, Wallpaper } from "./useWallpaper";
import { wallpaperUrl } from "./useWallpaper";

/**
 * The readability floor. Terminals sit on top of the wallpaper, so the scrim is
 * never allowed all the way to opaque — matches the server's own 0.9 clamp.
 */
const MAX_DIM_PERCENT = 90;

export interface WallpaperPanelProps {
  list: Wallpaper[];
  prefs: DesktopPrefs;
  busy: boolean;
  error: string | null;
  maxBytes: number;
  onSave: (next: DesktopPrefs) => void;
  onUpload: (file: File) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

const FITS: DesktopPrefs["fit"][] = ["cover", "contain", "tile"];

export function WallpaperPanel({
  list,
  prefs,
  busy,
  error,
  maxBytes,
  onSave,
  onUpload,
  onRemove,
  onClose,
}: WallpaperPanelProps) {
  /**
   * The slider drags locally and only saves on release.
   *
   * React maps `onChange` on a range input to the `input` event, so a single
   * drag from 35% to 80% used to fire ~45 PUTs — each one a round trip that set
   * state twice. Nothing sequenced the replies, so a late response for an early
   * value would drag the slider backwards under the cursor and leave the server
   * holding whichever request it happened to finish last.
   */
  const [dim, setDim] = useState(() => Math.round(prefs.dim * 100));
  const committed = Math.round(prefs.dim * 100);
  // Follow the saved value when it changes from anywhere other than this drag.
  useEffect(() => setDim(committed), [committed]);
  const commitDim = () => {
    if (dim !== committed) onSave({ ...prefs, dim: dim / 100 });
  };

  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <aside className="panel glass-solid" role="dialog" aria-label="Wallpaper">
        <header className="panel-head">
          <h2>Wallpaper</h2>
          <button type="button" onClick={onClose} title="Close">
            ✕
          </button>
        </header>

        {error ? <p className="panel-error">{error}</p> : null}

        <div className="thumbs">
          <button
            type="button"
            className="thumb thumb-none"
            data-active={prefs.wallpaper === null || undefined}
            onClick={() => onSave({ ...prefs, wallpaper: null })}
          >
            <span>none</span>
          </button>

          {list.map((wallpaper) => (
            <div key={wallpaper.id} className="thumb-slot">
              <button
                type="button"
                className="thumb"
                data-active={prefs.wallpaper === wallpaper.id || undefined}
                style={{
                  backgroundImage: `url(${wallpaperUrl(wallpaper.id)})`,
                }}
                onClick={() => onSave({ ...prefs, wallpaper: wallpaper.id })}
                title={wallpaper.name}
              />
              <button
                type="button"
                className="thumb-remove"
                onClick={() => onRemove(wallpaper.id)}
                title={`Delete ${wallpaper.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          className="upload"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? "uploading…" : "Upload an image"}
          <em>
            png, jpeg, webp, avif or gif · up to{" "}
            {Math.round(maxBytes / 1024 / 1024)}MB
          </em>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.target.value = "";
          }}
        />

        <div className="field">
          <label htmlFor="fit">Fit</label>
          <div className="segmented" id="fit">
            {FITS.map((fit) => (
              <button
                key={fit}
                type="button"
                data-active={prefs.fit === fit || undefined}
                onClick={() => onSave({ ...prefs, fit })}
              >
                {fit}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="dim">
            Dim <span className="field-value">{dim}%</span>
          </label>
          {/* Terminals sit on top of this, so readability is the point, not taste. */}
          <input
            id="dim"
            type="range"
            min={0}
            max={MAX_DIM_PERCENT}
            value={dim}
            onChange={(event) => setDim(Number(event.target.value))}
            onPointerUp={commitDim}
            onKeyUp={commitDim}
            onBlur={commitDim}
          />
        </div>
      </aside>
    </>
  );
}
