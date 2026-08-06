# A blank Linux box with sshd, tmux and vibe-os on port 80 — the same shape as
# a fresh VPS, close enough to be a real rehearsal for one.
#
# The runtime stage deliberately contains no Bun, no Node and no npm. It is
# plain Debian plus OpenSSH, tmux and one compiled executable. If anything the
# server needs at runtime were not actually embedded in that binary, this image
# would fail to start rather than quietly work because a source tree happened to
# be lying around.

# ── stage 1: build and compile ───────────────────────────────────────────────
FROM oven/bun:1-debian AS builder

WORKDIR /src
# scripts/ comes along with the manifest because postinstall runs from there.
COPY package.json ./
COPY scripts ./scripts
RUN bun install

COPY . .

# Compile for whatever architecture the image is being built for, so this works
# on both an arm64 laptop and an x64 VPS.
ARG TARGETARCH
RUN bun run build \
    && case "$TARGETARCH" in \
         amd64) BUN_TARGET=linux-x64 ;; \
         arm64) BUN_TARGET=linux-arm64 ;; \
         *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && bun scripts/compile.ts "$BUN_TARGET" \
    && mv dist/bin/vibe-os-* /out-binary

# ── stage 2: the runtime box, with no JavaScript runtime in sight ────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server \
      # vibe-os shells out to ssh-keygen (to sign certificates) and ssh-keyscan
      # (to discover the host key to pin). Neither is guaranteed by the server
      # package, and without them the server refuses to start.
      openssh-client \
      tmux \
      git \
      # provides setcap, used below to let an unprivileged vibe-os bind port 80
      libcap2-bin \
      ca-certificates \
      procps \
      curl \
      less \
      vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# The windows run as this user, not root — same as a VPS where you have already
# stopped logging in as root. vibe-os writes its CA and the cert-authority line
# into this home directory.
RUN useradd --create-home --shell /bin/bash vibe \
    && mkdir -p /run/sshd \
    # Debian's openssh-server postinst generates host keys at build time, which
    # would bake one SSH identity into the image and share it with every
    # container built from it. Drop them; the entrypoint's `ssh-keygen -A`
    # makes a fresh set on first boot instead.
    && rm -f /etc/ssh/ssh_host_*

COPY docker/sshd-vibe-os.conf /etc/ssh/sshd_config.d/vibe-os.conf
COPY docker/entrypoint.sh /usr/local/bin/vibe-os-entrypoint
COPY --from=builder /out-binary /usr/local/bin/vibe-os

# Lets an unprivileged process bind port 80. Same fix `vibe-os` prints when it
# cannot bind, and the same capability the systemd unit grants.
RUN chmod +x /usr/local/bin/vibe-os-entrypoint /usr/local/bin/vibe-os \
    && setcap 'cap_net_bind_service=+ep' /usr/local/bin/vibe-os

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/vibe-os-entrypoint"]
CMD []
