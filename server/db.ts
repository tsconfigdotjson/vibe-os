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
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS windows_workspace_idx ON windows (workspace_id)`,
];

export type Db = BunSQLiteDatabase<{
  projects: typeof projects;
  workspaces: typeof workspaces;
  windows: typeof windows;
}>;

export function openDb(stateDir: string): Db {
  const file = path.join(stateDir, 'vibe-os.db');
  const sqlite = new Database(file, { create: true });

  // WAL keeps reads from blocking the writes the UI makes on every drag.
  sqlite.run('PRAGMA journal_mode = WAL');
  sqlite.run('PRAGMA foreign_keys = ON');
  for (const statement of DDL) sqlite.run(statement);

  log.debug(`opened database at ${file}`);
  return drizzle(sqlite, { schema: { projects, workspaces, windows } });
}

export const newId = () => crypto.randomUUID();
