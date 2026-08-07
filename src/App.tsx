import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchServerConfig, type ServerConfig } from './api';
import { useHarness, useProfiles, useProjects, useWorkspaces, type ProfileInput } from './data';
import { useWindows, type Rect } from './desktop/useWindows';
import { TermWindow } from './desktop/TermWindow';
import { Dock } from './desktop/Dock';
import { GridOverlay } from './desktop/GridOverlay';
import { WallpaperPanel } from './desktop/WallpaperPanel';
import { useWallpaper } from './desktop/useWallpaper';
import { ProjectPicker } from './chrome/ProjectPicker';
import { WorkspaceSidebar } from './chrome/WorkspaceSidebar';
import { ProfileRail } from './chrome/ProfileRail';
import { ProfilePanel } from './chrome/ProfilePanel';
import { PopoutView } from './desktop/PopoutView';
import { usePopoutHost, readPopoutTarget } from './desktop/usePopouts';
import type { Viewport } from './desktop/geometry';

/**
 * Window identity colours, drawn from the ANSI palette the terminals use.
 * Assignment is by position, and the same colour marks a window in its title
 * bar, its focus ring and its dock entry — which is what makes several windows
 * distinguishable at a glance without reading anything.
 */
const HUES = ['#56cfe1', '#a78bfa', '#7ee081', '#f2c14e', '#ef6b73', '#63d4c0'];

const SELECTION_KEY = 'vibe-os:selection:v1';

/**
 * Measures the window surface.
 *
 * A callback ref, not an effect over a ref object: the desktop renders a boot
 * screen until the config arrives, so on mount there is no `.surface` to
 * observe — and an effect keyed on the ref object never runs again when one
 * appears, leaving the viewport pinned to its initial value and every window
 * clamped into a phantom rectangle.
 */
function useViewport(): [(node: HTMLElement | null) => void, Viewport] {
  const [view, setView] = useState<Viewport>({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const attach = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const measure = (width: number, height: number) => {
      if (width > 0 && height > 0) {
        setView((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }
    };
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      measure(width, height);
    });
    ro.observe(node);
    observer.current = ro;

    const rect = node.getBoundingClientRect();
    measure(rect.width, rect.height);
  }, []);

  return [attach, view];
}

/**
 * Read once, outside the component: a pop-out is a different kind of page, not
 * a different state of this one, and nothing in it can change while it is open.
 */
const POPOUT = readPopoutTarget();

export default function App() {
  if (POPOUT) return <PopoutView target={POPOUT} />;
  return <Desktop />;
}

function Desktop() {
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // null = closed, 'new' = creating, otherwise the id being edited.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [wsBusy, setWsBusy] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  // Which project and workspace you were last looking at is a per-device view
  // preference, not shared state, so it stays local. Everything it points *at*
  // lives on the server.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const [attachSurface, view] = useViewport();
  const { projects, rescan } = useProjects();
  const { workspaces, create, remove, touch } = useWorkspaces(projectId);
  const { profiles, create: createProfile, update: updateProfile, remove: removeProfile } = useProfiles(projectId);
  const wallpaper = useWallpaper();
  const popouts = usePopoutHost();
  const harnessInfo = useHarness();

  const {
    windows,
    ordered,
    focused,
    spawn,
    openProfile,
    markPromptDone,
    close,
    restart,
    move,
    raise,
    minimize,
    maximize,
    setStatus,
    setTitle,
  } = useWindows(workspaceId);

  useEffect(() => {
    let cancelled = false;
    fetchServerConfig().then(
      (config) => !cancelled && setServer(config),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );
    try {
      const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '{}') as {
        projectId?: string;
        workspaceId?: string;
      };
      if (saved.projectId) setProjectId(saved.projectId);
      if (saved.workspaceId) setWorkspaceId(saved.workspaceId);
    } catch {
      // no saved selection — the effects below pick sensible defaults
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SELECTION_KEY, JSON.stringify({ projectId, workspaceId }));
    } catch {
      // private mode — selection just resets next visit
    }
  }, [projectId, workspaceId]);

  // Fall back to the first project, and drop a selection that no longer exists.
  useEffect(() => {
    if (projects.length === 0) return;
    if (!projectId || !projects.some((p) => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Same for workspaces — the list is ordered most-recently-opened first.
  useEffect(() => {
    if (!projectId) return;
    if (workspaces.length === 0) {
      setWorkspaceId(null);
      return;
    }
    if (!workspaceId || !workspaces.some((w) => w.id === workspaceId)) setWorkspaceId(workspaces[0].id);
  }, [workspaces, workspaceId, projectId]);

  const touchRef = useRef(touch);
  touchRef.current = touch;
  useEffect(() => {
    if (workspaceId) touchRef.current(workspaceId);
  }, [workspaceId]);

  const currentProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );
  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  /**
   * Window colours.
   *
   * A profile window takes its role's colour — that is the whole point of
   * choosing one, and it has to be the same colour in the rail, the title bar
   * and the dock or it identifies nothing. Plain terminals keep the positional
   * palette, which only ever has to make them distinct from each other.
   */
  const hues = useMemo(() => {
    const map: Record<string, string> = {};
    windows.forEach((win, index) => {
      const profile = win.profileId ? profileById.get(win.profileId) : undefined;
      map[win.id] = profile ? `var(--profile-${profile.color})` : HUES[index % HUES.length];
    });
    return map;
  }, [windows, profileById]);

  const runningProfiles = useMemo(
    () => new Set(windows.map((w) => w.profileId).filter((id): id is string => id !== null)),
    [windows],
  );

  /**
   * What each window is called.
   *
   * A role window is called by its role everywhere it appears — the title bar,
   * the dock — because that is the name you went looking for. Plain terminals
   * keep the workspace-and-index name, which is also their tmux session.
   */
  const labels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const win of windows) {
      const profile = win.profileId ? profileById.get(win.profileId) : undefined;
      map[win.id] = profile
        ? profile.name
        : currentWorkspace
          ? `${currentWorkspace.name}-${win.idx}`
          : `window ${win.idx}`;
    }
    return map;
  }, [windows, profileById, currentWorkspace]);

  const focusedProfileId = useMemo(
    () => windows.find((w) => w.id === focused)?.profileId ?? null,
    [windows, focused],
  );

  const onRescan = useCallback(async () => {
    setScanning(true);
    try {
      await rescan();
    } finally {
      setScanning(false);
    }
  }, [rescan]);

  const onCreateWorkspace = useCallback(async () => {
    setWsBusy(true);
    setWsError(null);
    try {
      const created = await create();
      setWorkspaceId(created.id);
    } catch (err) {
      setWsError(err instanceof Error ? err.message : String(err));
    } finally {
      setWsBusy(false);
    }
  }, [create]);

  const onRemoveWorkspace = useCallback(
    async (id: string) => {
      setWsError(null);
      try {
        await remove(id);
        if (id === workspaceId) setWorkspaceId(null);
      } catch (err) {
        setWsError(err instanceof Error ? err.message : String(err));
      }
    },
    [remove, workspaceId],
  );

  // Alt chords rather than tmux's ctrl-b: the terminal has focus almost all the
  // time and ctrl-b belongs to the tmux session running inside it. Capture
  // phase, because xterm claims keys on its own textarea first.
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const win = windows[digit - 1];
        if (win) {
          raise(win.id);
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const actions: Record<string, () => void> = {
        t: () => void spawn(),
        w: () => focused && close(focused),
        z: () => focused && maximize(focused),
        m: () => focused && minimize(focused),
        n: () => void onCreateWorkspace(),
      };
      const action = actions[event.key.toLowerCase()];
      if (action) {
        action();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [windows, focused, spawn, close, maximize, minimize, raise, onCreateWorkspace],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onKeyDown]);

  if (error) {
    return (
      <div className="boot boot-error">
        <p className="boot-line">could not reach the vibe-os server</p>
        <p className="boot-detail">{error}</p>
        <button type="button" className="ghost" onClick={() => window.location.reload()}>
          retry
        </button>
      </div>
    );
  }

  if (!server) {
    return (
      <div className="boot">
        <p className="boot-line">
          vibe-os<span className="caret" aria-hidden="true" />
        </p>
        <p className="boot-detail">reading host configuration…</p>
      </div>
    );
  }

  const wallpaperUrl = wallpaper.prefs.wallpaper ? `/api/wallpapers/${wallpaper.prefs.wallpaper}` : null;
  const measured = view.width > 0 && view.height > 0;

  return (
    <div className="desktop">
      <div
        className="wallpaper"
        style={
          wallpaperUrl
            ? {
                backgroundImage: `url(${wallpaperUrl})`,
                backgroundSize: wallpaper.prefs.fit === 'tile' ? 'auto' : wallpaper.prefs.fit,
                backgroundRepeat: wallpaper.prefs.fit === 'tile' ? 'repeat' : 'no-repeat',
              }
            : undefined
        }
      />
      <div className="wallpaper-dim" style={{ opacity: wallpaperUrl ? wallpaper.prefs.dim : 0 }} />

      <header className="menubar glass">
        <span className="wordmark">
          vibe-os<span className="caret" aria-hidden="true" />
        </span>

        <ProjectPicker
          projects={projects}
          current={currentProject}
          scanning={scanning}
          onSelect={setProjectId}
          onRescan={onRescan}
        />

        <span className="menu-facts">
          {currentWorkspace ? (
            <>
              <span className="menu-strong">{currentWorkspace.name}</span>
              <span className="sep">·</span>
            </>
          ) : null}
          <span>
            {server.user}@{server.hostname}
          </span>
          <span className="sep">·</span>
          <span title={server.hostKey ?? 'host key not pinned'}>
            {server.hostKeyFingerprint ?? 'host key: prompt'}
          </span>
          <span className="sep">·</span>
          {/* This is a security state, so it says what it means rather than
              making you remember what a one-word status implied. */}
          <span
            data-warn={!server.authRequired || undefined}
            title={
              server.authRequired
                ? 'A token is required to reach this desktop.'
                : `No gate: anyone who can reach this address gets a shell as ${server.user}. Restart with --token to require one.`
            }
          >
            {server.authRequired ? 'token auth' : 'no auth'}
          </span>
        </span>
        <span className="menu-right">v{server.version}</span>
      </header>

      <div className="workbench">
        <WorkspaceSidebar
          workspaces={workspaces}
          current={workspaceId}
          projectName={currentProject?.name ?? null}
          busy={wsBusy}
          error={wsError}
          onSelect={setWorkspaceId}
          onCreate={onCreateWorkspace}
          onRemove={onRemoveWorkspace}
        />

        <main className="surface" ref={attachSurface}>
          {measured ? <GridOverlay preview={preview} view={view} /> : null}

          {measured
            ? ordered.map((win) => (
                <TermWindow
                  key={win.id}
                  win={{ ...win, label: currentWorkspace ? `${currentWorkspace.name}-${win.idx}` : `window ${win.idx}` }}
                  server={server}
                  hue={hues[win.id]}
                  profile={win.profileId ? (profileById.get(win.profileId) ?? null) : null}
                  poppedOut={popouts.popped.has(win.id)}
                  onPopOut={(id) =>
                    popouts.open(
                      id,
                      labels[id],
                      win.profileId ? (profileById.get(win.profileId)?.color ?? 'cyan') : 'cyan',
                    )
                  }
                  onReclaim={popouts.reclaim}
                  focused={win.id === focused}
                  view={view}
                  onRaise={raise}
                  onCommit={move}
                  onPreview={setPreview}
                  onClose={close}
                  onRestart={restart}
                  onMinimize={minimize}
                  onMaximize={maximize}
                  onStatus={setStatus}
                  onTitle={setTitle}
                  onPromptDone={markPromptDone}
                />
              ))
            : null}

          {measured && windows.length === 0 ? (
            <div className="empty">
              <div className="empty-card glass">
              {!currentProject ? (
                <>
                  <p className="empty-line">No project selected.</p>
                  <p className="empty-hint">Pick one from the menu bar, or press refresh to scan for repos.</p>
                </>
              ) : !currentWorkspace ? (
                <>
                  <p className="empty-line">No workspace in {currentProject.name}.</p>
                  <button type="button" className="ghost" onClick={onCreateWorkspace} disabled={wsBusy}>
                    Create a workspace
                  </button>
                  <p className="empty-hint">
                    or press <kbd>alt</kbd> <kbd>n</kbd>
                  </p>
                </>
              ) : (
                <>
                  <p className="empty-line">No windows in {currentWorkspace.name}.</p>
                  <button type="button" className="ghost" onClick={() => void spawn()}>
                    Open a terminal
                  </button>
                  <p className="empty-hint">
                    or press <kbd>alt</kbd> <kbd>t</kbd>
                  </p>
                </>
              )}
              </div>
            </div>
          ) : null}
        </main>

        <ProfileRail
          profiles={profiles}
          running={runningProfiles}
          activeId={focusedProfileId}
          projectName={currentProject?.name ?? null}
          canOpen={Boolean(workspaceId)}
          onOpen={(id, opts) => void openProfile(id, opts)}
          onEdit={setEditing}
          onCreate={() => setEditing('new')}
        />
      </div>

      <Dock
        windows={windows}
        hues={hues}
        labels={labels}
        focused={focused}
        onSpawn={() => void spawn()}
        onSelect={raise}
        onWallpaper={() => setPanelOpen(true)}
      />

      {editing ? (
        <ProfilePanel
          // Remounts between profiles so the form state is rebuilt from the
          // one being edited rather than kept from the last one.
          key={editing}
          profile={editing === 'new' ? null : (profileById.get(editing) ?? null)}
          palette={server.palette}
          harnessInfo={harnessInfo}
          onSave={(input: ProfileInput) =>
            editing === 'new' ? createProfile(input) : updateProfile(editing, input)
          }
          onDelete={editing === 'new' ? null : () => removeProfile(editing)}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {panelOpen ? (
        <WallpaperPanel
          list={wallpaper.list}
          prefs={wallpaper.prefs}
          busy={wallpaper.busy}
          error={wallpaper.error}
          maxBytes={server.maxWallpaperBytes}
          onSave={wallpaper.save}
          onUpload={wallpaper.upload}
          onRemove={wallpaper.remove}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
    </div>
  );
}
