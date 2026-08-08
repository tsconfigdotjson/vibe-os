#!/bin/sh
# Brings up sshd, then hands the container over to vibe-os running as `vibe`.
set -e

# Host keys are generated on first boot rather than baked into the image, so
# every container gets its own identity instead of sharing one published key.
# They land in /etc/ssh, which is worth putting on a volume if you want the
# browser's pinned host key to survive a rebuild.
ssh-keygen -A >/dev/null

# Reinstalled every boot: /etc/ssh is a volume in compose, so a copy baked into
# the image would be masked by whatever the volume held from the first run.
mkdir -p /etc/ssh/sshd_config.d
cp /usr/local/share/vibe-os/sshd-vibe-os.conf /etc/ssh/sshd_config.d/vibe-os.conf

/usr/sbin/sshd

# Wait for sshd rather than racing it: vibe-os probes the target's host key at
# startup, and if sshd is not listening yet it falls back to making the browser
# confirm the key by hand. ssh-keyscan is the same probe vibe-os itself uses,
# and unlike ss/nc it is guaranteed to be here.
i=0
while [ "$i" -lt 50 ]; do
  if [ -n "$(ssh-keyscan -T 1 -p 22 127.0.0.1 2>/dev/null)" ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done

if [ "$i" -ge 50 ]; then
  # Falling through is survivable but worth saying: the host key will not be
  # discoverable yet, so the browser gets a trust-on-first-use prompt instead.
  echo "vibe-os: sshd did not answer within 10s — continuing without a pinned host key" >&2
fi

# exec so vibe-os becomes PID 1's child and receives docker stop signals.
exec setpriv --reuid vibe --regid vibe --init-groups \
  env HOME=/home/vibe USER=vibe TERM=xterm-256color \
  vibe-os start "$@"
