import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProfilePanel } from "./chrome/ProfilePanel";
import { ProfileRail } from "./chrome/ProfileRail";
import { ProjectPicker } from "./chrome/ProjectPicker";
import { WorkspaceSidebar } from "./chrome/WorkspaceSidebar";
import {
  describeError,
  type ProfileInput,
  useCursor,
  useHarness,
  useHermes,
  useMcpServers,
  useProfiles,
  useProjects,
  useServerConfig,
  useWorkspaces,
} from "./data";
import { Boot, BootError } from "./desktop/Boot";
import { Dock } from "./desktop/Dock";
import { GridOverlay } from "./desktop/GridOverlay";
import type { Viewport } from "./desktop/geometry";
import { PopoutView } from "./desktop/PopoutView";
import { TermWindow } from "./desktop/TermWindow";
import { readPopoutTarget, usePopoutHost } from "./desktop/usePopouts";
import { useWallpaper, wallpaperUrl } from "./desktop/useWallpaper";
import { type Rect, useWindows } from "./desktop/useWindows";
import { WallpaperPanel } from "./desktop/WallpaperPanel";

/**
 * Window identity colours, drawn from the ANSI palette the terminals use.
 * Assignment is by position, and the same colour marks a window in its title
 * bar, its focus ring and its dock entry — which is what makes several windows
 * distinguishable at a glance without reading anything.
 */
const HUES = ["#56cfe1", "#a78bfa", "#7ee081", "#f2c14e", "#ef6b73", "#63d4c0"];

const SELECTION_KEY = "vibe-os:selection:v1";

/** Palette token a pop-out falls back to when its window has no profile. */
const DEFAULT_HUE_TOKEN = "cyan";

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
        setView((prev) =>
          prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
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
  const { server, error } = useServerConfig();
  const [preview, setPreview] = useState<Rect | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // null = closed, 'new' = creating, otherwise the id being edited.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [scanning, setScanning] = useState(false);
  const [wsBusy, setWsBusy] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  // Something the last creation wants to admit to — a stale base, say — which
  // is not an error, because the workspace is there either way.
  const [wsNote, setWsNote] = useState<string | null>(null);

  // Which project and workspace you were last looking at is a per-device view
  // preference, not shared state, so it stays local. Everything it points *at*
  // lives on the server.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const [attachSurface, view] = useViewport();
  const { projects, rescan } = useProjects();
  const { workspaces, create, remove, touch } = useWorkspaces(projectId);
  const {
    profiles,
    create: createProfile,
    update: updateProfile,
    remove: removeProfile,
  } = useProfiles(projectId);
  const wallpaper = useWallpaper();
  const popouts = usePopoutHost();
  const harnessInfo = useHarness();
  const hermesInfo = useHermes();
  const cursorInfo = useCursor();
  const { servers: mcpServers } = useMcpServers(projectId);

  const {
    windows,
    ordered,
    focused,
    spawn,
    openProfile,
    markPromptDone,
    handoff,
    close,
    restart,
    move,
    raise,
    minimize,
    maximize,
    tile,
    tileable,
    setStatus,
    setTitle,
  } = useWindows(workspaceId);

  // Restoring the saved selection is its own concern; it used to share an
  // effect with the config fetch for no reason beyond both running once.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}") as {
        projectId?: string;
        workspaceId?: string;
      };
      if (saved.projectId) setProjectId(saved.projectId);
      if (saved.workspaceId) setWorkspaceId(saved.workspaceId);
    } catch {
      // no saved selection — the effects below pick sensible defaults
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SELECTION_KEY,
        JSON.stringify({ projectId, workspaceId }),
      );
    } catch {
      // private mode — selection just resets next visit
    }
  }, [projectId, workspaceId]);

  // Fall back to the first project, and drop a selection that no longer exists.
  useEffect(() => {
    if (projects.length === 0) return;
    if (!projectId || !projects.some((p) => p.id === projectId))
      setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Same for workspaces — the list is ordered most-recently-opened first.
  useEffect(() => {
    if (!projectId) return;
    if (workspaces.length === 0) {
      setWorkspaceId(null);
      return;
    }
    if (!workspaceId || !workspaces.some((w) => w.id === workspaceId))
      setWorkspaceId(workspaces[0].id);
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

  const profileById = useMemo(
    () => new Map(profiles.map((p) => [p.id, p])),
    [profiles],
  );

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
      const profile = win.profileId
        ? profileById.get(win.profileId)
        : undefined;
      map[win.id] = profile
        ? `var(--profile-${profile.color})`
        : HUES[index % HUES.length];
    });
    return map;
  }, [windows, profileById]);

  const runningProfiles = useMemo(
    () =>
      new Set(
        windows
          .map((w) => w.profileId)
          .filter((id): id is string => id !== null),
      ),
    [windows],
  );

  /**
   * What each window is called.
   *
   * A role window is called by its role everywhere it appears — the title bar,
   * the dock — because that is the name you went looking for. Plain terminals
   * keep the workspace-and-index name, which is also their session.
   */
  const labels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const win of windows) {
      const profile = win.profileId
        ? profileById.get(win.profileId)
        : undefined;
      map[win.id] = profile
        ? profile.name
        : currentWorkspace
          ? `${currentWorkspace.name}-${win.idx}`
          : `window ${win.idx}`;
    }
    return map;
  }, [windows, profileById, currentWorkspace]);

  /**
   * The workspace-and-index name, which the title bar shows even when a profile
   * has given the window a nicer one. Built here rather than inline in the JSX,
   * where the same expression appeared a second time and rebuilt a prop object
   * on every render.
   */
  const positional = useMemo(() => {
    const map: Record<string, string> = {};
    for (const win of windows) {
      map[win.id] = currentWorkspace
        ? `${currentWorkspace.name}-${win.idx}`
        : `window ${win.idx}`;
    }
    return map;
  }, [windows, currentWorkspace]);

  const openPopout = useCallback(
    (id: string) => {
      const profileId = windows.find((w) => w.id === id)?.profileId;
      const color = profileId
        ? (profileById.get(profileId)?.color ?? DEFAULT_HUE_TOKEN)
        : DEFAULT_HUE_TOKEN;
      return popouts.open(id, labels[id], color);
    },
    [windows, profileById, labels, popouts],
  );

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

  // Both say something about one project's workspaces, so neither survives a
  // move to another one: a warning about a stale base is a false claim once it
  // is sitting above a list it was not written about.
  const onSelectProject = useCallback((id: string) => {
    setProjectId(id);
    setWsError(null);
    setWsNote(null);
  }, []);

  const onCreateWorkspace = useCallback(async () => {
    setWsBusy(true);
    setWsError(null);
    setWsNote(null);
    try {
      const created = await create();
      setWorkspaceId(created.id);
      setWsNote(created.warning);
    } catch (err) {
      setWsError(describeError(err));
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
        setWsError(describeError(err));
      }
    },
    [remove, workspaceId],
  );

  if (error) {
    return (
      <BootError message={error} onRetry={() => window.location.reload()} />
    );
  }

  if (!server) {
    return <Boot title="vibe-os" detail="reading host configuration…" />;
  }

  const backdrop = wallpaper.prefs.wallpaper
    ? wallpaperUrl(wallpaper.prefs.wallpaper)
    : null;
  const measured = view.width > 0 && view.height > 0;

  return (
    <div className="desktop">
      <div
        className="wallpaper"
        style={
          backdrop
            ? {
                backgroundImage: `url(${backdrop})`,
                backgroundSize:
                  wallpaper.prefs.fit === "tile" ? "auto" : wallpaper.prefs.fit,
                backgroundRepeat:
                  wallpaper.prefs.fit === "tile" ? "repeat" : "no-repeat",
              }
            : undefined
        }
      />
      <div
        className="wallpaper-dim"
        style={{ opacity: backdrop ? wallpaper.prefs.dim : 0 }}
      />

      <header className="menubar glass">
        <span className="wordmark">
          vibe-os
          <span className="caret" aria-hidden="true" />
        </span>

        <ProjectPicker
          projects={projects}
          current={currentProject}
          scanning={scanning}
          onSelect={onSelectProject}
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
          <span title={server.hostKey ?? "host key not pinned"}>
            {server.hostKeyFingerprint ?? "host key: prompt"}
          </span>
          <span className="sep">·</span>
          {/* This is a security state, so it says what it means rather than
              making you remember what a one-word status implied. */}
          <span
            data-warn={!server.authRequired || undefined}
            title={
              server.authRequired
                ? "A token is required to reach this desktop."
                : `No gate: anyone who can reach this address gets a shell as ${server.user}. Restart with --token to require one.`
            }
          >
            {server.authRequired ? "token auth" : "no auth"}
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
          note={wsNote}
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
                  win={win}
                  label={positional[win.id]}
                  server={server}
                  hue={hues[win.id]}
                  profile={
                    win.profileId
                      ? (profileById.get(win.profileId) ?? null)
                      : null
                  }
                  // A browser pop-out is known from the channel the two
                  // documents gossip on; a terminal cannot join that, so its
                  // handoff is on the row. Either way the window lets go.
                  poppedTo={
                    popouts.popped.has(win.id)
                      ? "browser"
                      : win.handoff === "ssh"
                        ? "ssh"
                        : null
                  }
                  onPopOut={openPopout}
                  onHandoff={handoff}
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
                    <p className="empty-hint">
                      Pick one from the menu bar, or press refresh to scan for
                      repos.
                    </p>
                  </>
                ) : !currentWorkspace ? (
                  <>
                    <p className="empty-line">
                      No workspace in {currentProject.name}.
                    </p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={onCreateWorkspace}
                      disabled={wsBusy}
                    >
                      {wsBusy ? (
                        <>
                          <span className="spinner" aria-hidden="true" />
                          Fetching origin…
                        </>
                      ) : (
                        "Create a workspace"
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="empty-line">
                      No windows in {currentWorkspace.name}.
                    </p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void spawn()}
                    >
                      Open a terminal
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </main>

        {/* The strip of screen that calls the rail back. It has to come before
            the rail in the DOM: the stylesheet reveals one from the other with
            a sibling selector, and there is no state to keep in sync. */}
        <div className="rail-edge" aria-hidden="true" />

        <ProfileRail
          profiles={profiles}
          running={runningProfiles}
          activeId={focusedProfileId}
          projectName={currentProject?.name ?? null}
          canOpen={Boolean(workspaceId)}
          onOpen={(id, opts) => void openProfile(id, opts)}
          onEdit={setEditing}
          onCreate={() => setEditing("new")}
        />
      </div>

      {/* Same trick along the bottom edge, for the dock. */}
      <div className="dock-edge" aria-hidden="true" />

      <Dock
        windows={windows}
        hues={hues}
        labels={labels}
        focused={focused}
        canTile={tileable}
        onSpawn={() => void spawn()}
        onSelect={raise}
        onTile={tile}
        onWallpaper={() => setPanelOpen(true)}
      />

      {editing ? (
        <ProfilePanel
          // Remounts between profiles so the form state is rebuilt from the
          // one being edited rather than kept from the last one.
          key={editing}
          profile={
            editing === "new" ? null : (profileById.get(editing) ?? null)
          }
          palette={server.palette}
          harnessInfo={harnessInfo}
          hermesInfo={hermesInfo}
          cursorInfo={cursorInfo}
          mcpServers={mcpServers}
          onSave={(input: ProfileInput) =>
            editing === "new"
              ? createProfile(input)
              : updateProfile(editing, input)
          }
          onDelete={editing === "new" ? null : () => removeProfile(editing)}
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
