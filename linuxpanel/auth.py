import grp
import os
import pwd
import secrets
import socket
import threading
import time

from . import VERSION
from . import audit
from . import config
from . import pamauth
from . import state

RATE_WINDOW = 600.0
RATE_MAX_FAILS = 5
RATE_LOCKOUT = 900.0
SESSION_TOUCH = 60.0

_rl_lock = threading.Lock()
_fails = {}
_locked = {}

_sess_lock = threading.RLock()
_sessions = {}
_sessions_loaded = False

_hostname = None


class LoginError(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


class User:
    def __init__(self, name, uid, gid, home, shell, groups, admin):
        self.name = name
        self.uid = uid
        self.gid = gid
        self.home = home
        self.shell = shell
        self.groups = groups
        self.admin = admin

    def to_dict(self):
        return {
            "name": self.name,
            "uid": self.uid,
            "gid": self.gid,
            "home": self.home,
            "shell": self.shell,
            "admin": self.admin,
            "version": VERSION,
            "hostname": hostname(),
        }


def hostname():
    global _hostname
    if _hostname is None:
        try:
            _hostname = socket.gethostname()
        except OSError:
            _hostname = "localhost"
    return _hostname


def admin_groups():
    groups = config.get("admin_groups", [])
    return [name for name in groups if isinstance(name, str)]


def has_login_shell(shell):
    if not shell:
        return False
    return os.path.basename(shell) not in ("nologin", "false")


def _group_names(pw):
    try:
        gids = os.getgrouplist(pw.pw_name, pw.pw_gid)
    except OSError:
        gids = [pw.pw_gid]
    names = []
    for gid in gids:
        try:
            names.append(grp.getgrgid(gid).gr_name)
        except KeyError:
            continue
    return names


def _build(pw):
    groups = _group_names(pw)
    wanted = admin_groups()
    admin = pw.pw_uid == 0 or any(name in groups for name in wanted)
    return User(pw.pw_name, pw.pw_uid, pw.pw_gid, pw.pw_dir, pw.pw_shell, groups, admin)


def get_user(name):
    if not isinstance(name, str) or not name:
        return None
    try:
        pw = pwd.getpwnam(name)
    except KeyError:
        return None
    return _build(pw)


def get_user_by_uid(uid):
    try:
        pw = pwd.getpwuid(uid)
    except KeyError:
        return None
    return _build(pw)


def is_admin(name):
    user = get_user(name)
    return bool(user and user.admin)


def _prune(now):
    if len(_fails) > 512:
        for key in list(_fails):
            stamps = [stamp for stamp in _fails[key] if now - stamp < RATE_WINDOW]
            if stamps:
                _fails[key] = stamps
            else:
                del _fails[key]
    if len(_locked) > 512:
        for key in list(_locked):
            if _locked[key] <= now:
                del _locked[key]


def rate_limited(keys):
    now = time.time()
    with _rl_lock:
        _prune(now)
        remaining = 0.0
        for key in keys:
            until = _locked.get(key, 0.0)
            if until > now:
                remaining = max(remaining, until - now)
        return remaining


def _record_failure(keys):
    now = time.time()
    with _rl_lock:
        _prune(now)
        for key in keys:
            stamps = [stamp for stamp in _fails.get(key, []) if now - stamp < RATE_WINDOW]
            stamps.append(now)
            if len(stamps) >= RATE_MAX_FAILS:
                _locked[key] = now + RATE_LOCKOUT
                _fails[key] = []
            else:
                _fails[key] = stamps


def _clear_failures(keys):
    with _rl_lock:
        for key in keys:
            _fails.pop(key, None)
            _locked.pop(key, None)


def session_ttl():
    try:
        hours = float(config.get("session_hours", 12))
    except (TypeError, ValueError):
        hours = 12.0
    return max(60.0, hours * 3600.0)


def _load_sessions():
    global _sessions_loaded
    if _sessions_loaded:
        return
    with _sess_lock:
        if _sessions_loaded:
            return
        data = state.read_json(state.sessions_path(), {})
        items = data.get("sessions") if isinstance(data, dict) else None
        now = time.time()
        ttl = session_ttl()
        if isinstance(items, dict):
            for token, info in items.items():
                if not isinstance(token, str) or not isinstance(info, dict):
                    continue
                name = info.get("user")
                if not isinstance(name, str) or not name:
                    continue
                try:
                    last_seen = float(info.get("last_seen") or 0)
                    created = float(info.get("created") or last_seen)
                except (TypeError, ValueError):
                    continue
                if now - last_seen > ttl:
                    continue
                _sessions[token] = {
                    "user": name,
                    "ip": info.get("ip"),
                    "created": created,
                    "last_seen": last_seen,
                }
        _sessions_loaded = True


def _save_sessions():
    state.write_json(state.sessions_path(), {"sessions": _sessions}, 0o600)


def create_session(name, ip):
    _load_sessions()
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _sess_lock:
        _sessions[token] = {"user": name, "ip": ip, "created": now, "last_seen": now}
        _save_sessions()
    return token


def get_session(token):
    if not isinstance(token, str) or not token:
        return None
    _load_sessions()
    now = time.time()
    ttl = session_ttl()
    with _sess_lock:
        info = _sessions.get(token)
        if info is None:
            return None
        if now - info["last_seen"] > ttl:
            del _sessions[token]
            _save_sessions()
            return None
        if now - info["last_seen"] >= SESSION_TOUCH:
            info["last_seen"] = now
            _save_sessions()
        return dict(info)


def destroy_session(token):
    if not isinstance(token, str) or not token:
        return False
    _load_sessions()
    with _sess_lock:
        if _sessions.pop(token, None) is None:
            return False
        _save_sessions()
    return True


def destroy_user_sessions(name):
    _load_sessions()
    removed = 0
    with _sess_lock:
        for token in [key for key, info in _sessions.items() if info.get("user") == name]:
            del _sessions[token]
            removed += 1
        if removed:
            _save_sessions()
    return removed


def session_cookie(token, clear=False):
    parts = ["lp_session=" + ("" if clear else token), "HttpOnly", "SameSite=Strict", "Path=/"]
    if clear:
        parts.append("Max-Age=0")
    else:
        parts.append("Max-Age=%d" % int(session_ttl()))
    if config.get("tls"):
        parts.append("Secure")
    return "; ".join(parts)


def login(username, password, ip):
    if not isinstance(username, str):
        username = ""
    username = username.strip()
    if not isinstance(password, str):
        password = ""
    if not username or not password:
        raise LoginError(400, "username and password are required")
    keys = ["ip:" + str(ip or ""), "user:" + username]
    wait = rate_limited(keys)
    if wait > 0:
        audit.log("login_failed", user=username, ip=ip, detail="rate limited", ok=False)
        minutes = max(1, int(wait / 60.0 + 0.999))
        raise LoginError(429, "too many failed attempts, try again in %d minutes" % minutes)
    user = get_user(username)
    if user is None:
        _record_failure(keys)
        audit.log("login_failed", user=username, ip=ip, detail="unknown user", ok=False)
        raise LoginError(401, "invalid username or password")
    if not has_login_shell(user.shell):
        audit.log("login_failed", user=username, ip=ip, detail="no login shell", ok=False)
        raise LoginError(403, "account has no login shell")
    if username in state.get_panel_blocked():
        audit.log("login_failed", user=username, ip=ip, detail="panel blocked", ok=False)
        raise LoginError(403, "account is blocked")
    login_group = config.get("login_group") or ""
    if login_group and user.uid != 0 and login_group not in user.groups:
        audit.log("login_failed", user=username, ip=ip, detail="login group", ok=False)
        raise LoginError(403, "account is not allowed to use the panel")
    ok, message = pamauth.authenticate(config.get("pam_service") or "linuxpanel", username, password)
    if not ok:
        _record_failure(keys)
        audit.log("login_failed", user=username, ip=ip, detail=message, ok=False)
        raise LoginError(401, "invalid username or password")
    _clear_failures(keys)
    token = create_session(username, ip)
    audit.log("login", user=username, ip=ip, ok=True)
    return token, user
