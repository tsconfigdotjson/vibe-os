import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseTranscript,
  tailMessages,
} from "../server/harnesses/claude-transcript.ts";

const line = (o: unknown) => JSON.stringify(o);
const at = "2026-10-15T12:00:00.000Z";

const user = (content: unknown, extra = {}) =>
  line({
    type: "user",
    timestamp: at,
    message: { role: "user", content },
    ...extra,
  });
const assistant = (id: string, content: unknown[]) =>
  line({
    type: "assistant",
    timestamp: at,
    message: { id, role: "assistant", content },
  });

describe("parseTranscript", () => {
  test("user and assistant text, and tool calls in short form", () => {
    const text = [
      line({ type: "permission-mode", permissionMode: "default" }),
      user("fix the build"),
      assistant("m1", [{ type: "thinking", thinking: "hmm" }]),
      assistant("m1", [{ type: "text", text: "Looking." }]),
      assistant("m1", [
        { type: "tool_use", name: "Bash", input: { command: "bun   test" } },
      ]),
      user([{ type: "tool_result", content: "ok" }]),
      assistant("m2", [{ type: "text", text: "Fixed" }]),
      assistant("m2", [{ type: "text", text: "the build." }]),
    ].join("\n");
    expect(parseTranscript(text)).toEqual([
      { role: "user", text: "fix the build", at: Date.parse(at) },
      { role: "assistant", text: "Looking.", at: Date.parse(at) },
      { role: "tool", text: "Bash(bun test)", at: Date.parse(at) },
      { role: "assistant", text: "Fixed\nthe build.", at: Date.parse(at) },
    ]);
  });

  test("leaves out meta entries, subagents and broken lines", () => {
    const text = [
      user("injected", { isMeta: true }),
      user("from a subagent", { isSidechain: true }),
      "{not json",
      user([{ type: "text", text: "real" }]),
    ].join("\n");
    expect(parseTranscript(text).map((m) => m.text)).toEqual(["real"]);
  });

  test("a long tool input is cut short", () => {
    const [m] = parseTranscript(
      assistant("m", [
        {
          type: "tool_use",
          name: "Write",
          input: { file_path: "x".repeat(500) },
        },
      ]),
    );
    expect(m.text.length).toBeLessThan(220);
    expect(m.text.endsWith("…)")).toBe(true);
  });
});

describe("tailMessages", () => {
  let dir = "";
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("reads back far enough for the messages asked for", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vibe-os-transcript-"));
    const file = path.join(dir, "t.jsonl");
    const filler = "y".repeat(400_000);
    await writeFile(
      file,
      [
        user("first"),
        assistant("a", [{ type: "text", text: filler }]),
        user("last"),
      ].join("\n"),
    );
    const two = await tailMessages(file, 2);
    expect(two.map((m) => m.role)).toEqual(["assistant", "user"]);
    const three = await tailMessages(file, 3);
    expect(three[0].text).toBe("first");
  });
});
