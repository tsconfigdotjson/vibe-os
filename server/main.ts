// Entry point for `bun build --compile`.
import { main } from "./cli.ts";
import { cliArgs } from "./runtime.ts";

const code = await main(cliArgs());
// -1 means "the server is running"; anything else is a one-shot command.
if (code >= 0) process.exit(code);
