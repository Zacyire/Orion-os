#!/usr/bin/env bash
# Orion OS — build this checkout and install it as the live site.
#
# Run on the server from your clone of the (private) repository:
#     ./deploy/update.sh              # git pull, build, install, restart
#     ./deploy/update.sh --no-pull    # build what is checked out right now
#     ./deploy/update.sh --test       # also run the backend tests first
#
# The previous binary is kept as ltf-os.previous; deploy/update.sh never
# touches the data directory (/var/lib/orion-os) or /etc/orion-os.
# Rollback: `git checkout <older-commit> && ./deploy/update.sh --no-pull`.
set -euo pipefail

PREFIX="${PREFIX:-/opt/orion-os}"       # where the live files go
SERVICE="${SERVICE:-orion-os}"          # systemd unit name
PORT="${PORT:-8080}"                    # Orion OS port behind the proxy
SUDO="${SUDO-sudo}"                     # set SUDO= when already root
SKIP_RESTART="${SKIP_RESTART:-0}"       # 1 = install only (testing)

cd "$(dirname "$0")/.."
[ -f Cargo.toml ] && [ -d static ] || { echo "run this from an Orion OS checkout" >&2; exit 1; }

PULL=1 TEST=0
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    --test) TEST=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$PULL" = 1 ]; then
  echo "==> git pull"
  git pull --ff-only
fi
echo "==> building $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree')"
cargo build --release --locked
if [ "$TEST" = 1 ]; then
  echo "==> backend tests"
  cargo test --locked --quiet
fi

echo "==> installing to $PREFIX"
$SUDO install -d -m 0755 "$PREFIX"
if [ -f "$PREFIX/ltf-os" ]; then $SUDO cp -p "$PREFIX/ltf-os" "$PREFIX/ltf-os.previous"; fi
$SUDO install -m 0755 target/release/ltf-os "$PREFIX/ltf-os.new"
$SUDO mv -f "$PREFIX/ltf-os.new" "$PREFIX/ltf-os"
for dir in static content; do
  $SUDO rm -rf "$PREFIX/$dir.new"
  $SUDO cp -R "$dir" "$PREFIX/$dir.new"
  $SUDO rm -rf "$PREFIX/$dir"
  $SUDO mv "$PREFIX/$dir.new" "$PREFIX/$dir"
done
$SUDO chmod -R a+rX,go-w "$PREFIX"

if [ "$SKIP_RESTART" = 1 ]; then
  echo "==> installed (restart skipped)"
  exit 0
fi
echo "==> restarting $SERVICE"
$SUDO systemctl restart "$SERVICE"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "==> Orion OS is up ($(git rev-parse --short HEAD 2>/dev/null || true))"
    exit 0
  fi
  sleep 1
done
echo "!! Orion OS did not come back. Check: journalctl -u $SERVICE -n 50" >&2
echo "!! To roll back the binary: sudo cp $PREFIX/ltf-os.previous $PREFIX/ltf-os && sudo systemctl restart $SERVICE" >&2
exit 1
