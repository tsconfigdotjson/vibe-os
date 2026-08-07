// Persistence for projects, workspaces and window layout.
//
// SQLite via bun:sqlite, which is built into the runtime — no service to run
// and one file in the state directory. The schema is applied as idempotent DDL
// at startup rather than through drizzle-kit migration files, because a
// `bun build --compile` binary has no directory to read .sql from. Verified to
// behave identically under `bun run` and compiled.

import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import path from 'node:path';
import { log } from './log.ts';

/** A git repository checked out on this machine. */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  /** Branch the repo's main checkout is on, refreshed on scan. */
  branch: text('branch'),
  /** origin remote, when it has one — usually the GitHub URL. */
  remote: text('remote'),
  createdAt: integer('created_at').notNull(),
});

/** A git worktree of a project — what the UI calls a workspace. */
export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    /** Three words, kebab-case. Doubles as the branch and the tmux prefix. */
    name: text('name').notNull(),
    branch: text('branch').notNull(),
    path: text('path').notNull(),
    createdAt: integer('created_at').notNull(),
    lastOpenedAt: integer('last_opened_at').notNull(),
  },
  (t) => [index('workspaces_project_idx').on(t.projectId)],
);

/**
 * A role you can open a terminal as — "QA Engineer", "Backend Manager".
 *
 * Scoped to a project rather than a workspace: the prompts and flags belong to
 * the codebase, and workspaces are throwaway worktrees of it.
 */
export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    /** Palette token, not a hex value — the CSS owns what the colours are. */
    color: text('color').notNull(),
    /** 'claude' | 'shell' | 'custom' */
    harness: text('harness').notNull(),
    /** Executable for the custom harness; unused by the other two. */
    command: text('command'),
    /** JSON array of argv tokens, so each can be quoted on its own. */
    args: text('args').notNull().default('[]'),
    prompt: text('prompt').notNull().default(''),
    /** Order in the rail. */
    position: integer('position').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('profiles_project_idx').on(t.projectId)],
);

/** One terminal window, with its place on the grid. */
export const windows = sqliteTable(
  'windows',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    /** Per-workspace counter; forms the tmux session name with the workspace. */
    idx: integer('idx').notNull(),
    col: integer('col').notNull(),
    row: integer('row').notNull(),
    colSpan: integer('col_span').notNull(),
    rowSpan: integer('row_span').notNull(),
    z: integer('z').notNull(),
    minimized: integer('minimized').notNull().default(0),
    /** The profile this window was opened as, or null for a plain terminal. */
    profileId: text('profile_id'),
    /** The prompt band has been handed off and should stay closed. */
    promptDone: integer('prompt_done').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('windows_workspace_idx').on(t.workspaceId)],
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
const ADDED_COLUMNS: [table: string, column: string, decl: string][] = [
  ['windows', 'profile_id', 'TEXT'],
  ['windows', 'prompt_done', 'INTEGER NOT NULL DEFAULT 0'],
];

function ensureColumn(sqlite: Database, table: string, column: string, decl: string): void {
  const existing = sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
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
  const file = path.join(stateDir, 'vibe-os.db');
  const sqlite = new Database(file, { create: true });

  // WAL keeps reads from blocking the writes the UI makes on every drag.
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA foreign_keys = ON');
  for (const statement of DDL) sqlite.run(statement);
  for (const [table, column, decl] of ADDED_COLUMNS) ensureColumn(sqlite, table, column, decl);

  log.debug(`opened database at ${file}`);
  return drizzle(sqlite, { schema: { projects, workspaces, profiles, windows } });
}

export const newId = () => crypto.randomUUID();
