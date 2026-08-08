#!/usr/bin/env bun
// Thin launcher for running from a checkout or an npm install. The real CLI is
// server/cli.ts, executed by Bun directly — there is no build step for the
// server. `bun build --compile` uses server/main.ts instead.
import { main } from "../server/cli.ts";
import { cliArgs } from "../server/runtime.ts";

const code = await main(cliArgs());
// -1 means "the server is running"; anything else is a one-shot command.
// Compared against -1 rather than `>= 0`, because `undefined >= 0` is false —
// so a future path that falls off the end of main() would hang the process
// with no output instead of exiting.
if (code !== -1) process.exit(code);
