import { describe, expect, test } from "bun:test";
import { detokenize, tokenize } from "../server/profiles.ts";

/**
 * The round-trip is the whole contract here.
 *
 * `detokenize` renders stored argv back into the editor's text field and
 * `tokenize` parses it on the way to the database, so every save of an
 * unmodified profile runs one full cycle. It used to lose: `detokenize` emitted
 * POSIX escaping (`'\''`) that `tokenize` gave no meaning to, so any argument
 * containing an apostrophe came back as `unbalanced ' in the arguments` and the
 * profile could not be saved again without deleting the flag.
 */
describe("tokenize/detokenize round-trip", () => {
  const corpus: [name: string, argv: string[]][] = [
    ["plain flags", ["--model", "sonnet"]],
    ["no arguments", []],
    ["apostrophe", ["--append-system-prompt", "don't guess"]],
    ["several apostrophes", ["--x", "it's Lee's box's config"]],
    ["double quotes", ["--flag", 'say "hi"']],
    ["both quote kinds", ["--flag", `it's a "quoted" thing`]],
    ["spaces", ["--path", "/a b/c"]],
    ["backslash", ["--path", "C:\\Users\\lee"]],
    ["backslash before quote", ["--x", "trailing\\", "--y"]],
    ["empty string argument", ["--name", ""]],
    ["shell metacharacters", ["--x", "a; rm -rf /", "--y", "$(whoami)"]],
    ["backtick and dollar", ["--x", "`id`", "--y", `${"$"}{HOME}`]],
    ["newline-free unicode", ["--prompt", "réponse — naïve 日本語"]],
    ["only whitespace", ["--x", "   "]],
    ["equals and colons", ["--opt=value", "host:port"]],
    ["leading dash in value", ["--flag", "--not-a-flag"]],
  ];

  for (const [name, argv] of corpus) {
    test(name, () => {
      expect(tokenize(detokenize(argv))).toEqual(argv);
    });
  }
});

describe("tokenize", () => {
  test("splits on whitespace", () => {
    expect(tokenize("--a  --b\t--c")).toEqual(["--a", "--b", "--c"]);
  });

  test("keeps quoted whitespace together", () => {
    expect(tokenize('--model "gpt 4"')).toEqual(["--model", "gpt 4"]);
  });

  test("treats single quotes as literal", () => {
    expect(tokenize(`'a\\b'`)).toEqual(["a\\b"]);
  });

  test("honours a backslash escape outside quotes", () => {
    expect(tokenize("a\\ b")).toEqual(["a b"]);
    expect(tokenize("\\'")).toEqual(["'"]);
  });

  test("preserves an empty quoted argument", () => {
    expect(tokenize("--name ''")).toEqual(["--name", ""]);
  });

  test("rejects an unbalanced quote", () => {
    expect(() => tokenize("--x 'open")).toThrow(/unbalanced/);
    expect(() => tokenize('--x "open')).toThrow(/unbalanced/);
  });

  test("rejects a dangling backslash", () => {
    expect(() => tokenize("--x \\")).toThrow(/dangling backslash/);
  });

  test("is empty for empty and whitespace-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \t ")).toEqual([]);
  });
});

describe("detokenize", () => {
  test("leaves simple tokens unquoted", () => {
    expect(detokenize(["--model", "sonnet"])).toBe("--model sonnet");
  });

  test("quotes anything that would re-split", () => {
    expect(detokenize(["a b"])).toBe("'a b'");
    expect(detokenize([""])).toBe("''");
  });

  test("quotes tokens containing a backslash", () => {
    // Without this, tokenize's escape handling would eat the backslash.
    expect(tokenize(detokenize(["a\\b"]))).toEqual(["a\\b"]);
  });
});
