import base64
import grp
import hashlib
import pwd
import re
import subprocess

from . import audit
from . import auth
from . import state
from . import security
from .files import run_worker
from .httpd import ApiError, route

NAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
KEY_TYPES = (
    "ssh-rsa",
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
    "ssh-dss",
)
DEFAULT_UID_MIN = 1000
NOBODY_UID = 65534


def _run(args, timeout=30, data=None):
    try:
        return subprocess.run(
            args,
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise ApiError(400, "%s is not available on this server" % args[0])
    except subprocess.TimeoutExpired:
        raise ApiError(400, "%s timed out" % args[0])
    except OSError as exc:
        raise ApiError(400, "cannot run %s: %s" % (args[0], exc))


def _check(proc, message):
    if proc.returncode != 0:
        text = (proc.stderr or b"").decode("utf-8", "replace").strip()
        raise ApiError(400, text or message)


def _name(value):
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise ApiError(400, "invalid username")
    return value


def _group_names():
    return {entry.gr_name for entry in grp.getgrall()}


def _groups(value):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, "groups must be a list")
    known = _group_names()
    result = []
    for item in value:
        if not isinstance(item, str) or not item:
            raise ApiError(400, "invalid group name")
        if item not in known:
            raise ApiError(400, "unknown group: %s" % item)
        if item not in result:
            result.append(item)
    return result


def _shell(value):
    shell = value if isinstance(value, str) and value else "/bin/bash"
    try:
        with open("/etc/shells", "r", encoding="utf-8", errors="replace") as handle:
            shells = [line.strip() for line in handle if line.strip() and not line.startswith("#")]
    except OSError:
        shells = []
    if shells and shell not in shells:
        raise ApiError(400, "invalid shell: %s" % shell)
    return shell


def _password(value):
    if not isinstance(value, str) or not value:
        raise ApiError(400, "password is required")
    if "\n" in value or "\r" in value:
        raise ApiError(400, "invalid password")
    return value


def _set_password(name, password):
    payload = ("%s:%s\n" % (name, password)).encode("utf-8")
    _check(_run(["chpasswd"], data=payload), "cannot set password")


def _uid_min():
    try:
        with open("/etc/login.defs", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "UID_MIN":
                    return int(parts[1])
    except (OSError, ValueError):
        pass
    return DEFAULT_UID_MIN


def sudo_group():
    names = _group_names()
    if "sudo" in names:
        return "sudo"
    if "wheel" in names:
        return "wheel"
    return None


def _supplementary(pw):
    result = []
    for entry in grp.getgrall():
        if pw.pw_name in entry.gr_mem and entry.gr_gid != pw.pw_gid:
            result.append(entry.gr_name)
    result.sort()
    return result


def _locked(name):
    proc = _run(["passwd", "-S", name], timeout=15)
    if proc.returncode != 0:
        return False
    fields = (proc.stdout or b"").decode("utf-8", "replace").split()
    if len(fields) < 2:
        return False
    return fields[1].upper().startswith("L")


def _authkeys(name):
    try:
        result = run_worker(name, {"op": "authkeys_read"}, timeout=15)
    except ApiError:
        return []
    lines = result.get("lines")
    if not isinstance(lines, list):
        return []
    return [line for line in lines if isinstance(line, str)]


def _fingerprint(blob):
    padded = blob + "=" * (-len(blob) % 4)
    try:
        raw = base64.b64decode(padded, validate=True)
    except (ValueError, TypeError):
        return None
    if not raw:
        return None
    digest = hashlib.sha256(raw).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _parse_key(line):
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    tokens = text.split()
    index = None
    for position, token in enumerate(tokens):
        if token in KEY_TYPES:
            index = position
            break
    if index is None or index + 1 >= len(tokens):
        return None
    blob = tokens[index + 1]
    fingerprint = _fingerprint(blob)
    if fingerprint is None:
        return None
    return {
        "type": tokens[index],
        "comment": " ".join(tokens[index + 2 :]),
        "fingerprint": fingerprint,
        "line": text,
    }


@route("GET", "/api/accounts", auth="admin")
def api_accounts(req):
    system = req.query.get("system") in ("1", "true", "yes")
    uid_min = _uid_min()
    blocked = set(state.get_panel_blocked())
    denied = set(security.get_ssh_denied())
    group = sudo_group()
    users = []
    for pw in sorted(pwd.getpwall(), key=lambda item: item.pw_name):
        if pw.pw_uid == NOBODY_UID:
            continue
        if not system and pw.pw_uid != 0 and pw.pw_uid < uid_min:
            continue
        groups = _supplementary(pw)
        users.append(
            {
                "name": pw.pw_name,
                "uid": pw.pw_uid,
                "gid": pw.pw_gid,
                "home": pw.pw_dir,
                "shell": pw.pw_shell,
                "groups": groups,
                "sudo": bool(group and group in groups),
                "locked": _locked(pw.pw_name),
                "panel_blocked": pw.pw_name in blocked,
                "ssh_blocked": pw.pw_name in denied,
                "system": pw.pw_uid < uid_min and pw.pw_uid != 0,
                "keys_count": None,
            }
        )
    if len(users) <= 50:
        for entry in users:
            try:
                result = run_worker(entry["name"], {"op": "authkeys_read"}, timeout=15)
                lines = result.get("lines")
                entry["keys_count"] = len([line for line in lines if isinstance(line, str) and _parse_key(line)]) if isinstance(lines, list) else 0
            except ApiError:
                entry["keys_count"] = None
    return {"users": users, "sudo_group": group, "uid_min": uid_min}


@route("GET", "/api/groups", auth="admin")
def api_groups(req):
    groups = []
    for entry in sorted(grp.getgrall(), key=lambda item: item.gr_name):
        groups.append({"name": entry.gr_name, "gid": entry.gr_gid, "members": list(entry.gr_mem)})
    return {"groups": groups}


@route("POST", "/api/accounts/create", auth="admin")
def api_accounts_create(req):
    data = req.json()
    name = _name(data.get("name"))
    password = _password(data.get("password"))
    shell = _shell(data.get("shell"))
    sudo = bool(data.get("sudo"))
    groups = _groups(data.get("groups"))
    if auth.get_user(name) is not None:
        raise ApiError(400, "user already exists: %s" % name)
    _check(_run(["useradd", "-m", "-s", shell, name]), "cannot create user")
    try:
        _set_password(name, password)
        group = sudo_group()
        if sudo and group:
            _check(_run(["gpasswd", "-a", name, group]), "cannot add user to %s" % group)
        if groups:
            _check(_run(["usermod", "-aG", ",".join(groups), name]), "cannot set groups")
    except ApiError:
        _run(["userdel", "-r", name], timeout=60)
        raise
    audit.log("account_create", user=req.user.name, ip=req.ip, target=name, detail=shell, ok=True)
    return {"ok": True}


@route("POST", "/api/accounts/delete", auth="admin")
def api_accounts_delete(req):
    data = req.json()
    name = _name(data.get("name"))
    remove_home = bool(data.get("remove_home"))
    if name == "root":
        raise ApiError(400, "refusing to delete root")
    if name == req.user.name:
        raise ApiError(400, "refusing to delete the current user")
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    args = ["userdel", "-r", name] if remove_home else ["userdel", name]
    _check(_run(args, timeout=60), "cannot delete user")
    auth.destroy_user_sessions(name)
    audit.log("account_delete", user=req.user.name, ip=req.ip, target=name, detail=remove_home, ok=True)
    return {"ok": True}


@route("POST", "/api/accounts/password", auth="admin")
def api_accounts_password(req):
    data = req.json()
    name = _name(data.get("name"))
    password = _password(data.get("password"))
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    _set_password(name, password)
    audit.log("password_reset", user=req.user.name, ip=req.ip, target=name, ok=True)
    return {"ok": True}


@route("POST", "/api/accounts/groups", auth="admin")
def api_accounts_groups(req):
    data = req.json()
    name = _name(data.get("name"))
    groups = _groups(data.get("groups"))
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    _check(_run(["usermod", "-G", ",".join(groups), name]), "cannot set groups")
    audit.log("groups_set", user=req.user.name, ip=req.ip, target=name, detail=groups, ok=True)
    return {"ok": True, "groups": groups}


@route("POST", "/api/accounts/sudo", auth="admin")
def api_accounts_sudo(req):
    data = req.json()
    name = _name(data.get("name"))
    enabled = bool(data.get("enabled"))
    group = sudo_group()
    if group is None:
        raise ApiError(400, "no sudo group available")
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    flag = "-a" if enabled else "-d"
    _check(_run(["gpasswd", flag, name, group]), "cannot change sudo membership")
    audit.log("sudo_set", user=req.user.name, ip=req.ip, target=name, detail=enabled, ok=True)
    return {"ok": True, "sudo": enabled}


@route("POST", "/api/accounts/lock", auth="admin")
def api_accounts_lock(req):
    data = req.json()
    name = _name(data.get("name"))
    locked = bool(data.get("locked"))
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    flag = "-l" if locked else "-u"
    _check(_run(["passwd", flag, name]), "cannot change lock state")
    if locked:
        auth.destroy_user_sessions(name)
    audit.log("account_lock", user=req.user.name, ip=req.ip, target=name, detail=locked, ok=True)
    return {"ok": True, "locked": locked}


@route("POST", "/api/accounts/panel-block", auth="admin")
def api_accounts_panel_block(req):
    data = req.json()
    name = _name(data.get("name"))
    blocked = bool(data.get("blocked"))
    if blocked and name == req.user.name:
        raise ApiError(400, "refusing to block the current user")
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    names = state.set_panel_blocked(name, blocked)
    if blocked:
        auth.destroy_user_sessions(name)
    audit.log("panel_block", user=req.user.name, ip=req.ip, target=name, detail=blocked, ok=True)
    return {"ok": True, "panel_blocked": names}


@route("POST", "/api/accounts/ssh-block", auth="admin")
def api_accounts_ssh_block(req):
    data = req.json()
    name = _name(data.get("name"))
    blocked = bool(data.get("blocked"))
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    denied = security.set_ssh_denied(name, blocked)
    audit.log("ssh_block", user=req.user.name, ip=req.ip, target=name, detail=blocked, ok=True)
    return {"ok": True, "ssh_denied": denied}


@route("GET", "/api/accounts/keys", auth="admin")
def api_accounts_keys(req):
    name = _name(req.query.get("name"))
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    keys = []
    for line in _authkeys(name):
        parsed = _parse_key(line)
        if parsed is not None:
            keys.append(parsed)
    return {"keys": keys}


@route("POST", "/api/accounts/keys/add", auth="admin")
def api_accounts_keys_add(req):
    data = req.json()
    name = _name(data.get("name"))
    key = data.get("key")
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    if not isinstance(key, str) or not key.strip() or "\n" in key or "\r" in key:
        raise ApiError(400, "invalid public key")
    parsed = _parse_key(key)
    if parsed is None:
        raise ApiError(400, "invalid public key")
    lines = _authkeys(name)
    for line in lines:
        existing = _parse_key(line)
        if existing is not None and existing["fingerprint"] == parsed["fingerprint"]:
            raise ApiError(400, "key already present")
    lines.append(parsed["line"])
    try:
        run_worker(name, {"op": "authkeys_write", "lines": lines}, timeout=30)
    except ApiError as exc:
        raise ApiError(400, exc.message)
    audit.log("key_add", user=req.user.name, ip=req.ip, target=name, detail=parsed["fingerprint"], ok=True)
    return {"ok": True, "fingerprint": parsed["fingerprint"]}


@route("POST", "/api/accounts/keys/remove", auth="admin")
def api_accounts_keys_remove(req):
    data = req.json()
    name = _name(data.get("name"))
    fingerprint = data.get("fingerprint")
    if auth.get_user(name) is None:
        raise ApiError(400, "no such user: %s" % name)
    if not isinstance(fingerprint, str) or not fingerprint:
        raise ApiError(400, "fingerprint is required")
    lines = _authkeys(name)
    kept = []
    removed = 0
    for line in lines:
        parsed = _parse_key(line)
        if parsed is not None and parsed["fingerprint"] == fingerprint:
            removed += 1
            continue
        kept.append(line)
    if not removed:
        raise ApiError(400, "key not found")
    try:
        run_worker(name, {"op": "authkeys_write", "lines": kept}, timeout=30)
    except ApiError as exc:
        raise ApiError(400, exc.message)
    audit.log("key_remove", user=req.user.name, ip=req.ip, target=name, detail=fingerprint, ok=True)
    return {"ok": True}


def _last_lines(args):
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    return (proc.stdout or b"").decode("utf-8", "replace").splitlines()


def _parse_last(line, failed=False):
    text = line.strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered.startswith("wtmp begins") or lowered.startswith("btmp begins"):
        return None
    parts = text.split()
    if len(parts) < 4:
        return None
    if parts[0] in ("reboot", "shutdown", "runlevel"):
        return None
    user, tty, host = parts[0], parts[1], parts[2]
    rest = " ".join(parts[3:])
    start = rest
    end = ""
    if " - " in rest:
        start, end = rest.split(" - ", 1)
    elif "still logged in" in rest:
        start = rest.replace("still logged in", "").strip()
        end = "still logged in"
    elif "gone - no logout" in rest:
        start = rest.replace("gone - no logout", "").strip()
    entry = {"user": user, "tty": tty, "host": host, "start": start.strip(), "raw": text}
    if not failed:
        entry["end"] = end.strip()
    return entry


@route("GET", "/api/logins", auth="admin")
def api_logins(req):
    ssh = []
    for line in _last_lines(["last", "-F", "-w", "-n", "100"]):
        entry = _parse_last(line)
        if entry is not None:
            ssh.append(entry)
    failed = []
    for line in _last_lines(["lastb", "-F", "-w", "-n", "100"]):
        entry = _parse_last(line, failed=True)
        if entry is not None:
            failed.append(entry)
    return {
        "ssh": ssh,
        "failed": failed,
        "panel": audit.read(200, actions=["login", "login_failed"]),
    }
