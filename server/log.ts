const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  dim: (s: string) => paint('2', s),
  bold: (s: string) => paint('1', s),
  cyan: (s: string) => paint('36', s),
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  red: (s: string) => paint('31', s),
};

function stamp(): string {
  return color.dim(new Date().toISOString().slice(11, 19));
}

export const log = {
  info: (msg: string) => console.log(`${stamp()} ${msg}`),
  ok: (msg: string) => console.log(`${stamp()} ${color.green('✓')} ${msg}`),
  warn: (msg: string) => console.warn(`${stamp()} ${color.yellow('!')} ${msg}`),
  error: (msg: string) => console.error(`${stamp()} ${color.red('✗')} ${msg}`),
  debug: (msg: string) => {
    if (process.env.VIBE_OS_DEBUG) console.log(`${stamp()} ${color.dim(`· ${msg}`)}`);
  },
};
