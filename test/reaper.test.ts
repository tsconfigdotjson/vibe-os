import { describe, expect, test } from "bun:test";
import {
  classifyLeak,
  markerFromEnviron,
  type ProcInfo,
  parseEtime,
  terminate,
} from "../server/reaper.ts";

/**
 * The decision logic is pure so it can be judged here, on synthetic processes,
 * without a /proc — the fixtures below are the real leaks from #38 and #39,
 * pids and paths included, because a classifier that only ever sees inputs
 * invented alongside it tends to agree with itself.
 */

const SESSIONS = "/home/ubuntu/.vibe-os/sessions";

const proc = (over: Partial<ProcInfo>): ProcInfo => ({
  pid: 1234,
  age: 3600,
  args: "sleep 45",
  cwd: null,
  sock: null,
  ...over,
});

const opts = (live: string[] = []) => ({
  sessionsDir: SESSIONS,
  socketExists: (path: string) => live.includes(path),
});

describe("markerFromEnviron", () => {
  test("finds the marker in a NUL-delimited blob", () => {
    const environ = `TERM=xterm-256color\0VIBE_OS_SOCK=${SESSIONS}/vibe-w-1.sock\0HOME=/home/ubuntu\0`;
    expect(markerFromEnviron(environ)).toBe(`${SESSIONS}/vibe-w-1.sock`);
  });

  test("keeps everything after the first equals sign", () => {
    expect(markerFromEnviron("VIBE_OS_SOCK=/a/b=c.sock\0")).toBe("/a/b=c.sock");
  });

  test("is null when absent or empty", () => {
    expect(markerFromEnviron("PATH=/usr/bin\0SHELL=/bin/bash\0")).toBeNull();
    expect(markerFromEnviron("VIBE_OS_SOCK=\0")).toBeNull();
    // A different variable that merely starts the same way is not the marker.
    expect(markerFromEnviron("VIBE_OS_SOCKET=/x.sock\0")).toBeNull();
  });
});

describe("parseEtime", () => {
  const cases: Array<[string, number]> = [
    ["05:32", 5 * 60 + 32],
    ["1:02:03", 3600 + 2 * 60 + 3],
    ["8-00:12:31", 8 * 86400 + 12 * 60 + 31],
    ["77", 77],
    ["   03:04 ", 184],
    ["garbage", 0],
  ];
  for (const [input, seconds] of cases) {
    test(`${JSON.stringify(input)} → ${seconds}s`, () => {
      expect(parseEtime(input)).toBe(seconds);
    });
  }
});

describe("classifyLeak", () => {
  test("a deleted worktree cwd is a leak, at any age", () => {
    // The week-old fly process from #38, verbatim.
    const leak = classifyLeak(
      proc({
        pid: 107466,
        age: 30, // even a young one: teardown kills before it deletes
        args: "fly logs -a webapp-staging",
        cwd: "/home/ubuntu/workspace/.vibe-worktrees/webapp/sunny-violet-dingo (deleted)",
      }),
      opts(),
    );
    expect(leak?.reason).toBe("its worktree was deleted");
  });

  test("a live worktree cwd is not", () => {
    expect(
      classifyLeak(
        proc({
          cwd: "/home/ubuntu/workspace/.vibe-worktrees/webapp/sunny-violet-dingo",
        }),
        opts(),
      ),
    ).toBeNull();
  });

  test("a deleted cwd outside the worktrees is none of our business", () => {
    expect(
      classifyLeak(proc({ cwd: "/home/ubuntu/somewhere (deleted)" }), opts()),
    ).toBeNull();
  });

  test("an inherited marker whose socket is gone is a leak", () => {
    const leak = classifyLeak(
      proc({ sock: `${SESSIONS}/vibe-shy-ruby-quail-1.sock`, age: 9000 }),
      opts(),
    );
    expect(leak?.reason).toBe("its session socket is gone");
  });

  test("but not while the socket exists, and not in another state dir", () => {
    const sock = `${SESSIONS}/vibe-w-1.sock`;
    expect(classifyLeak(proc({ sock, age: 9000 }), opts([sock]))).toBeNull();
    expect(
      classifyLeak(
        proc({ sock: "/somewhere/else/sessions/vibe-w-1.sock", age: 9000 }),
        opts(),
      ),
    ).toBeNull();
  });

  test("a session being born gets its grace period", () => {
    // The create path is `rm -f sock; dtach -n sock …`, so for a moment a
    // young dtach legitimately has no socket.
    const sock = `${SESSIONS}/vibe-w-1.sock`;
    expect(classifyLeak(proc({ sock, age: 5 }), opts())).toBeNull();
    expect(
      classifyLeak(
        proc({ args: `dtach -n ${sock} -E -z /bin/sh -c 'x'`, age: 5 }),
        opts(),
      ),
    ).toBeNull();
  });

  test("a dtach on a dead socket is a leak even without the marker", () => {
    // Sessions created before the marker existed can still be found by argv.
    const leak = classifyLeak(
      proc({
        args: `dtach -n ${SESSIONS}/vibe-w-1.sock -E -z /bin/sh -c 'exec "$SHELL"'`,
        age: 9000,
      }),
      opts(),
    );
    expect(leak?.reason).toBe("its session socket is gone");
    // And so is a client still attached to one.
    expect(
      classifyLeak(
        proc({
          args: `dtach -a ${SESSIONS}/vibe-w-1.sock -E -z -r winch`,
          age: 9000,
        }),
        opts(),
      ),
    ).not.toBeNull();
  });
});

describe("terminate", () => {
  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  test("TERM ends a willing process", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    const signalled = await terminate([child.pid], 1_000);
    expect(signalled).toEqual([child.pid]);
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("KILL ends one that ignores TERM", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", 'trap "" TERM; sleep 30']);
    // Give the shell a moment to install the trap, or TERM wins by racing it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await terminate([child.pid], 300);
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("never signals itself or init", async () => {
    expect(await terminate([0, 1, -5, process.pid], 100)).toEqual([]);
    expect(gone(process.pid)).toBe(false);
  });
});
