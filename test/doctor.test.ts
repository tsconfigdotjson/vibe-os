import { describe, expect, test } from "bun:test";
import {
  authorizedKeysPaths,
  dockerPublishesLocally,
  exposureCheck,
  type FirewallState,
  firewallCheck,
  parseNftOrIptables,
  parseUfw,
} from "../server/doctor.ts";

/**
 * Firewall parsing, against real output.
 *
 * The fixtures below are copied verbatim from the VPS this project runs on and
 * from a box with the rules missing — a parser that only ever sees output
 * invented alongside it tends to agree with itself.
 *
 * These check *configuration*, which is not the same as reachability. Nothing
 * running on a machine can prove a port is shut from the outside, and nothing
 * here claims to.
 */

const UFW_CONFIGURED = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
Anywhere on tailscale0     ALLOW IN    Anywhere
41641/udp                  ALLOW IN    Anywhere
Anywhere (v6) on tailscale0 ALLOW IN    Anywhere (v6)
41641/udp (v6)             ALLOW IN    Anywhere (v6)
`;

const UFW_INACTIVE = `Status: inactive
`;

const UFW_ALLOW_BY_DEFAULT = `Status: active
Logging: on (low)
Default: allow (incoming), allow (outgoing), disabled (routed)
New profiles: skip
`;

const UFW_NO_TAILNET = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
`;

describe("parseUfw", () => {
  test("reads a correctly configured box", () => {
    expect(parseUfw(UFW_CONFIGURED)).toEqual({
      active: true,
      defaultDeny: true,
      tailnetAllowed: true,
      directUdpAllowed: true,
      open: { ssh: false, http: false, https: false },
    });
  });

  test("notices it is switched off", () => {
    expect(parseUfw(UFW_INACTIVE).active).toBe(false);
  });

  test("notices incoming is allowed by default", () => {
    const r = parseUfw(UFW_ALLOW_BY_DEFAULT);
    expect(r.active).toBe(true);
    expect(r.defaultDeny).toBe(false);
  });

  test("notices the tailnet and direct-UDP rules are missing", () => {
    const r = parseUfw(UFW_NO_TAILNET);
    expect(r.defaultDeny).toBe(true);
    expect(r.tailnetAllowed).toBe(false);
    expect(r.directUdpAllowed).toBe(false);
  });

  test("an empty or unreadable status is not a pass", () => {
    for (const text of ["", "ERROR: You need to be root", "\n\n"]) {
      const r = parseUfw(text);
      expect(r.active).toBe(false);
      expect(r.defaultDeny).toBe(false);
    }
  });
});

const IPTABLES = `-P INPUT DROP
-P FORWARD DROP
-P OUTPUT ACCEPT
-N ufw-user-input
-A ufw-user-input -i tailscale0 -j ACCEPT
-A ufw-user-input -p udp -m udp --dport 41641 -j ACCEPT
`;

const IPTABLES_OPEN = `-P INPUT ACCEPT
-P FORWARD ACCEPT
-P OUTPUT ACCEPT
`;

const NFT = `table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "tailscale0" accept
    udp dport 41641 accept
  }
}
`;

describe("parseNftOrIptables", () => {
  test("reads iptables from a configured box", () => {
    expect(parseNftOrIptables(IPTABLES)).toEqual({
      active: true,
      defaultDeny: true,
      tailnetAllowed: true,
      directUdpAllowed: true,
      open: { ssh: false, http: false, https: false },
    });
  });

  test("reads the nftables spelling of the same rules", () => {
    expect(parseNftOrIptables(NFT)).toEqual({
      active: true,
      defaultDeny: true,
      tailnetAllowed: true,
      directUdpAllowed: true,
      open: { ssh: false, http: false, https: false },
    });
  });

  test("an accept-by-default ruleset is not a pass", () => {
    const r = parseNftOrIptables(IPTABLES_OPEN);
    expect(r.defaultDeny).toBe(false);
    expect(r.tailnetAllowed).toBe(false);
  });

  test("a chain named for tailscale is not an allow rule for it", () => {
    // `-N` declares a chain; only `-A … -j ACCEPT` permits anything.
    const r = parseNftOrIptables("-P INPUT DROP\n-N ts-input\n");
    expect(r.defaultDeny).toBe(true);
    expect(r.tailnetAllowed).toBe(false);
  });

  test("nothing readable is not a pass", () => {
    const r = parseNftOrIptables("");
    expect(r.active).toBe(false);
    expect(r.defaultDeny).toBe(false);
  });
});

/** Copied from the VPS this project runs on, after it went public. */
const UFW_PUBLIC = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), deny (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
Anywhere on tailscale0     ALLOW IN    Anywhere                  
41641/udp                  ALLOW IN    Anywhere                  
22/tcp                     LIMIT IN    Anywhere                  
80/tcp                     ALLOW IN    Anywhere                  
443/tcp                    ALLOW IN    Anywhere                  
Anywhere (v6) on tailscale0 ALLOW IN    Anywhere (v6)             
41641/udp (v6)             ALLOW IN    Anywhere (v6)             
22/tcp (v6)                LIMIT IN    Anywhere (v6)             
80/tcp (v6)                ALLOW IN    Anywhere (v6)             
443/tcp (v6)               ALLOW IN    Anywhere (v6)             
`;

/** The same box's iptables and nftables views of those rules. */
const IPTABLES_PUBLIC = `-P INPUT DROP
-A ufw-user-input -p tcp -m tcp --dport 22 -m conntrack --ctstate NEW -m recent --set --name DEFAULT --mask 255.255.255.255 --rsource
-A ufw-user-input -p tcp -m tcp --dport 22 -m conntrack --ctstate NEW -m recent --update --seconds 30 --hitcount 6 --name DEFAULT --mask 255.255.255.255 --rsource -j ufw-user-limit
-A ufw-user-input -p tcp -m tcp --dport 22 -j ufw-user-limit-accept
-A ufw-user-input -p tcp -m tcp --dport 80 -j ACCEPT
-A ufw-user-input -p tcp -m tcp --dport 443 -j ACCEPT
`;

const NFT_PUBLIC = `table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
\t\ttcp dport 22 counter packets 17 bytes 972 jump ufw-user-limit-accept
\t\ttcp dport 80 counter packets 6469 bytes 332652 accept
\t\ttcp dport 443 counter packets 6567 bytes 338564 accept
  }
}
`;

describe("open ports", () => {
  const all = { ssh: true, http: true, https: true };

  test("ufw on a public box, LIMIT counting as open", () => {
    expect(parseUfw(UFW_PUBLIC).open).toEqual(all);
    expect(parseUfw(UFW_PUBLIC).tailnetAllowed).toBe(true);
  });

  test("ufw's other spellings: a bare port, a list, a range", () => {
    const rules = (line: string) =>
      parseUfw(`Status: active\nTo  Action  From\n${line}\n`).open;
    expect(rules("80                         ALLOW IN    Anywhere")).toEqual({
      ssh: false,
      http: true,
      https: false,
    });
    expect(rules("80,443/tcp                 ALLOW IN    Anywhere")).toEqual({
      ssh: false,
      http: true,
      https: true,
    });
    expect(rules("1:1000/tcp                 ALLOW IN    Anywhere")).toEqual(
      all,
    );
  });

  test("a deny rule and a udp rule do not open a tcp port", () => {
    const r = parseUfw(
      "Status: active\n80/tcp  DENY IN  Anywhere\n443/udp  ALLOW IN  Anywhere\n",
    );
    expect(r.open).toEqual({ ssh: false, http: false, https: false });
  });

  test("iptables and nftables on a public box", () => {
    expect(parseNftOrIptables(IPTABLES_PUBLIC).open).toEqual(all);
    expect(parseNftOrIptables(NFT_PUBLIC).open).toEqual(all);
    expect(parseNftOrIptables("tcp dport { 80, 443 } accept\n").open).toEqual({
      ssh: false,
      http: true,
      https: true,
    });
  });

  test("a rule for one source does not open the port to everyone", () => {
    expect(
      parseUfw(
        "Status: active\n443/tcp                    ALLOW IN    10.0.0.0/8\n",
      ).open.https,
    ).toBe(false);
    expect(
      parseNftOrIptables(
        "-A ufw-user-input -s 10.0.0.0/8 -p tcp -m tcp --dport 443 -j ACCEPT\n",
      ).open.https,
    ).toBe(false);
    expect(
      parseNftOrIptables("ip saddr 10.0.0.0/8 tcp dport 443 accept\n").open
        .https,
    ).toBe(false);
  });

  test("iptables multiport", () => {
    expect(
      parseNftOrIptables(
        "-A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT\n",
      ).open,
    ).toEqual({ ssh: false, http: true, https: true });
  });

  test("a port counted but not accepted is not open", () => {
    expect(
      parseNftOrIptables("tcp dport 80 counter packets 1 bytes 2 drop\n").open
        .http,
    ).toBe(false);
  });
});

describe("firewallCheck", () => {
  const fw = (patch: Partial<FirewallState> = {}): FirewallState => ({
    tool: "ufw",
    active: true,
    defaultDeny: true,
    tailnetAllowed: false,
    directUdpAllowed: false,
    open: { ssh: true, http: true, https: true },
    unreadable: false,
    ...patch,
  });

  test("a public box with 22, 80 and 443 open passes, with no word of Tailscale", () => {
    const c = firewallCheck(fw(), "box.example.com");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("80 and 443 allowed");
    expect(c.detail).not.toContain("tailnet");
  });

  test("a public box names each port it is missing, and why", () => {
    const c = firewallCheck(
      fw({ open: { ssh: false, http: false, https: false } }),
      "box.example.com",
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("Let's Encrypt");
    expect(c.detail).toContain("443/tcp closed");
    expect(c.detail).toContain("nothing can ssh in");
    expect(c.fix).toContain("ufw allow 443/tcp");
  });

  test("a public box with the tailnet allowed does not need 22", () => {
    const c = firewallCheck(
      fw({
        tailnetAllowed: true,
        open: { ssh: false, http: true, https: true },
      }),
      "box.example.com",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("and the tailnet");
  });

  test("a tailnet box still wants the tailnet rules", () => {
    expect(firewallCheck(fw(), null).ok).toBe(false);
    expect(
      firewallCheck(fw({ tailnetAllowed: true, directUdpAllowed: true }), null)
        .ok,
    ).toBe(true);
  });

  test("off or allow-by-default fails either way, with that way's rules", () => {
    const off = firewallCheck(fw({ active: false }), "box.example.com");
    expect(off.ok).toBe(false);
    expect(off.fix).toContain("443/tcp");
    expect(firewallCheck(fw({ active: false }), null).fix).toContain(
      "tailscale0",
    );
    expect(firewallCheck(fw({ defaultDeny: false }), null).ok).toBe(false);
  });
});

describe("exposureCheck", () => {
  const box = {
    token: true,
    host: "::",
    domain: "box.example.com" as string | null,
    tailnet: null as string | null,
  };

  test("public with a token is fine, and says where", () => {
    const c = exposureCheck(box);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("https://box.example.com");
  });

  test("public with no token is fatal", () => {
    const c = exposureCheck({ ...box, token: false });
    expect(c.ok).toBe(false);
    expect(c.fatal).toBe(true);
  });

  test("the tailnet cases are as before", () => {
    expect(
      exposureCheck({ ...box, domain: null, tailnet: "100.1.2.3" }).detail,
    ).toContain("Tailscale is up");
    expect(
      exposureCheck({ ...box, domain: null, token: false, host: "127.0.0.1" })
        .ok,
    ).toBe(true);
    expect(exposureCheck({ ...box, domain: null, token: false }).ok).toBe(
      false,
    );
  });
});

describe("dockerPublishesLocally", () => {
  test("loopback in daemon.json", () => {
    expect(dockerPublishesLocally('{ "ip": "127.0.0.1" }')).toBe(true);
    expect(dockerPublishesLocally('{"ip":"::1","log-driver":"local"}')).toBe(
      true,
    );
  });

  test("missing, empty, unparsable, or another address", () => {
    for (const text of ["", "{}", "not json", '{ "ip": "0.0.0.0" }'])
      expect(dockerPublishesLocally(text)).toBe(false);
  });
});

/**
 * sshd's AuthorizedKeysFile tokens.
 *
 * The expansion parks `%%` on a sentinel first, so an escaped percent cannot be
 * re-read as the start of a token. That sentinel used to be a raw NUL byte
 * written straight into the source, which made doctor.ts binary to grep, ripgrep
 * and diffs: searching the file returned nothing, and said nothing about why.
 */
describe("authorizedKeysPaths", () => {
  const HOME = "/home/ubuntu";

  test("expands %h and %u", () => {
    expect(
      authorizedKeysPaths("%h/.ssh/authorized_keys", HOME, "ubuntu"),
    ).toEqual(["/home/ubuntu/.ssh/authorized_keys"]);
    expect(authorizedKeysPaths("/etc/ssh/keys/%u", HOME, "ubuntu")).toEqual([
      "/etc/ssh/keys/ubuntu",
    ]);
  });

  /** What the sentinel is for: %%h is a literal %h, not the home directory. */
  test("%% is an escaped percent and does not start a token", () => {
    expect(authorizedKeysPaths("/etc/%%h", HOME, "ubuntu")).toEqual([
      "/etc/%h",
    ]);
    expect(authorizedKeysPaths("/etc/%%u", HOME, "ubuntu")).toEqual([
      "/etc/%u",
    ]);
    expect(authorizedKeysPaths("/etc/%%", HOME, "ubuntu")).toEqual(["/etc/%"]);
  });

  test("splits the several paths sshd allows", () => {
    expect(
      authorizedKeysPaths(
        "%h/.ssh/authorized_keys .ssh/authorized_keys2",
        HOME,
        "ubuntu",
      ),
    ).toEqual([
      "/home/ubuntu/.ssh/authorized_keys",
      "/home/ubuntu/.ssh/authorized_keys2",
    ]);
  });

  test("a relative path resolves against home, as sshd does", () => {
    expect(authorizedKeysPaths(".ssh/authorized_keys", HOME, "ubuntu")).toEqual(
      ["/home/ubuntu/.ssh/authorized_keys"],
    );
  });

  test("an empty spec yields nothing", () => {
    expect(authorizedKeysPaths("", HOME, "ubuntu")).toEqual([]);
    expect(authorizedKeysPaths("   ", HOME, "ubuntu")).toEqual([]);
  });
});

/**
 * A NUL byte anywhere in the source makes that file binary to grep, ripgrep and
 * GitHub diffs, and nothing announces it. Write the escape sequence instead of
 * the byte.
 */
describe("source files are text", () => {
  test("no source file contains a NUL byte", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for (const dir of ["server", "src", "shared", "test", "scripts"]) {
      const glob = new Glob("**/*.{ts,tsx,js,mjs,json,css,html}");
      for await (const file of glob.scan(dir)) {
        const bytes = await Bun.file(`${dir}/${file}`).bytes();
        if (bytes.includes(0)) offenders.push(`${dir}/${file}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
