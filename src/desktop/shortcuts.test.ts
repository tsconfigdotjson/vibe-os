import { describe, expect, test } from "bun:test";
import { type KeyLike, type ShortcutMode, step } from "./useShortcuts";

const key = (
  k: string,
  code: string,
  mods: Partial<KeyLike> = {},
): KeyLike => ({
  key: k,
  code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

const LEADER = key("`", "Backquote", { ctrlKey: true });

/** Feeds keys from idle and returns every step taken. */
function run(...keys: KeyLike[]) {
  let mode: ShortcutMode = "idle";
  return keys.map((k) => {
    const next = step(mode, k);
    mode = next.mode;
    return next;
  });
}

describe("idle", () => {
  test("passes ordinary keys and control chords through", () => {
    for (const k of [
      key("a", "KeyA"),
      key("c", "KeyC", { ctrlKey: true }),
      key("`", "Backquote"),
      key("~", "Backquote", { ctrlKey: true, shiftKey: true }),
    ]) {
      expect(step("idle", k)).toEqual({ mode: "idle", swallow: false });
    }
  });

  test("the leader arms, matched by physical key", () => {
    expect(step("idle", LEADER)).toEqual({ mode: "armed", swallow: true });
    // A layout where that key types a caret.
    expect(step("idle", key("^", "Backquote", { ctrlKey: true })).mode).toBe(
      "armed",
    );
  });
});

describe("armed", () => {
  test("a digit picks a window by its number", () => {
    const [, picked] = run(LEADER, key("3", "Digit3"));
    expect(picked).toEqual({
      mode: "idle",
      command: { kind: "window", idx: 3 },
      swallow: true,
    });
  });

  test("arrows move between windows and workspaces", () => {
    expect(run(LEADER, key("ArrowRight", "ArrowRight"))[1].command).toEqual({
      kind: "cycle",
      step: 1,
    });
    expect(run(LEADER, key("ArrowUp", "ArrowUp"))[1].command).toEqual({
      kind: "workspace",
      step: -1,
    });
  });

  test("letters, with caps lock or shift held", () => {
    expect(run(LEADER, key("m", "KeyM"))[1].command).toEqual({
      kind: "minimize",
    });
    expect(
      run(LEADER, key("T", "KeyT", { shiftKey: true }))[1].command,
    ).toEqual({ kind: "spawn" });
  });

  test("a bare modifier keeps it armed", () => {
    const steps = run(LEADER, key("Shift", "ShiftLeft"), key("f", "KeyF"));
    expect(steps[1]).toEqual({ mode: "armed", swallow: true });
    expect(steps[2].command).toEqual({ kind: "maximize" });
  });

  test("unknown keys are swallowed and disarm", () => {
    expect(run(LEADER, key("q", "KeyQ"))[1]).toEqual({
      mode: "idle",
      command: undefined,
      swallow: true,
    });
  });

  test("the leader again or escape backs out", () => {
    expect(run(LEADER, LEADER)[1]).toEqual({ mode: "idle", swallow: true });
    expect(run(LEADER, key("Escape", "Escape"))[1]).toEqual({
      mode: "idle",
      swallow: true,
    });
  });
});

describe("profile", () => {
  test("p then a digit opens that profile, counting from one", () => {
    const steps = run(LEADER, key("p", "KeyP"), key("2", "Digit2"));
    expect(steps[1]).toEqual({ mode: "profile", swallow: true });
    expect(steps[2].command).toEqual({ kind: "profile", index: 1 });
  });

  test("anything else backs out", () => {
    expect(run(LEADER, key("p", "KeyP"), key("x", "KeyX"))[2]).toEqual({
      mode: "idle",
      swallow: true,
    });
  });

  test("digits on a layout that shifts them still count", () => {
    // AZERTY: the 2 key types é unshifted.
    expect(
      run(LEADER, key("p", "KeyP"), key("é", "Digit2"))[2].command,
    ).toEqual({ kind: "profile", index: 1 });
  });
});
