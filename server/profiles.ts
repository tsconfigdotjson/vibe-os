// Profiles: the roles you can open a terminal as.
//
// A profile is a name, a colour, a harness with its flags, and a standing
// prompt. It belongs to a project, so it is available in every workspace of
// that project — the prompts and flags describe the codebase, and workspaces
// are throwaway worktrees of it.

import { asc, eq } from "drizzle-orm";
import { detokenize, tokenize } from "../shared/args.ts";
import type { Harness, Profile, ProfileInput } from "../shared/wire.ts";
import { type Db, newId, profiles, windows } from "./db.ts";

/**
 * The ten colours a profile can be.
 *
 * Stored as tokens rather than hex so the stylesheet stays the single place
 * that decides what "coral" looks like, and so a stored value can be validated
 * instead of trusted.
 */
export const PALETTE = [
  "cyan",
  "teal",
  "green",
  "lime",
  "amber",
  "orange",
  "coral",
  "rose",
  "violet",
  "blue",
] as const;

/**
 * `satisfies` rather than a plain literal: it is what makes the runtime list and
 * the wire type fail to compile if they ever stop agreeing.
 */
export const HARNESSES = [
  "claude",
  "hermes",
  "shell",
  "custom",
] as const satisfies readonly Harness[];

const MAX_NAME = 40;
const MAX_PROMPT = 16_000;
const MAX_ARGS = 64;
const MAX_TOKEN = 512;

export type { Profile, ProfileInput };
export { detokenize, tokenize };

function parseStoredArgs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

const hydrate = (row: typeof profiles.$inferSelect): Profile => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  color: row.color,
  harness: row.harness as Harness,
  command: row.command,
  args: parseStoredArgs(row.args),
  prompt: row.prompt,
  position: row.position,
  createdAt: row.createdAt,
});

/**
 * Checks and normalises what the editor sent.
 *
 * `partial` is the update case, where an absent field means "leave it alone"
 * rather than "clear it".
 */
type Fields = Partial<typeof profiles.$inferInsert>;
/** What a non-partial validate guarantees: the three columns with no default. */
type CompleteFields = Fields &
  Required<Pick<typeof profiles.$inferInsert, "name" | "color" | "harness">>;

function validate(input: ProfileInput, partial: true): Fields;
function validate(input: ProfileInput, partial: false): CompleteFields;
function validate(input: ProfileInput, partial: boolean): Fields {
  const out: Fields = {};

  if (input.name !== undefined || !partial) {
    const name = (input.name ?? "").trim();
    if (name.length === 0) throw new Error("a profile needs a name");
    if (name.length > MAX_NAME)
      throw new Error(`name must be ${MAX_NAME} characters or fewer`);
    out.name = name;
  }

  if (input.color !== undefined || !partial) {
    const color = input.color ?? PALETTE[0];
    if (!(PALETTE as readonly string[]).includes(color))
      throw new Error(`unknown colour ${color}`);
    out.color = color;
  }

  if (input.harness !== undefined || !partial) {
    const harness = input.harness ?? "claude";
    if (!(HARNESSES as readonly string[]).includes(harness))
      throw new Error(`unknown harness ${harness}`);
    out.harness = harness;
  }

  if (input.command !== undefined || !partial) {
    const command = (input.command ?? "").trim();
    out.command = command === "" ? null : command;
  }

  if (input.args !== undefined || !partial) {
    const tokens = tokenize(input.args ?? "");
    if (tokens.length > MAX_ARGS)
      throw new Error(`too many arguments (limit ${MAX_ARGS})`);
    for (const token of tokens) {
      if (token.length > MAX_TOKEN) throw new Error("an argument is too long");
      // Both would be truncated or mangled by the time they reached execve.
      if (token.includes("\0") || /[\r\n]/.test(token))
        throw new Error("arguments cannot span lines");
    }
    out.args = JSON.stringify(tokens);
  }

  if (input.prompt !== undefined || !partial) {
    const prompt = input.prompt ?? "";
    if (prompt.length > MAX_PROMPT)
      throw new Error(`prompt must be under ${MAX_PROMPT} characters`);
    out.prompt = prompt;
  }

  // A custom harness with no command would launch nothing at all, silently.
  const harness = out.harness ?? input.harness;
  if (harness === "custom" && out.command === null)
    throw new Error("a custom harness needs a command");

  return out;
}

export function listProfiles(db: Db, projectId: string): Profile[] {
  return db
    .select()
    .from(profiles)
    .where(eq(profiles.projectId, projectId))
    .orderBy(asc(profiles.position), asc(profiles.createdAt))
    .all()
    .map(hydrate);
}

export function getProfile(db: Db, id: string): Profile | undefined {
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get();
  return row ? hydrate(row) : undefined;
}

export function createProfile(
  db: Db,
  projectId: string,
  input: ProfileInput,
): Profile {
  const fields = validate(input, false);
  const siblings = listProfiles(db, projectId);
  const id = newId();

  db.insert(profiles)
    .values({
      id,
      projectId,
      name: fields.name,
      color: fields.color,
      harness: fields.harness,
      command: fields.command ?? null,
      args: fields.args ?? "[]",
      prompt: fields.prompt ?? "",
      position: input.position ?? siblings.length,
      createdAt: Date.now(),
    })
    .run();

  const created = getProfile(db, id);
  if (!created) throw new Error(`profile ${id} vanished after insert`);
  return created;
}

export function updateProfile(
  db: Db,
  id: string,
  input: ProfileInput,
): Profile | undefined {
  const current = getProfile(db, id);
  if (!current) return undefined;

  // Merged before validating so a partial update cannot land an invalid
  // combination — clearing the command on an already-custom profile, say.
  const fields = validate(
    { harness: current.harness, command: current.command, ...input },
    true,
  );
  if (Object.keys(fields).length > 0) {
    db.update(profiles).set(fields).where(eq(profiles.id, id)).run();
  }
  if (input.position !== undefined) {
    db.update(profiles)
      .set({ position: input.position })
      .where(eq(profiles.id, id))
      .run();
  }
  return getProfile(db, id);
}

/**
 * Forgets a profile, leaving its windows running.
 *
 * Those windows are live sessions with real work in them. Deleting the
 * definition of a role should not kill the session doing it — the window simply
 * becomes an ordinary terminal.
 */
export function deleteProfile(db: Db, id: string): boolean {
  const current = getProfile(db, id);
  if (!current) return false;
  db.update(windows)
    .set({ profileId: null })
    .where(eq(windows.profileId, id))
    .run();
  db.delete(profiles).where(eq(profiles.id, id)).run();
  return true;
}

export function deleteProjectProfiles(db: Db, projectId: string): void {
  db.delete(profiles).where(eq(profiles.projectId, projectId)).run();
}
