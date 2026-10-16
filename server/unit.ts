// The installed vibe-os service, as setup and doctor read it.

/** Where install-service writes the unit. */
export const UNIT_PATH = "/etc/systemd/system/vibe-os.service";

export interface UnitFlags {
  port: number | null;
  host: string | null;
  /** undefined: no token flag, so the service uses the remembered one. */
  token: string | null | undefined;
  /** The name it gets a certificate for and serves HTTPS on. */
  domain: string | null;
}

/**
 * The flags an installed vibe-os unit starts with.
 *
 * The service is the source of truth for where vibe-os is listening and which
 * token it wants, and setup reads it rather than assuming its own defaults
 * were the ones used: a unit installed by hand with `--port 8080` is served on
 * 8080, and the URL printed at the end has to say so.
 */
export function unitFlags(unit: string): UnitFlags {
  const line = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  const words = line?.slice("ExecStart=".length).trim().split(/\s+/) ?? [];
  const flags: UnitFlags = {
    port: null,
    host: null,
    token: undefined,
    domain: null,
  };

  const value = (i: number, name: string): string | undefined => {
    const word = words[i] as string;
    if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    const next = words[i + 1];
    return next === undefined || next.startsWith("-") ? "" : next;
  };

  words.forEach((word, i) => {
    if (word === "--port" || word.startsWith("--port=")) {
      const n = Number(value(i, "--port"));
      if (Number.isInteger(n) && n > 0) flags.port = n;
    } else if (word === "--host" || word.startsWith("--host=")) {
      flags.host = value(i, "--host") || null;
    } else if (word === "--domain" || word.startsWith("--domain=")) {
      flags.domain = value(i, "--domain") || null;
    } else if (word === "--no-token") {
      flags.token = null;
    } else if (word === "--token" || word.startsWith("--token=")) {
      // A bare `--token` means "the remembered one", same as no flag at all.
      flags.token = value(i, "--token") || undefined;
    }
  });
  return flags;
}
