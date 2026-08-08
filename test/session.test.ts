import { describe, expect, test } from "bun:test";
import type { Config } from "../server/config.ts";
import { shellQuote, windowCommand } from "../server/session.ts";

const config = (over: Partial<Config> = {}) =>
  ({ sessions: true, stateDir: "/var/lib/vibe-os", ...over }) as Config;

describe("shellQuote", () => {
  const cases = [
    "plain",
    "with space",
    "it's",
    'say "hi"',
    "semi; colon",
    "$(whoami)",
    "`id`",
    "back\\slash",
    "new\nline",
    "",
  ];

  for (const value of cases) {
    test(`round-trips ${JSON.stringify(value)} through sh`, async () => {
      // The only definition of "quoted correctly" that matters is what a real
      // shell does with it.
      const proc = Bun.spawn(
        ["/bin/sh", "-c", `printf %s ${shellQuote(value)}`],
        {
          stdout: "pipe",
        },
      );
      expect(await new Response(proc.stdout).text()).toBe(value);
    });
  }
});

describe("windowCommand", () => {
  test("is undefined when sessions are off", () => {
    expect(windowCommand("vibe-w-1", "/tmp", config({ sessions: false }))).toBe(
      undefined,
    );
  });

  test("is valid shell even with spaces in every path", async () => {
    const cmd = windowCommand(
      "vibe-my ws-1",
      "/home/vibe/work spaces/repo",
      config({ stateDir: "/var/lib/vibe os" }),
    );
    expect(cmd).toBeString();
    const proc = Bun.spawn(["/bin/sh", "-n"], {
      stdin: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(cmd as string);
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("serialises the create so two logins cannot both take the branch", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    // Probe-or-create must sit inside the lock; the attach must sit outside it,
    // because holding the lock for the life of the session would block everyone.
    expect(cmd).toContain("flock");
    const lockIdx = cmd.indexOf("flock");
    const attachIdx = cmd.indexOf("exec dtach -a");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeGreaterThan(lockIdx);
    expect(cmd.slice(lockIdx, attachIdx)).toContain("dtach -n");
  });

  /**
   * The lock must not outlive the critical section.
   *
   * flock holds its lock on a file descriptor, and descriptors survive fork and
   * exec — so without `-o` the daemonised `dtach -n` inherited it and held the
   * lock for the life of the session, making every later login block forever.
   * This is a one-character mistake with a symptom (a terminal that hangs just
   * after "host key trusted") that points nowhere near the cause.
   */
  test("closes the lock descriptor so the session cannot inherit it", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(cmd).toContain("flock -o ");
  });

  test("still works where flock is absent", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(cmd).toContain("command -v flock");
    expect(cmd).toContain("else");
  });

  test("tells the program what the terminal can do", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(cmd).toContain("TERM=xterm-256color");
    expect(cmd).toContain("COLORTERM=truecolor");
  });
});

describe("windowCommand forDisplay", () => {
  test("drops the locking wrapper but keeps what actually runs", () => {
    const shown = windowCommand("vibe-w-1", "/tmp", config(), null, {
      forDisplay: true,
    }) as string;
    expect(shown).not.toContain("flock");
    expect(shown).not.toContain("command -v");
    expect(shown).toContain("dtach -n");
    expect(shown).toContain("exec dtach -a");
  });

  test("is still valid shell", async () => {
    const shown = windowCommand("vibe-w-1", "/tmp", config(), null, {
      forDisplay: true,
    }) as string;
    const proc = Bun.spawn(["/bin/sh", "-n"], {
      stdin: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(shown);
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("the real command still locks", () => {
    const real = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(real).toContain("flock");
  });
});
