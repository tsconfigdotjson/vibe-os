import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { killSession } from "../server/attach.ts";
import type { Config } from "../server/config.ts";
import {
  knownHostsName,
  parseRaw,
  pasteBytes,
  sendText,
  sshArgs,
} from "../server/headless.ts";
import type { Profile } from "../server/profiles.ts";
import { windowCommand } from "../server/session.ts";

describe("pasteBytes", () => {
  test("wraps text in bracketed-paste markers", () => {
    expect(pasteBytes("hello")).toBe("\x1b[200~hello\x1b[201~");
  });

  test("sends newlines as carriage returns, like a terminal", () => {
    expect(pasteBytes("a\nb\r\nc")).toBe("\x1b[200~a\rb\rc\x1b[201~");
  });

  test("cannot close the paste early", () => {
    expect(pasteBytes("x\x1b[201~rm -rf ~\n")).toBe(
      "\x1b[200~xrm -rf ~\r\x1b[201~",
    );
  });
});

describe("parseRaw", () => {
  test("reads Linux stty output", () => {
    expect(parseRaw("isig -icanon iexten -echo echoe")).toBe(true);
    expect(parseRaw("isig icanon iexten echo echoe")).toBe(false);
  });

  test("reads macOS stty output", () => {
    expect(parseRaw("lflags: -icanon -isig -iexten -echo")).toBe(true);
  });

  test("is null for anything else", () => {
    expect(parseRaw("")).toBe(null);
  });
});

describe("the headless login", () => {
  const config = {
    user: "vibe",
    sshHost: "127.0.0.1",
    sshPort: 2222,
  } as Config;

  test("names a non-standard port the way known_hosts does", () => {
    expect(knownHostsName("127.0.0.1", 22)).toBe("127.0.0.1");
    expect(knownHostsName("127.0.0.1", 2222)).toBe("[127.0.0.1]:2222");
  });

  test("pins the host key when there is one", () => {
    const args = sshArgs(config, "/k/id", "/k/known_hosts");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=/k/known_hosts");
    expect(args).toContain("CertificateFile=/k/id-cert.pub");
    expect(args.slice(-3)).toEqual(["-p", "2222", "vibe@127.0.0.1"]);
  });

  test("runs no command of its own and asks no questions", () => {
    const args = sshArgs(config, "/k/id", null);
    expect(args).toContain("-T");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=no");
  });
});

describe("windowCommand, detached", () => {
  const config = {
    sessions: true,
    stateDir: "/var/lib/vibe-os",
    memory: { high: null, max: null, swapMax: null },
  } as Config;

  test("creates without attaching, at a real size", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config, null, {
      detached: true,
    }) as string;
    expect(cmd).toContain("dtach -n");
    expect(cmd).not.toContain("dtach -a");
    expect(cmd).toContain("rows 40 cols 120");
  });

  test("leaves the attaching command alone", () => {
    const cmd = windowCommand("vibe-w-1", "/tmp", config) as string;
    expect(cmd).toContain("dtach -a");
    expect(cmd).not.toContain("rows 40");
  });
});

const hasDtach =
  spawnSync("sh", ["-c", "command -v dtach"]).status === 0 &&
  process.platform !== "win32";

describe.skipIf(!hasDtach)("sendText, end to end", () => {
  // Under /tmp, not os.tmpdir(): a unix socket path has to fit in about a
  // hundred bytes, and macOS's per-user temp dir is most of that already.
  let dir = "";
  const session = "vibe-send-test-1";

  afterAll(async () => {
    if (!dir) return;
    await killSession({ stateDir: dir } as Config, session);
    await rm(dir, { recursive: true, force: true });
  });

  test("pastes into a program once it is reading keys", async () => {
    dir = await mkdtemp("/tmp/vos-");
    const out = path.join(dir, "out");
    const config = {
      sessions: true,
      stateDir: dir,
      memory: { high: null, max: null, swapMax: null },
    } as Config;
    // A program that takes the terminal raw after a pause, like a harness
    // loading, and records every byte it is given.
    const profile = {
      harness: "custom",
      command: "sh",
      args: ["-c", `sleep 1; stty raw -echo; exec cat > ${out}`],
    } as unknown as Profile;

    const cmd = windowCommand(session, dir, config, profile, {
      detached: true,
    }) as string;
    expect(spawnSync("/bin/sh", ["-c", cmd]).status).toBe(0);

    await sendText(config, session, "fix it\nplease", {
      submit: true,
      timeoutMs: 10_000,
    });
    // cat is unbuffered to a file only per read, so give it a moment.
    await Bun.sleep(300);
    expect(await readFile(out, "utf8")).toBe(
      "\x1b[200~fix it\rplease\x1b[201~\r",
    );
  }, 20_000);
});
