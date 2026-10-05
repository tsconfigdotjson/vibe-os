import type { MemoryReport } from "../data";
import type { WindowState } from "./useWindows";

export interface DockProps {
  windows: WindowState[];
  hues: Record<string, string>;
  /** Display name per window id — the role's name when it has one. */
  labels: Record<string, string>;
  focused: string | null;
  /** What each window costs and how the box is doing, when the server knows. */
  memory: MemoryReport | null;
  /** False when there is nothing to tile, or more windows than a tiling covers. */
  canTile: boolean;
  onSpawn: () => void;
  onSelect: (id: string) => void;
  onTile: () => void;
  onWallpaper: () => void;
}

/**
 * The dock is the only way to open a window, and the only place every running
 * session is listed — including minimised ones, which have no other
 * representation on screen.
 *
 * It hides itself between reaches; see the auto-hiding chrome block in the
 * stylesheet for why, and for what brings it back.
 */
export function Dock({
  windows,
  hues,
  labels,
  focused,
  memory,
  canTile,
  onSpawn,
  onSelect,
  onTile,
  onWallpaper,
}: DockProps) {
  return (
    <div className="dock-wrap">
      <nav className="dock glass" aria-label="Windows">
        <button
          type="button"
          className="dock-spawn"
          onClick={onSpawn}
          title="Open a terminal"
        >
          <span className="dock-plus" aria-hidden="true">
            +
          </span>
          terminal
        </button>

        {windows.length > 0 ? (
          <span className="dock-rule" aria-hidden="true" />
        ) : null}

        <ul className="dock-list">
          {windows.map((win) => (
            <li key={win.id}>
              <button
                type="button"
                className="dock-item"
                data-active={
                  win.id === focused && !win.minimized ? "" : undefined
                }
                data-minimized={win.minimized || undefined}
                data-status={win.status}
                style={{ ["--win-color" as string]: hues[win.id] }}
                onClick={() => onSelect(win.id)}
                title={
                  win.minimized
                    ? "Restore this window"
                    : "Bring this window to the front"
                }
              >
                <span className="dock-chip" aria-hidden="true">
                  {win.idx}
                </span>
                <span className="dock-label">{labels[win.id]}</span>
                <WindowMemory usage={memory?.windows[win.id]} />
              </button>
            </li>
          ))}
        </ul>

        <span className="dock-rule" aria-hidden="true" />

        {memory?.box ? <BoxMemory box={memory.box} /> : null}

        <button
          type="button"
          className="dock-icon"
          onClick={onTile}
          disabled={!canTile}
          title={
            canTile
              ? "Tile the windows across the desktop"
              : "Tiling arranges up to four windows; past that they are left alone"
          }
          aria-label="Tile the windows"
        >
          ⊞
        </button>

        <button
          type="button"
          className="dock-icon"
          onClick={onWallpaper}
          title="Change the wallpaper"
        >
          ◑
        </button>
      </nav>
    </div>
  );
}

/** `612M`, `1.4G`: short enough to sit beside a label in the dock. */
export function shortBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

/**
 * How close a window is to its limits. Past MemoryHigh the kernel is already
 * throttling it; within a tenth of MemoryMax it is about to be killed.
 */
export function windowLevel(usage: {
  bytes: number;
  high: number | null;
  max: number | null;
}): "ok" | "warn" | "err" {
  if (usage.max !== null && usage.bytes >= usage.max * 0.9) return "err";
  if (usage.high !== null && usage.bytes >= usage.high) return "warn";
  return "ok";
}

function WindowMemory({ usage }: { usage?: MemoryReport["windows"][string] }) {
  if (!usage) return null;
  const limits = [
    usage.high !== null ? `throttled past ${shortBytes(usage.high)}` : null,
    usage.max !== null ? `capped at ${shortBytes(usage.max)}` : null,
  ].filter(Boolean);
  return (
    <span
      className="dock-mem"
      data-level={windowLevel(usage)}
      title={
        usage.scoped
          ? `${shortBytes(usage.bytes)} in use${limits.length ? `; ${limits.join(", ")}` : ""}`
          : `${shortBytes(usage.bytes)} resident, with no memory limit on this session`
      }
    >
      {shortBytes(usage.bytes)}
    </span>
  );
}

/**
 * How the box is doing, by what is still available rather than by pressure: a
 * window throttled at its own limit stalls, and the kernel counts that as box
 * pressure even while the box itself is idle. That window shows on its own
 * dock entry instead.
 */
export function boxLevel(box: {
  total: number;
  available: number;
}): "ok" | "warn" | "err" {
  if (box.total === 0) return "ok";
  const free = box.available / box.total;
  if (free < 0.1) return "err";
  if (free < 0.2) return "warn";
  return "ok";
}

function BoxMemory({ box }: { box: NonNullable<MemoryReport["box"]> }) {
  const used = box.total - box.available;
  const share = box.total > 0 ? Math.round((used / box.total) * 100) : 0;
  const psi = box.pressure?.some10 ?? null;
  const swapUsed = box.swapTotal - box.swapFree;
  return (
    <span
      className="dock-box"
      data-level={boxLevel(box)}
      title={[
        `${shortBytes(used)} of ${shortBytes(box.total)} in use`,
        psi === null
          ? null
          : `memory pressure ${psi.toFixed(0)}%: the share of the last ten seconds something waited on memory. A window held at its own limit counts.`,
        box.swapTotal > 0
          ? `swap ${shortBytes(swapUsed)} of ${shortBytes(box.swapTotal)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <span className="dock-box-label">mem</span> {share}%
      {psi !== null && psi >= 1 ? (
        <span className="dock-box-psi"> · {psi.toFixed(0)}% stalled</span>
      ) : null}
    </span>
  );
}
