#!/usr/bin/env bun
// Prints the oven-sh/bun security advisories that affect a Bun version, one
// GHSA id per line. Used by .github/workflows/bun-update.yml.
//
// Bun's release notes do not name the advisories a release fixes, and the
// advisories are published a day or so after the release, so the advisory
// database is the only reliable source.
//
//   bun scripts/bun-advisories.ts 1.3.10

type Advisory = {
  ghsa_id: string;
  state: string;
  vulnerabilities: {
    package: { name: string } | null;
    vulnerable_version_range: string | null;
  }[];
};

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
        a.state === "published" &&
        a.vulnerabilities.some(
          (v) =>
            v.package?.name === "bun" &&
            v.vulnerable_version_range !== null &&
            affects(v.vulnerable_version_range, version),
        ),
    )
    .map((a) => a.ghsa_id)
    .sort();
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun scripts/bun-advisories.ts <bun version>");
    process.exit(2);
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const res = await fetch(
    "https://api.github.com/repos/oven-sh/bun/security-advisories?per_page=100",
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!res.ok) {
    console.error(`advisory lookup failed: HTTP ${res.status}`);
    process.exit(1);
  }
  for (const id of affecting((await res.json()) as Advisory[], version)) {
    console.log(id);
  }
}
