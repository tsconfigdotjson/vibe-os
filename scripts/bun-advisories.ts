#!/usr/bin/env bun
// Prints the oven-sh/bun security advisories that affect a Bun version, one
// GHSA id per line. Used by .github/workflows/bun-update.yml.
//
// Bun's release notes do not name the advisories a release fixes, and the
// advisories are published a day or so after the release, so the advisory
// database is the only reliable source. It is read twice: oven-sh/bun's own
// repository advisories and the global database each hold some the other
// does not.
//
//   bun scripts/bun-advisories.ts 1.3.10

// Repository advisories carry `state`; global ones carry `withdrawn_at`.
type Advisory = {
  ghsa_id: string;
  state?: string;
  withdrawn_at?: string | null;
  vulnerabilities: {
    package: { name: string } | null;
    vulnerable_version_range: string | null;
  }[];
};

const VERSION = /^\d+(?:\.\d+){0,2}$/;

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// GitHub writes ranges as comma-separated comparators: ">= 1.0.21, < 1.4.4",
// "< 1.4.4", "= 1.2.0".
export function affects(range: string, version: string): boolean {
  // A pre-release such as 1.4.5-canary.1 would compare as NaN and read as
  // safe, so anything but a plain version is an error.
  if (!VERSION.test(version)) throw new Error(`not a version: ${version}`);
  return range.split(",").every((part) => {
    const m = part.trim().match(/^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
    if (!m) throw new Error(`unrecognised version range: ${range}`);
    const d = compare(version, m[2] as string);
    switch (m[1]) {
      case ">=":
        return d >= 0;
      case "<=":
        return d <= 0;
      case ">":
        return d > 0;
      case "<":
        return d < 0;
      default:
        return d === 0;
    }
  });
}

export function affecting(advisories: Advisory[], version: string): string[] {
  return advisories
    .filter(
      (a) =>
        (a.state === undefined ? !a.withdrawn_at : a.state === "published") &&
        a.vulnerabilities.some(
          (v) =>
            v.package?.name === "bun" &&
            v.vulnerable_version_range !== null &&
            affects(v.vulnerable_version_range, version),
        ),
    )
    .map((a) => a.ghsa_id)
    .filter((id, i, ids) => ids.indexOf(id) === i)
    .sort();
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun scripts/bun-advisories.ts <bun version>");
    process.exit(2);
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers = {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const sources = [
    "https://api.github.com/repos/oven-sh/bun/security-advisories?per_page=100",
    "https://api.github.com/advisories?ecosystem=npm&affects=bun&per_page=100",
  ];
  const advisories: Advisory[] = [];
  for (const url of sources) {
    // Each list is a handful long; a full page means one has outgrown this.
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`advisory lookup failed: HTTP ${res.status} from ${url}`);
      process.exit(1);
    }
    const page = (await res.json()) as Advisory[];
    if (page.length >= 100) {
      console.error(`advisory lookup needs pagination: ${url}`);
      process.exit(1);
    }
    advisories.push(...page);
  }
  for (const id of affecting(advisories, version)) {
    console.log(id);
  }
}
