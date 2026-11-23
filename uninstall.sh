#!/usr/bin/env bash
set -euo pipefail

LP_DIR="${LP_DIR:-/opt/linuxpanel}"
SERVICE="linuxpanel"
CONF_DIR="/etc/linuxpanel"
STATE_DIR="/var/lib/linuxpanel"
LOG_DIR="/var/log/linuxpanel"
SSHD_CONFIG="/etc/ssh/sshd_config"
PURGE=0

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        -h|--help)
            say "usage: uninstall.sh [--purge]"
            say "  --purge  also remove $CONF_DIR, $STATE_DIR, $LOG_DIR and the sshd managed block"
            exit 0
            ;;
        *) die "unknown argument: $arg" ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (try: sudo ./uninstall.sh)"
fi

echo "== LinuxPanel uninstaller =="

echo "== service =="
if command -v systemctl >/dev/null 2>&1; then
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    systemctl disable "$SERVICE" >/dev/null 2>&1 || true
fi
rm -f "/etc/systemd/system/$SERVICE.service"
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
fi
say "service removed"

echo "== PAM service =="
rm -f /etc/pam.d/linuxpanel
say "removed /etc/pam.d/linuxpanel"

echo "== install directory =="
rm -rf "$LP_DIR"
say "removed $LP_DIR"

echo "== sshd managed block =="
if [ -f "$SSHD_CONFIG" ] && grep -q '^# BEGIN LINUXPANEL MANAGED BLOCK' "$SSHD_CONFIG"; then
    if [ "$PURGE" -eq 1 ]; then
        cp -a "$SSHD_CONFIG" "$SSHD_CONFIG.linuxpanel.uninstall.bak"
        sed -i '/^# BEGIN LINUXPANEL MANAGED BLOCK/,/^# END LINUXPANEL MANAGED BLOCK/d' "$SSHD_CONFIG"
        SSHD_BIN="$(command -v sshd || true)"
        if [ -z "$SSHD_BIN" ] && [ -x /usr/sbin/sshd ]; then
            SSHD_BIN=/usr/sbin/sshd
        fi
        if [ -n "$SSHD_BIN" ] && ! "$SSHD_BIN" -t >/dev/null 2>&1; then
            cp -a "$SSHD_CONFIG.linuxpanel.uninstall.bak" "$SSHD_CONFIG"
            warn "sshd -t rejected the edited config, restored the backup"
        else
            say "removed the LINUXPANEL managed block from $SSHD_CONFIG"
            systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
        fi
    else
        say "a LINUXPANEL managed block is present in $SSHD_CONFIG; it was left in place"
        say "re-run with --purge to remove it"
    fi
else
    say "no managed block found"
fi

if [ "$PURGE" -eq 1 ]; then
    echo "== data =="
    rm -rf "$CONF_DIR" "$STATE_DIR" "$LOG_DIR"
    say "removed $CONF_DIR, $STATE_DIR, $LOG_DIR"
else
    say "kept $CONF_DIR, $STATE_DIR, $LOG_DIR (use --purge to remove)"
fi

echo
say "LinuxPanel uninstalled"
