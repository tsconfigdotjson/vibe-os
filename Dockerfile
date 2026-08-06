# A blank Linux box with sshd, tmux and vibe-os on port 80 — the same shape as
# a fresh VPS, close enough to be a real rehearsal for one.
#
# The build deliberately goes through `npm pack` and then installs the tarball
# globally, rather than running from the source tree. That exercises the actual
# publish path: if the `files` list is wrong, or something the server needs at
# runtime is missing from the package, this image fails to start instead of
# quietly working because the source happened to be lying around.

# ── stage 1: build the package exactly as `npm publish` would ────────────────
FROM node:22-bookworm-slim AS builder

WORKDIR /src
# scripts/ comes along with the manifests because postinstall runs from there.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
# prepack runs the full build: fetch ssh.wasm, vite, precompress, tsc.
RUN mkdir -p /out && npm pack --pack-destination /out && ls -la /out

# ── stage 2: the runtime box ─────────────────────────────────────────────────
FROM node:22-bookworm-slim

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

# The panes run as this user, not root — same as a VPS where you have already
# stopped logging in as root. vibe-os writes its CA and the cert-authority line
# into this home directory.
RUN useradd --create-home --shell /bin/bash vibe \
    && mkdir -p /run/sshd \
    # Debian's openssh-server postinst generates host keys at build time, which
    # would bake one SSH identity into the image and share it with every
    # container built from it. Drop them; the entrypoint's `ssh-keygen -A`
    # makes a fresh set on first boot instead.
    && rm -f /etc/ssh/ssh_host_*

# Lets an unprivileged process bind port 80. This is the same fix `vibe-os`
# prints when it cannot bind, and the same capability the systemd unit grants.
RUN setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")"

COPY docker/sshd-vibe-os.conf /etc/ssh/sshd_config.d/vibe-os.conf
COPY docker/entrypoint.sh /usr/local/bin/vibe-os-entrypoint
RUN chmod +x /usr/local/bin/vibe-os-entrypoint

COPY --from=builder /out/*.tgz /tmp/
RUN npm install -g /tmp/*.tgz && rm -f /tmp/*.tgz

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/vibe-os-entrypoint"]
CMD []
