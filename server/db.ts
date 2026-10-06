// Persistence for projects, workspaces and window layout.
//
// SQLite via bun:sqlite, which is built into the runtime — no service to run
// and one file in the state directory. The schema is applied as idempotent DDL
// at startup rather than through drizzle-kit migration files, because a
// `bun build --compile` binary has no directory to read .sql from. Verified to
// behave identically under `bun run` and compiled.

import { Database } from "bun:sqlite";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { log } from "./log.ts";

/** A git repository checked out on this machine. */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  /** Branch the repo's main checkout is on, refreshed on scan. */
  branch: text("branch"),
  /** origin remote, when it has one — usually the GitHub URL. */
  remote: text("remote"),
  createdAt: integer("created_at").notNull(),
});

/** A git worktree of a project — what the UI calls a workspace. */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    /** Three words, kebab-case. Doubles as the branch and the dtach prefix. */
    name: text("name").notNull(),
    branch: text("branch").notNull(),
    path: text("path").notNull(),
    createdAt: integer("created_at").notNull(),
    lastOpenedAt: integer("last_opened_at").notNull(),
  },
  (t) => [index("workspaces_project_idx").on(t.projectId)],
);

/**
 * A role you can open a terminal as — "QA Engineer", "Backend Manager".
 *
 * Scoped to a project rather than a workspace: the prompts and flags belong to
 * the codebase, and workspaces are throwaway worktrees of it.
 */
export const profiles = sqliteTable(
  "profiles",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    /** Palette token, not a hex value — the CSS owns what the colours are. */
    color: text("color").notNull(),
    /** 'claude' | 'shell' | 'custom' */
    harness: text("harness").notNull(),
    /** Executable for the custom harness; unused by the other two. */
    command: text("command"),
    /** JSON array of argv tokens, so each can be quoted on its own. */
    args: text("args").notNull().default("[]"),
    prompt: text("prompt").notNull().default(""),
    /** systemd sizes for this role's scope, or null to use the server's. */
    memoryHigh: text("memory_high"),
    memoryMax: text("memory_max"),
    /** Order in the rail. */
    position: integer("position").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("profiles_project_idx").on(t.projectId)],
);

/** One terminal window, with its place on the grid. */
export const windows = sqliteTable(
  "windows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** Per-workspace counter; forms the session name with the workspace. */
    idx: integer("idx").notNull(),
    col: integer("col").notNull(),
    row: integer("row").notNull(),
    colSpan: integer("col_span").notNull(),
    rowSpan: integer("row_span").notNull(),
    z: integer("z").notNull(),
    minimized: integer("minimized").notNull().default(0),
    /** The profile this window was opened as, or null for a plain terminal. */
    profileId: text("profile_id"),
    /** The prompt band has been handed off and should stay closed. */
    promptDone: integer("prompt_done").notNull().default(0),
    /**
     * 'ssh' while this window's terminal belongs to an ssh client instead of
     * the desktop, or null. A browser pop-out is not recorded here: those two
     * documents share an origin and settle it over a BroadcastChannel, and a
     * flag that outlived a closed pop-up would strand the window.
     */
    handoff: text("handoff"),
    /** When the handoff was made, so one that never got used can be reaped. */
    handoffAt: integer("handoff_at"),
    /** Set once a terminal has actually attached to this window's session. */
    handoffSeen: integer("handoff_seen").notNull().default(0),
    /**
     * 'ask' when the session died without its harness exiting (a reboot, a
     * kill), so the desktop offers to bring it back rather than starting one.
     * 'resume' once the answer was yes, until the next session is created.
     */
    restore: text("restore"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("windows_workspace_idx").on(t.workspaceId)],
);

const DDL = [
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     branch TEXT,
     remote TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     branch TEXT NOT NULL,
     path TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_opened_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS workspaces_project_idx ON workspaces (project_id)`,
  `CREATE TABLE IF NOT EXISTS profiles (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     color TEXT NOT NULL,
     harness TEXT NOT NULL,
     command TEXT,
     args TEXT NOT NULL DEFAULT '[]',
     prompt TEXT NOT NULL DEFAULT '',
     memory_high TEXT,
     memory_max TEXT,
     position INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS profiles_project_idx ON profiles (project_id)`,
  `CREATE TABLE IF NOT EXISTS windows (
     id TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     col INTEGER NOT NULL,
     row INTEGER NOT NULL,
     col_span INTEGER NOT NULL,
     row_span INTEGER NOT NULL,
     z INTEGER NOT NULL,
     minimized INTEGER NOT NULL DEFAULT 0,
     profile_id TEXT,
     prompt_done INTEGER NOT NULL DEFAULT 0,
     handoff TEXT,
     handoff_at INTEGER,
     handoff_seen INTEGER NOT NULL DEFAULT 0,
     restore TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS windows_workspace_idx ON windows (workspace_id)`,
];

/**
 * Columns added to a table that already existed.
 *
 * The DDL above is all CREATE TABLE IF NOT EXISTS, which does nothing at all to
 * a database from an earlier version — so a new column has to arrive this way
 * or it only ever appears for people starting from scratch. ADD COLUMN is the
 * one schema change SQLite does cheaply and in place.
 */
// Every value here is a compile-time literal, which is what makes the string
// concatenation in `ensureColumn` safe — SQLite cannot parameterise identifiers
// or DDL, so there is no bound-parameter form of ALTER TABLE. Nothing from a
// request may ever reach this list.
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ["windows", "profile_id", "TEXT"],
  ["windows", "prompt_done", "INTEGER NOT NULL DEFAULT 0"],
  ["windows", "handoff", "TEXT"],
  ["windows", "handoff_at", "INTEGER"],
  ["windows", "handoff_seen", "INTEGER NOT NULL DEFAULT 0"],
  ["windows", "restore", "TEXT"],
  ["profiles", "memory_high", "TEXT"],
  ["profiles", "memory_max", "TEXT"],
];

function ensureColumn(
  sqlite: Database,
  table: string,
  column: string,
  decl: string,
): void {
  const existing = sqlite.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (existing.some((c) => c.name === column)) return;
  sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  log.info(`migrated ${table}: added ${column}`);
}

export type Db = BunSQLiteDatabase<{
  projects: typeof projects;
  workspaces: typeof workspaces;
  profiles: typeof profiles;
  windows: typeof windows;
}>;

export function openDb(stateDir: string): Db {
  const file = path.join(stateDir, "vibe-os.db");
  const sqlite = new Database(file, { create: true });

  // WAL keeps reads from blocking the writes the UI makes on every drag.
  sqlite.run("PRAGMA journal_mode = WAL");
  // On for anything added later. No table declares a REFERENCES clause today,
  // so this currently enforces nothing: the cascades are done by hand, in
  // projects.ts and profiles.ts. Do not read it as a guarantee.
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const statement of DDL) sqlite.run(statement);
  for (const [table, column, decl] of ADDED_COLUMNS)
    ensureColumn(sqlite, table, column, decl);

  assertSchemaMatches(sqlite);

  log.debug(`opened database at ${file}`);
  return drizzle(sqlite, {
    schema: { projects, workspaces, profiles, windows },
  });
}

/**
 * Fails loudly if the live tables do not have every column the code reads.
 *
 * Each migrated column is declared three times — in the drizzle schema, in the
 * CREATE TABLE DDL, and in ADDED_COLUMNS — and nothing forces those to agree. A
 * column added to the DDL and forgotten in ADDED_COLUMNS works perfectly on a
 * fresh install and breaks only on upgrade, which is the failure the comment on
 * ADDED_COLUMNS exists to prevent and could not actually catch. Checking what
 * the code expects against what the file has turns that into a startup error
 * with the column name in it.
 */
function assertSchemaMatches(sqlite: Database): void {
  const tables = { projects, workspaces, profiles, windows };
  const missing: string[] = [];
  for (const [name, table] of Object.entries(tables)) {
    const live = new Set(
      (
        sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string }[]
      ).map((c) => c.name),
    );
    for (const column of Object.values(getTableColumns(table))) {
      if (!live.has(column.name)) missing.push(`${name}.${column.name}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `database is missing column(s) the code expects: ${missing.join(", ")}. ` +
        "A column was added to the schema without a matching ADDED_COLUMNS entry.",
    );
  }
}

export const newId = () => crypto.randomUUID();

/**
 * What a valid id looks like coming back over HTTP.
 *
 * Lives here beside `newId` because it has to accept what that produces. It was
 * declared once in `api.ts` as `ID` and again in `attach.ts` as `WINDOW_ID`,
 * byte-identical, and both validate the same values.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
