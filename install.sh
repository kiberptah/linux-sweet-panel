#!/usr/bin/env bash
set -euo pipefail

LP_REPO="${LP_REPO:-https://github.com/YOUR_GITHUB_USER/linuxpanel.git}"
LP_BRANCH="${LP_BRANCH:-main}"
LP_PORT="${LP_PORT:-4080}"
LP_DIR="${LP_DIR:-/opt/linuxpanel}"
LP_BIND="${LP_BIND:-0.0.0.0}"
LP_NO_TLS="${LP_NO_TLS:-}"

CONF_DIR="/etc/linuxpanel"
STATE_DIR="/var/lib/linuxpanel"
LOG_DIR="/var/log/linuxpanel"
SERVICE="linuxpanel"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (try: sudo ./install.sh)"
fi

case "$LP_PORT" in
    ''|*[!0-9]*) die "LP_PORT must be a number, got '$LP_PORT'" ;;
esac

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

echo "== LinuxPanel installer =="

PKG=""
for candidate in apt-get dnf yum pacman zypper apk; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PKG="$candidate"
        break
    fi
done

pkg_name() {
    local cmd="$1"
    case "$PKG" in
        apt-get)
            case "$cmd" in
                python3) echo python3 ;;
                tmux) echo tmux ;;
                git) echo git ;;
                openssl) echo openssl ;;
                sudo) echo sudo ;;
                *) echo passwd ;;
            esac
            ;;
        dnf|yum)
            case "$cmd" in
                python3) echo python3 ;;
                tmux) echo tmux ;;
                git) echo git ;;
                openssl) echo openssl ;;
                sudo) echo sudo ;;
                *) echo shadow-utils ;;
            esac
            ;;
        pacman)
            case "$cmd" in
                python3) echo python ;;
                tmux) echo tmux ;;
                git) echo git ;;
                openssl) echo openssl ;;
                sudo) echo sudo ;;
                *) echo shadow ;;
            esac
            ;;
        zypper)
            case "$cmd" in
                python3) echo python3 ;;
                tmux) echo tmux ;;
                git) echo git ;;
                openssl) echo openssl ;;
                sudo) echo sudo ;;
                *) echo shadow ;;
            esac
            ;;
        apk)
            case "$cmd" in
                python3) echo python3 ;;
                tmux) echo tmux ;;
                git) echo git ;;
                openssl) echo openssl ;;
                sudo) echo sudo ;;
                *) echo shadow ;;
            esac
            ;;
        *) echo "" ;;
    esac
}

echo "== dependencies =="
MISSING=()
for cmd in python3 tmux git openssl sudo passwd useradd usermod chpasswd groupadd gpasswd; do
    if command -v "$cmd" >/dev/null 2>&1; then
        continue
    fi
    name="$(pkg_name "$cmd")"
    if [ -z "$name" ]; then
        die "missing '$cmd' and no supported package manager found"
    fi
    skip=0
    for existing in ${MISSING[@]+"${MISSING[@]}"}; do
        if [ "$existing" = "$name" ]; then
            skip=1
            break
        fi
    done
    if [ "$skip" -eq 0 ]; then
        MISSING+=("$name")
    fi
done

if [ "${#MISSING[@]}" -eq 0 ]; then
    say "all dependencies already present"
else
    say "installing: ${MISSING[*]}"
    case "$PKG" in
        apt-get)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y -qq --no-install-recommends "${MISSING[@]}"
            ;;
        dnf) dnf install -y "${MISSING[@]}" ;;
        yum) yum install -y "${MISSING[@]}" ;;
        pacman) pacman -Sy --noconfirm --needed "${MISSING[@]}" ;;
        zypper) zypper --non-interactive install "${MISSING[@]}" ;;
        apk) apk add --no-cache "${MISSING[@]}" ;;
        *) die "no supported package manager found" ;;
    esac
fi

for cmd in python3 tmux git openssl; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is still missing after install"
done

echo "== install directory =="
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/linuxpanel/__init__.py" ]; then
    if [ ! -d "$LP_DIR" ]; then
        say "copying local checkout $SCRIPT_DIR to $LP_DIR"
        mkdir -p "$(dirname "$LP_DIR")"
        cp -a "$SCRIPT_DIR" "$LP_DIR"
    elif [ ! -d "$LP_DIR/.git" ]; then
        say "refreshing $LP_DIR from local checkout $SCRIPT_DIR"
        cp -a "$SCRIPT_DIR/." "$LP_DIR/"
    else
        say "keeping existing git checkout in $LP_DIR"
    fi
elif [ -d "$LP_DIR/.git" ]; then
    say "updating existing checkout in $LP_DIR"
    git -C "$LP_DIR" fetch --prune origin
    git -C "$LP_DIR" reset --hard "origin/$LP_BRANCH"
else
    say "cloning $LP_REPO ($LP_BRANCH) into $LP_DIR"
    mkdir -p "$(dirname "$LP_DIR")"
    git clone --branch "$LP_BRANCH" "$LP_REPO" "$LP_DIR"
fi

chown -R root:root "$LP_DIR"
chmod -R a+rX,go-w "$LP_DIR"

echo "== directories =="
install -d -m 755 "$CONF_DIR"
install -d -m 700 "$STATE_DIR"
install -d -m 700 "$LOG_DIR"

echo "== configuration =="
if [ ! -f "$CONF_DIR/config.json" ]; then
    if [ -n "$LP_NO_TLS" ]; then
        TLS_VALUE=false
    else
        TLS_VALUE=true
    fi
    printf '{\n  "port": %s,\n  "bind": "%s",\n  "tls": %s,\n  "cert": "%s/cert.pem",\n  "key": "%s/key.pem",\n  "repo": "%s",\n  "branch": "%s"\n}\n' \
        "$LP_PORT" "$LP_BIND" "$TLS_VALUE" "$CONF_DIR" "$CONF_DIR" "$LP_REPO" "$LP_BRANCH" > "$CONF_DIR/config.json"
    chmod 600 "$CONF_DIR/config.json"
    say "wrote $CONF_DIR/config.json"
else
    chmod 600 "$CONF_DIR/config.json"
    say "keeping existing $CONF_DIR/config.json (port and TLS unchanged)"
fi

echo "== TLS certificate =="
if [ -s "$CONF_DIR/cert.pem" ] && [ -s "$CONF_DIR/key.pem" ]; then
    say "keeping existing certificate"
else
    HOSTNAME_VALUE="$(hostname)"
    SAN="DNS:$HOSTNAME_VALUE"
    PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || PRIMARY_IP=""
    if [ -n "$PRIMARY_IP" ]; then
        SAN="$SAN,IP:$PRIMARY_IP"
    fi
    if ! openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$HOSTNAME_VALUE" \
        -addext "subjectAltName=$SAN" \
        -keyout "$CONF_DIR/key.pem" -out "$CONF_DIR/cert.pem" >/dev/null 2>&1; then
        openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$HOSTNAME_VALUE" \
            -keyout "$CONF_DIR/key.pem" -out "$CONF_DIR/cert.pem" >/dev/null 2>&1
    fi
    chmod 600 "$CONF_DIR/key.pem"
    chmod 644 "$CONF_DIR/cert.pem"
    say "generated self-signed certificate for $HOSTNAME_VALUE"
fi

echo "== PAM service =="
if [ -f /etc/pam.d/linuxpanel ]; then
    say "keeping existing /etc/pam.d/linuxpanel"
else
    if [ -f /etc/pam.d/common-auth ]; then
        printf '@include common-auth\n@include common-account\n' > /etc/pam.d/linuxpanel
    elif [ -f /etc/pam.d/system-auth ]; then
        printf 'auth include system-auth\naccount include system-auth\n' > /etc/pam.d/linuxpanel
    else
        printf 'auth include login\naccount include login\n' > /etc/pam.d/linuxpanel
    fi
    chmod 644 /etc/pam.d/linuxpanel
    say "wrote /etc/pam.d/linuxpanel"
fi

echo "== systemd service =="
PYTHON_BIN="$(command -v python3)"
sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$LP_DIR|" \
    -e "s|^ExecStart=.*|ExecStart=$PYTHON_BIN -m linuxpanel --config $CONF_DIR/config.json|" \
    "$LP_DIR/linuxpanel.service" > "/etc/systemd/system/$SERVICE.service"
chmod 644 "/etc/systemd/system/$SERVICE.service"

if [ -d /run/systemd/system ]; then
    WAS_ACTIVE=0
    if systemctl is-active --quiet "$SERVICE"; then
        WAS_ACTIVE=1
    fi
    systemctl daemon-reload
    systemctl enable "$SERVICE" >/dev/null 2>&1 || true
    if [ "$WAS_ACTIVE" -eq 1 ]; then
        systemctl restart "$SERVICE"
    else
        systemctl start "$SERVICE"
    fi
    sleep 1
    if systemctl is-active --quiet "$SERVICE"; then
        say "service $SERVICE is running"
    else
        warn "service $SERVICE failed to start, see: journalctl -u $SERVICE -n 50"
    fi
else
    warn "systemd is not running here; start the panel manually with:"
    warn "  $PYTHON_BIN -m linuxpanel --config $CONF_DIR/config.json"
fi

echo "== firewall =="
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi '^Status: active'; then
    say "ufw is active, open the port with: ufw allow $LP_PORT/tcp"
elif command -v firewall-cmd >/dev/null 2>&1 && [ "$(firewall-cmd --state 2>/dev/null || true)" = "running" ]; then
    say "firewalld is running, open the port with: firewall-cmd --permanent --add-port=$LP_PORT/tcp && firewall-cmd --reload"
else
    say "no active firewall detected"
fi

SCHEME="https"
if [ -n "$LP_NO_TLS" ]; then
    SCHEME="http"
elif [ -f "$CONF_DIR/config.json" ] && grep -q '"tls": *false' "$CONF_DIR/config.json"; then
    SCHEME="http"
fi
ACCESS_IP="$(hostname -I 2>/dev/null | awk '{print $1}')" || ACCESS_IP=""
if [ -z "$ACCESS_IP" ]; then
    ACCESS_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')" || ACCESS_IP=""
fi
if [ -z "$ACCESS_IP" ]; then
    ACCESS_IP="$(hostname)"
fi

echo
echo "== done =="
say "URL:      $SCHEME://$ACCESS_IP:$LP_PORT/"
say "Login:    any Linux account; members of sudo/wheel/admin get admin rights"
say "Config:   $CONF_DIR/config.json"
say "Port:     edit \"port\" in $CONF_DIR/config.json then: systemctl restart $SERVICE"
say "Logs:     journalctl -u $SERVICE -f"
say "Remove:   sudo $LP_DIR/uninstall.sh"
