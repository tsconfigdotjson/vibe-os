// Reading a Claude window's conversation from its transcript.
//
// Claude writes every turn to `<projects>/<cwd>/<sessionId>.jsonl`, one JSON
// object a line. The session id is in the registry of the Claude running in
// the window, or, for a hibernated window, in its resume marker. Loaded lazily
// by the adapter in claude.ts: this pulls in hibernate.ts, which is downstream
// of the harness table.

import { open, readFile } from "node:fs/promises";
import type { TranscriptMessage } from "../../shared/wire.ts";
import { findTranscript, readRegistry } from "../hibernate.ts";
import { sessionProcesses } from "../reaper.ts";
import { resumeMarker } from "../session.ts";

/** How much of the end of a transcript to read first, and the most read. */
const FIRST_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** Longest a tool call's input is shown. */
const TOOL_INPUT_CHARS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The conversation running in a window, or the one it hibernated on. */
async function sessionIdFor(sock: string): Promise<string | null> {
  for (const pid of await sessionProcesses(sock).catch(() => [])) {
    const registry = await readRegistry(pid);
    if (registry) return registry.sessionId;
  }
  const marker = (await readFile(resumeMarker(sock), "utf8").catch(() => ""))
    .trim()
    .toLowerCase();
  return UUID.test(marker) ? marker : null;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface Entry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { id?: string; role?: string; content?: string | Block[] };
}

/** A tool call as one short line: its name, then its input. */
function toolLine(block: Block): string {
  const input = block.input as Record<string, unknown> | undefined;
  // The field that says what the call is about, for the tools that have one.
  const main =
    input &&
    ["command", "file_path", "pattern", "url", "query", "description", "prompt"]
      .map((k) => input[k])
      .find((v) => typeof v === "string");
  const detail =
    typeof main === "string" ? main : input ? JSON.stringify(input) : "";
  const short =
    detail.length > TOOL_INPUT_CHARS
      ? `${detail.slice(0, TOOL_INPUT_CHARS)}…`
      : detail;
  return `${block.name ?? "tool"}(${short.replace(/\s+/g, " ")})`;
}

/**
 * The messages in a stretch of transcript, oldest first.
 *
 * User text and assistant text become one message each, and each tool call one
 * `tool` message. Tool results, thinking, sidechains (subagents) and the
 * entries Claude marks as meta are left out. Claude writes one assistant reply
 * as several lines sharing a message id, one per block, so those are joined.
 */
export function parseTranscript(text: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let lastAssistantId: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isMeta || entry.isSidechain) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    const when = Number.isFinite(at) ? at : null;
    const content = entry.message?.content;
    const blocks: Block[] =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? content
          : [];

    if (entry.type === "user") {
      lastAssistantId = null;
      const said = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n")
        .trim();
      if (said) out.push({ role: "user", text: said, at: when });
      continue;
    }

    const id = entry.message?.id ?? null;
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        const prev = out[out.length - 1];
        if (id !== null && id === lastAssistantId && prev?.role === "assistant")
          prev.text = `${prev.text}\n${block.text}`.trim();
        else if (block.text.trim())
          out.push({ role: "assistant", text: block.text.trim(), at: when });
      } else if (block.type === "tool_use") {
        out.push({ role: "tool", text: toolLine(block), at: when });
      }
    }
    lastAssistantId = id;
  }
  return out;
}

/**
 * The last `last` messages of a transcript.
 *
 * Read from the end, a growing stretch at a time, since a long conversation's
 * transcript runs to many megabytes and only its tail is wanted.
 */
export async function tailMessages(
  file: string,
  last: number,
): Promise<TranscriptMessage[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    for (let want = FIRST_READ_BYTES; ; want *= 4) {
      const length = Math.min(size, want, MAX_READ_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      let text = buf.toString("utf8");
      // The first line is cut in half unless the read began at the start.
      if (length < size) text = text.slice(text.indexOf("\n") + 1);
      const found = parseTranscript(text);
      if (found.length >= last || length >= size || length >= MAX_READ_BYTES)
        return found.slice(-last);
    }
  } finally {
    await handle.close();
  }
}

/** A Claude window's last messages, or null when its transcript is not found. */
export async function claudeMessages(
  window: { sock: string; cwd: string },
  last: number,
): Promise<TranscriptMessage[] | null> {
  const id = await sessionIdFor(window.sock);
  if (!id) return null;
  const file = await findTranscript(id, window.cwd);
  if (!file) return null;
  return tailMessages(file, last);
}
