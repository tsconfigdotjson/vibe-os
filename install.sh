#!/bin/sh
# Installs the vibe-os binary from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/tsconfigdotjson/vibe-os/main/install.sh | sh
#
# Environment:
#   VIBE_OS_VERSION      a release tag to install, such as v0.2.0 (default: latest)
#   VIBE_OS_INSTALL_DIR  where to put the binary (default: /usr/local/bin, or
#                        ~/.local/bin when that is not writable and sudo is
#                        not available)
set -eu

REPO="tsconfigdotjson/vibe-os"

say() { printf 'vibe-os: %s\n' "$*"; }
die() {
  printf 'vibe-os: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "this installer needs $1"
}

need curl
need uname

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)
    case "$arch" in
      x86_64 | amd64) target="linux-x64" ;;
      aarch64 | arm64) target="linux-arm64" ;;
      *) die "no binary for Linux $arch. Build from source: https://github.com/$REPO#development" ;;
    esac
    # The binaries link against glibc, so on Alpine they would install and
    # then fail to start.
    for f in /lib/ld-musl-*; do
      [ -e "$f" ] && die "no binary for musl Linux such as Alpine. Use a glibc distribution, or the container: https://github.com/$REPO#try-it-locally"
    done
    ;;
  Darwin)
    # A shell under Rosetta reports x86_64 on an Apple Silicon Mac.
    if [ "$arch" = "arm64" ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
      target="darwin-arm64"
    else
      die "no binary for Intel Macs. Build from source: https://github.com/$REPO#development"
    fi
    ;;
  *) die "no binary for $os. Build from source: https://github.com/$REPO#development" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "this installer needs sha256sum or shasum to verify the download"
fi

version="${VIBE_OS_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$version"
fi

name="vibe-os-$target"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $name ($version)"
curl -fSL --progress-bar -o "$tmp/$name" "$base/$name" ||
  die "download failed: $base/$name"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" ||
  die "download failed: $base/SHA256SUMS"

want="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || die "SHA256SUMS has no entry for $name"
got="$(sha256 "$tmp/$name")"
[ "$want" = "$got" ] || die "checksum mismatch for $name: expected $want, got $got"

sudo=""
if [ -n "${VIBE_OS_INSTALL_DIR:-}" ]; then
  dir="$VIBE_OS_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  dir="/usr/local/bin"
elif command -v sudo >/dev/null 2>&1; then
  dir="/usr/local/bin"
  sudo="sudo"
  say "installing to $dir needs sudo"
else
  dir="$HOME/.local/bin"
fi

# install replaces the file rather than writing into it, so a running vibe-os
# keeps the one it started from until it is restarted.
$sudo mkdir -p "$dir"
$sudo install -m 0755 "$tmp/$name" "$dir/vibe-os"

installed="$("$dir/vibe-os" --version 2>/dev/null || true)"
if [ -z "$installed" ]; then
  die "installed $dir/vibe-os, but it does not run on this machine"
fi
say "installed $installed to $dir/vibe-os"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "$dir is not on your PATH. Add it, or run $dir/vibe-os directly." ;;
esac

cat <<EOF

Next, set this machine up. It asks before each change:

  vibe-os setup

Or check it without changing anything:

  vibe-os doctor

More at https://github.com/$REPO#deploying-on-a-vps
EOF
