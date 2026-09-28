#!/usr/bin/env bash
# Orion OS — back up the server-side data directory.
#
#     sudo ./deploy/backup.sh                 # → /var/backups/orion-os/orion-data-<time>.tar.gz
#
# Keeps the newest $KEEP archives. Archives contain your Notepad files and
# settings (not the access key), are readable by root only, and should also
# be copied OFF the server regularly, e.g. from your own computer:
#     scp YOUR_USER@YOUR_SERVER:/var/backups/orion-os/orion-data-*.tar.gz .
# Restore: stop the service, extract over an empty data directory, start it
#     sudo systemctl stop orion-os
#     sudo tar -xzf orion-data-<time>.tar.gz -C /var/lib/orion-os
#     sudo chown -R orion-os:orion-os /var/lib/orion-os && sudo systemctl start orion-os
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/orion-os}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/orion-os}"
KEEP="${KEEP:-14}"

[ -d "$DATA_DIR" ] || { echo "no data directory at $DATA_DIR" >&2; exit 1; }
umask 077
mkdir -p "$BACKUP_DIR"
archive="$BACKUP_DIR/orion-data-$(date -u +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$archive" -C "$DATA_DIR" .
echo "backup written: $archive ($(du -h "$archive" | cut -f1))"

# Prune: keep the newest $KEEP archives.
ls -1t "$BACKUP_DIR"/orion-data-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f -- "$old"; done
