import { useRef } from 'react';
import type { DesktopPrefs, Wallpaper } from './useWallpaper';

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

const FITS: DesktopPrefs['fit'][] = ['cover', 'contain', 'tile'];

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
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="panel glass" role="dialog" aria-label="Wallpaper">
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
                style={{ backgroundImage: `url(/api/wallpapers/${wallpaper.id})` }}
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
          {busy ? 'uploading…' : 'Upload an image'}
          <em>png, jpeg, webp, avif or gif · up to {Math.round(maxBytes / 1024 / 1024)}MB</em>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.target.value = '';
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
            Dim <span className="field-value">{Math.round(prefs.dim * 100)}%</span>
          </label>
          {/* Terminals sit on top of this, so readability is the point, not taste. */}
          <input
            id="dim"
            type="range"
            min={0}
            max={90}
            value={Math.round(prefs.dim * 100)}
            onChange={(event) => onSave({ ...prefs, dim: Number(event.target.value) / 100 })}
          />
        </div>
      </aside>
    </>
  );
}
