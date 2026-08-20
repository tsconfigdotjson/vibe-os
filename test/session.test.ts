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

describe("windowCommand ownership", () => {
  test("stamps VIBE_OS_SOCK on the create, and only the create", () => {
    // The unwrapped form, so the assertion is not fighting flock's quoting.
    const shown = windowCommand("vibe-w-1", "/tmp", config(), null, {
      forDisplay: true,
    }) as string;
    // On the create: everything the session ever starts inherits the marker,
    // which is what killSession and the reaper kill and find by.
    expect(shown).toContain(
      "VIBE_OS_SOCK='/var/lib/vibe-os/sessions/vibe-w-1.sock' dtach -n",
    );
    // Not on the attach: a client is a view, not an owner, and marking it
    // would hand the session's name to every ssh login that ever looked in.
    const attachIdx = shown.indexOf("exec dtach -a");
    expect(attachIdx).toBeGreaterThan(-1);
    expect(shown.slice(attachIdx)).not.toContain("VIBE_OS_SOCK");
  });

  test("the marker survives the locking wrapper", () => {
    const real = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(real).toContain("VIBE_OS_SOCK=");
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

/**
 * The pty's baud rate, which is not cosmetic.
 *
 * SSH carries ispeed and ospeed in its pty-req, and the browser's Go client
 * sends 14400 — a rate Linux cannot encode. sshd writes it in raw, so the pty
 * reads back a speed that cannot be written again, and the first program to do
 * an ordinary tcgetattr/tcsetattr raw-mode dance gets EINVAL. Hermes died there
 * before painting anything; Claude survived only because Node swallows it.
 */
describe("terminal speed", () => {
  test("the created session normalises the pty speed", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(cmd).toContain("stty 38400");
  });

  /**
   * It has to be inside the string dtach runs, not beside it. That is the pty
   * the harness runs on; fixing any other one fixes nothing.
   */
  test("it is set on the session, not on the attachment", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    const create = cmd.slice(cmd.indexOf("dtach -n"));
    const attach = create.slice(create.indexOf("exec dtach -a"));
    expect(create).toContain("stty 38400");
    expect(attach).not.toContain("stty 38400");
  });

  /** Before the harness, or the harness has already read the broken value. */
  test("it runs before the harness starts", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config(), {
      id: "p",
      projectId: "x",
      color: "cyan",
      name: "R",
      harness: "hermes",
      command: null,
      args: [],
      prompt: "",
      position: 0,
      createdAt: 0,
    }) as string;
    expect(cmd.indexOf("stty 38400")).toBeLessThan(cmd.indexOf("hermes"));
  });

  /** A box with no stty should still open a window. */
  test("a missing stty is not fatal", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config()) as string;
    expect(cmd).toContain("stty 38400 2>/dev/null;");
  });
});
