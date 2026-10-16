import { describe, expect, test } from "bun:test";
import { parseSshdConfig } from "../server/doctor.ts";
import {
  display,
  hasLoginKey,
  installCommands,
  packagesFor,
  parseTailscaleStatus,
  passwordLoginOn,
  serveCovers,
  servicePlan,
} from "../server/setup.ts";
import { type UnitFlags, unitFlags } from "../server/unit.ts";

describe("packagesFor", () => {
  test("maps commands to each distro's package names", () => {
    expect(packagesFor(["sshd", "ssh-keygen", "dtach"], "apt")).toEqual([
      "openssh-server",
      "openssh-client",
      "dtach",
    ]);
    expect(packagesFor(["ssh-keygen", "gh"], "dnf")).toEqual([
      "openssh-clients",
      "gh",
    ]);
  });

  test("collapses openssh to one package on Arch", () => {
    expect(
      packagesFor(["sshd", "ssh-keygen", "ssh-keyscan", "gh"], "pacman"),
    ).toEqual(["openssh", "github-cli"]);
  });
});

describe("installCommands", () => {
  test("apt updates first and stays non-interactive through sudo", () => {
    expect(installCommands("apt", ["dtach"])).toEqual([
      ["apt-get", "update"],
      [
        "env",
        "DEBIAN_FRONTEND=noninteractive",
        "apt-get",
        "install",
        "-y",
        "dtach",
      ],
    ]);
  });

  test("pacman skips what is already there", () => {
    expect(installCommands("pacman", ["git"])).toEqual([
      ["pacman", "-S", "--needed", "--noconfirm", "git"],
    ]);
  });
});

describe("display", () => {
  test("quotes only what a shell would split or expand", () => {
    expect(display(["sh", "-c", "curl -fsSL https://x/i.sh | bash"])).toBe(
      "sh -c 'curl -fsSL https://x/i.sh | bash'",
    );
    expect(display(["ufw", "allow", "41641/udp"])).toBe("ufw allow 41641/udp");
    expect(display(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
  });
});

describe("unitFlags", () => {
  const unit = (exec: string) =>
    `[Service]\nUser=ubuntu\nExecStart=${exec}\nRestart=on-failure\n`;

  test("reads the port, host and an explicit token", () => {
    expect(
      unitFlags(
        unit("vibe-os start --port 7681 --host 127.0.0.1 --token hunter2"),
      ),
    ).toEqual({
      port: 7681,
      host: "127.0.0.1",
      token: "hunter2",
      domain: null,
    });
  });

  test("an empty --token means the remembered one", () => {
    // What the VPS this runs on actually has.
    expect(
      unitFlags(unit("vibe-os start --port 7681 --host 127.0.0.1 --token=")),
    ).toEqual({
      port: 7681,
      host: "127.0.0.1",
      token: undefined,
      domain: null,
    });
    expect(unitFlags(unit("vibe-os start --token --port=80")).token).toBe(
      undefined,
    );
  });

  test("--no-token is no token at all", () => {
    expect(unitFlags(unit("vibe-os start --no-token")).token).toBe(null);
  });

  test("no flags leaves every field unset", () => {
    expect(unitFlags(unit("/usr/local/bin/vibe-os start"))).toEqual({
      port: null,
      host: null,
      token: undefined,
      domain: null,
    });
  });

  test("reads the domain of a public box", () => {
    // What the VPS this runs on has now.
    expect(
      unitFlags(
        unit(
          "/usr/local/bin/vibe-os start --host :: --domain vps-a272961f.vps.ovh.ca --token= --hibernate-after 5",
        ),
      ),
    ).toEqual({
      port: null,
      host: "::",
      token: undefined,
      domain: "vps-a272961f.vps.ovh.ca",
    });
    expect(
      unitFlags(unit("vibe-os start --domain=box.example.com")).domain,
    ).toBe("box.example.com");
  });
});

describe("passwordLoginOn", () => {
  test("off only when both password and keyboard-interactive are off", () => {
    const on = parseSshdConfig(
      "passwordauthentication yes\nkbdinteractiveauthentication no\n",
    );
    const off = parseSshdConfig(
      "passwordauthentication no\nkbdinteractiveauthentication no\n",
    );
    const kbd = parseSshdConfig(
      "passwordauthentication no\nkbdinteractiveauthentication yes\n",
    );
    expect(passwordLoginOn(on)).toBe(true);
    expect(passwordLoginOn(off)).toBe(false);
    expect(passwordLoginOn(kbd)).toBe(true);
  });

  test("an sshd too old to print kbdinteractive is judged on passwords", () => {
    expect(
      passwordLoginOn(parseSshdConfig("passwordauthentication no\n")),
    ).toBe(false);
  });
});

describe("hasLoginKey", () => {
  test("a plain public key counts", () => {
    expect(hasLoginKey("ssh-ed25519 AAAAC3Nza lee@laptop\n")).toBe(true);
    expect(
      hasLoginKey('from="100.64.0.0/10" ssh-ed25519 AAAAC3Nza lee@laptop'),
    ).toBe(true);
  });

  test("vibe-os's own CA line, comments and blanks do not", () => {
    expect(
      hasLoginKey(
        "# keys\n\ncert-authority ssh-ed25519 AAAAC3Nza vibe-os-ca@box\n",
      ),
    ).toBe(false);
    expect(hasLoginKey("")).toBe(false);
  });
});

describe("parseTailscaleStatus", () => {
  test("reads the backend state, name and IPv4 address", () => {
    const json = JSON.stringify({
      BackendState: "Running",
      Self: {
        DNSName: "vibe-os.tail76dd79.ts.net.",
        TailscaleIPs: ["fd7a:115c:a1e0::1", "100.96.101.46"],
      },
    });
    expect(parseTailscaleStatus(json)).toEqual({
      running: true,
      dnsName: "vibe-os.tail76dd79.ts.net",
      ip: "100.96.101.46",
    });
  });

  test("logged out, or unreadable, is not running", () => {
    expect(
      parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin" }))
        .running,
    ).toBe(false);
    expect(parseTailscaleStatus("").running).toBe(false);
  });
});

describe("serveCovers", () => {
  const status = `https://vibe-os.tail76dd79.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:7681
`;

  test("matches the proxied port and no other", () => {
    expect(serveCovers(status, 7681)).toBe(true);
    expect(serveCovers(status, 768)).toBe(false);
    expect(serveCovers(status, 8080)).toBe(false);
    expect(serveCovers("No serve config\n", 7681)).toBe(false);
  });
});

describe("servicePlan", () => {
  const unit = (patch: Partial<UnitFlags> = {}): UnitFlags => ({
    port: null,
    host: null,
    token: undefined,
    domain: null,
    ...patch,
  });

  test("a fresh private box goes on loopback 7681", () => {
    expect(servicePlan(null, {}, null)).toEqual({
      port: 7681,
      host: "127.0.0.1",
      keep: false,
    });
  });

  test("a fresh public box goes on every address, port 80", () => {
    expect(servicePlan(null, {}, "box.example.com")).toEqual({
      port: 80,
      host: "::",
      keep: false,
    });
  });

  test("the public box this runs on is kept as it is", () => {
    // ExecStart=vibe-os start --host :: --domain vps-a272961f.vps.ovh.ca --token= --hibernate-after 5
    expect(
      servicePlan(
        unit({ host: "::", domain: "vps-a272961f.vps.ovh.ca" }),
        {},
        "vps-a272961f.vps.ovh.ca",
      ),
    ).toEqual({ port: 80, host: "::", keep: true });
  });

  test("a private box set up by hand is kept, on its own flags", () => {
    expect(
      servicePlan(unit({ port: 7681, host: "127.0.0.1" }), {}, null),
    ).toEqual({ port: 7681, host: "127.0.0.1", keep: true });
  });

  test("moving a private box to a domain replaces the unit", () => {
    expect(
      servicePlan(
        unit({ port: 7681, host: "127.0.0.1" }),
        {},
        "box.example.com",
      ),
    ).toEqual({ port: 80, host: "::", keep: false });
  });

  test("a different domain replaces it", () => {
    expect(
      servicePlan(
        unit({ host: "::", domain: "old.example.com" }),
        {},
        "box.example.com",
      ).keep,
    ).toBe(false);
  });

  test("an explicit --port or --host that differs replaces it", () => {
    expect(
      servicePlan(unit({ port: 7681, host: "127.0.0.1" }), { port: 8080 }, null)
        .keep,
    ).toBe(false);
    expect(
      servicePlan(
        unit({ host: "::", domain: "b.example" }),
        { host: "0.0.0.0" },
        "b.example",
      ),
    ).toEqual({ port: 80, host: "0.0.0.0", keep: false });
  });
});
