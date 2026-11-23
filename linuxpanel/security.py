import os
import shutil
import subprocess
import tempfile
import threading

from . import audit
from . import state
from .httpd import ApiError, route

SSHD_CONFIG = "/etc/ssh/sshd_config"
BACKUP = SSHD_CONFIG + ".linuxpanel.bak"
BEGIN = "# BEGIN LINUXPANEL MANAGED BLOCK - do not edit"
END = "# END LINUXPANEL MANAGED BLOCK"
SSHD_CANDIDATES = ("/usr/sbin/sshd", "/usr/local/sbin/sshd", "/sbin/sshd")
RUNTIME_DIR = "/run/sshd"

_lock = threading.RLock()


def _sshd_bin():
    for path in SSHD_CANDIDATES:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return shutil.which("sshd")


def sshd_installed():
    return os.path.isfile(SSHD_CONFIG) and _sshd_bin() is not None


def _require_sshd():
    if not sshd_installed():
        raise ApiError(400, "OpenSSH server not installed")


def _read_config():
    try:
        with open(SSHD_CONFIG, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ApiError(400, "cannot read %s: %s" % (SSHD_CONFIG, exc))


def _split(text):
    lines = text.splitlines()
    begin = None
    end = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == BEGIN and begin is None:
            begin = index
        elif stripped == END and begin is not None:
            end = index
            break
    if begin is None or end is None:
        return [], lines
    return lines[begin + 1 : end], lines[:begin] + lines[end + 1 :]


def _parse_block(block):
    root_blocked = False
    denied = []
    for line in block:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split(None, 1)
        key = parts[0].lower()
        value = parts[1].strip() if len(parts) > 1 else ""
        if key == "permitrootlogin":
            root_blocked = value.lower() == "no"
        elif key == "denyusers":
            denied = [item for item in value.split() if item]
    return root_blocked, denied


def _compose(block, rest):
    lines = []
    if block:
        lines = [BEGIN] + list(block) + [END]
    return "\n".join(lines + list(rest)) + "\n"


def _build_block(root_blocked, denied):
    block = []
    if root_blocked:
        block.append("PermitRootLogin no")
    if denied:
        block.append("DenyUsers " + " ".join(denied))
    return block


def _ensure_runtime():
    if os.path.isdir(RUNTIME_DIR):
        return
    try:
        os.makedirs(RUNTIME_DIR, mode=0o755, exist_ok=True)
        os.chmod(RUNTIME_DIR, 0o755)
    except OSError:
        pass


def _validate():
    binary = _sshd_bin()
    if binary is None:
        return True, ""
    _ensure_runtime()
    try:
        proc = subprocess.run(
            [binary, "-t"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    if proc.returncode == 0:
        return True, ""
    return False, (proc.stderr or b"").decode("utf-8", "replace").strip()


def _reload():
    for unit in ("ssh", "sshd"):
        try:
            proc = subprocess.run(
                ["systemctl", "reload", unit],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=20,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0:
            return True
    return False


def _apply(block):
    with _lock:
        text = _read_config()
        if text is None:
            raise ApiError(400, "OpenSSH server not installed")
        _, rest = _split(text)
        content = _compose(block, rest)
        try:
            shutil.copy2(SSHD_CONFIG, BACKUP)
        except OSError as exc:
            raise ApiError(400, "cannot back up sshd_config: %s" % exc)
        try:
            info = os.stat(SSHD_CONFIG)
        except OSError as exc:
            raise ApiError(400, "cannot stat sshd_config: %s" % exc)
        directory = os.path.dirname(SSHD_CONFIG)
        fd, tmp = tempfile.mkstemp(prefix=".sshd_config.", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, info.st_mode & 0o7777)
            try:
                os.chown(tmp, info.st_uid, info.st_gid)
            except OSError:
                pass
            os.replace(tmp, SSHD_CONFIG)
        except OSError as exc:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise ApiError(400, "cannot write sshd_config: %s" % exc)
        ok, message = _validate()
        if not ok:
            try:
                shutil.copy2(BACKUP, SSHD_CONFIG)
            except OSError:
                pass
            raise ApiError(400, "sshd rejected the configuration: %s" % (message or "unknown error"))
        _reload()
        return block


def get_ssh_denied():
    text = _read_config()
    if text is None:
        return []
    block, _ = _split(text)
    _, denied = _parse_block(block)
    return denied


def get_root_ssh_blocked():
    text = _read_config()
    if text is None:
        return False
    block, _ = _split(text)
    root_blocked, _ = _parse_block(block)
    return root_blocked


def set_ssh_denied(name, blocked):
    _require_sshd()
    with _lock:
        text = _read_config()
        if text is None:
            raise ApiError(400, "OpenSSH server not installed")
        block, _ = _split(text)
        root_blocked, denied = _parse_block(block)
        if blocked:
            if name not in denied:
                denied.append(name)
        else:
            denied = [item for item in denied if item != name]
        denied.sort()
        _apply(_build_block(root_blocked, denied))
        return denied


def set_root_ssh_blocked(blocked):
    _require_sshd()
    with _lock:
        text = _read_config()
        if text is None:
            raise ApiError(400, "OpenSSH server not installed")
        block, _ = _split(text)
        _, denied = _parse_block(block)
        _apply(_build_block(bool(blocked), denied))
        return bool(blocked)


def _effective():
    binary = _sshd_bin()
    if binary is None:
        return None
    _ensure_runtime()
    try:
        proc = subprocess.run(
            [binary, "-T"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    values = {}
    for line in (proc.stdout or b"").decode("utf-8", "replace").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        values[parts[0].lower()] = parts[1].strip().lower()
    return values


def root_locked():
    try:
        proc = subprocess.run(
            ["passwd", "-S", "root"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    fields = (proc.stdout or b"").decode("utf-8", "replace").split()
    if len(fields) < 2:
        return False
    return fields[1].upper().startswith("L")


def _set_root_password_locked(locked):
    flag = "-l" if locked else "-u"
    try:
        proc = subprocess.run(
            ["passwd", flag, "root"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ApiError(400, "cannot change root password state: %s" % exc)
    if proc.returncode != 0:
        message = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise ApiError(400, message or "cannot change root password state")


@route("GET", "/api/security", auth="admin")
def api_security(req):
    effective = _effective()
    return {
        "sshd_installed": sshd_installed(),
        "sshd_config_path": SSHD_CONFIG,
        "root_ssh_blocked": get_root_ssh_blocked(),
        "permit_root_login_effective": (effective or {}).get("permitrootlogin"),
        "password_auth_effective": (effective or {}).get("passwordauthentication"),
        "ssh_denied": get_ssh_denied(),
        "panel_blocked": state.get_panel_blocked(),
        "root_locked": root_locked(),
    }


@route("POST", "/api/security/root-ssh", auth="admin")
def api_security_root_ssh(req):
    data = req.json()
    blocked = bool(data.get("blocked"))
    set_root_ssh_blocked(blocked)
    audit.log("root_ssh", user=req.user.name, ip=req.ip, target="root", detail=blocked, ok=True)
    return {"ok": True, "root_ssh_blocked": blocked}


@route("POST", "/api/security/harden-root", auth="admin")
def api_security_harden_root(req):
    data = req.json()
    enabled = bool(data.get("enabled"))
    warnings = []
    _set_root_password_locked(enabled)
    set_root_ssh_blocked(enabled)
    if enabled:
        if req.user.name == "root":
            warnings.append("panel block of root skipped because the current user is root")
        else:
            state.set_panel_blocked("root", True)
    else:
        state.set_panel_blocked("root", False)
    audit.log("harden_root", user=req.user.name, ip=req.ip, target="root", detail=enabled, ok=True)
    return {"ok": True, "warnings": warnings}
