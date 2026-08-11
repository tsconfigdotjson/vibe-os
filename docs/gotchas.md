# Things that will bite you

Traps found the hard way, each with a longer explanation in a comment next to
the code it applies to. This is an index, not the reasoning.

### One Go runtime serves the whole page

Every window calls `start()` on the same WASM instance, so a Go panic in any
window kills the runtime for all of them. Teardown order in `SshTerminal.tsx` is
load-bearing: close the session and await `done` before disposing the Terminal.
That await is raced against a timeout, because a panicked runtime never settles
`done` at all. `onRuntimeDead` exists so the app can rebuild every window rather
than leaving you with terminals that look fine and accept no input.

### The browser asks sshd for a pty at 14400 baud, which Linux cannot encode

SSH carries `TTY_OP_ISPEED` and `TTY_OP_OSPEED` in its pty-req and sshd writes
them in raw. The Go SSH example every project copies hardcodes 14400, so every
browser window gets a pty whose speed reads back fine and cannot be written
again. The first program to do the ordinary tcgetattr, flip flags, tcsetattr
raw-mode dance gets `EINVAL`. `stty 38400` in the session command fixes it.

Nothing showed this for months: Node's `setRawMode` swallows the error, so
Claude was fine. Python's prompt_toolkit raises, so Hermes died before painting
anything. A harness that renders nothing and exits is the symptom.

### flock locks a file descriptor, and descriptors are inherited

The session command serialises its probe-then-create with `flock -o`. Without
`-o`, the daemonised `dtach` inherits the descriptor and holds the lock for the
life of the session, so every later login blocks forever. It presents as a
terminal that hangs just after verifying the host key, which points nowhere near
the cause.

### Host key algorithm order is not the obvious one

`golang.org/x/crypto/ssh`'s `supportedHostKeyAlgos` puts ECDSA ahead of
Ed25519, the opposite of OpenSSH. vibe-os discovers the host key with
`ssh-keyscan` in that order, because pinning a key the server holds but does not
present makes every window report the host key as changed, which reads like an
attack rather than a misconfiguration.

### dtach is detected on the machine vibe-os runs on

Which is the SSH target by default. If you point `--ssh-host` somewhere else,
pass `--sessions` explicitly.

### Upstream prints a banner into every session

`internal/start.go` writes it with no option to disable it. It is filtered in
`SshTerminal.tsx` by wrapping the terminal object handed to Go, rather than by
forking the Go source, which would cost the "prebuilt from upstream releases, no
Go toolchain on the VPS" property. The filter switches itself off at the first
line that is not part of the banner, so it cannot swallow real output.

### xterm's allowTransparency is not enough to see through a terminal

It covers the cell layer. xterm 6 also paints an opaque background on the
element it mounts into and on its scrollable wrapper, so missing those leaves
the terminal rendering perfectly while punching a solid rectangle through the
glass. `styles.css` clears them with `!important`, because they are set inline
from JS and nothing else beats an inline style.

### BunFile.stat() returns undefined for embedded files

Rather than rejecting, so `.catch()` on it throws. Use `.size`, which works in
both modes. Embedded assets have no mtime either, so their ETag version comes
from the generated `BUILD_ID`.

### A compiled Bun binary keeps the same argv shape as `bun run`

`[runtime, entry, ...args]`, where the entry reads as `/$bunfs/root/<name>`.
Assuming a standalone executable drops the entry slot turns that path into the
subcommand.

### Installed-app icons must be opaque

Transparent corners are filled by whatever installs the app, and Chromium fills
them white, which reads as a white border around a dark icon in the Dock. The
rounding belongs in the platform's mask, not in the file. `public/icon.svg`
keeps its rounded corners for the favicon and the README only.
