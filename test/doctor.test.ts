import { describe, expect, test } from "bun:test";
import { parseNftOrIptables, parseUfw } from "../server/doctor.ts";

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
    });
  });

  test("reads the nftables spelling of the same rules", () => {
    expect(parseNftOrIptables(NFT)).toEqual({
      active: true,
      defaultDeny: true,
      tailnetAllowed: true,
      directUdpAllowed: true,
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
