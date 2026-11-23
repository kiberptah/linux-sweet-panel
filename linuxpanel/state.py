import json
import os
import re
import tempfile
import threading

from . import config

PREFS_LIMIT = 64 * 1024

_lock = threading.RLock()
_USERNAME_RE = re.compile(r"^[A-Za-z0-9._@+-]{1,64}$")


def ensure_dir(path, mode=0o700):
    if os.path.isdir(path):
        return
    os.makedirs(path, mode=mode, exist_ok=True)
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def ensure_dirs():
    ensure_dir(config.STATE_DIR)
    ensure_dir(config.LOG_DIR)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def write_json(path, obj, mode=0o600):
    directory = os.path.dirname(os.path.abspath(path))
    ensure_dir(directory)
    with _lock:
        fd, tmp = tempfile.mkstemp(prefix=".lp-", suffix=".tmp", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(obj, handle, indent=2, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def check_username(name):
    if not isinstance(name, str) or not _USERNAME_RE.match(name):
        raise ValueError("invalid username")
    if name in (".", ".."):
        raise ValueError("invalid username")
    return name


def state_path():
    return os.path.join(config.STATE_DIR, "state.json")


def sessions_path():
    return os.path.join(config.STATE_DIR, "sessions.json")


def prefs_path(user):
    return os.path.join(config.STATE_DIR, "users", check_username(user) + ".json")


def get_global():
    data = read_json(state_path(), {})
    return data if isinstance(data, dict) else {}


def update_global(**values):
    with _lock:
        data = get_global()
        data.update(values)
        write_json(state_path(), data)
        return data


def get_panel_blocked():
    names = get_global().get("panel_blocked")
    if not isinstance(names, list):
        return []
    return [name for name in names if isinstance(name, str)]


def set_panel_blocked(name, blocked):
    name = check_username(name)
    with _lock:
        names = get_panel_blocked()
        if blocked:
            if name not in names:
                names.append(name)
        else:
            names = [item for item in names if item != name]
        names.sort()
        update_global(panel_blocked=names)
        return names


def get_prefs(user):
    data = read_json(prefs_path(user), {})
    return data if isinstance(data, dict) else {}


def merge_prefs(user, partial):
    if not isinstance(partial, dict):
        raise ValueError("prefs must be an object")
    with _lock:
        prefs = get_prefs(user)
        prefs.update(partial)
        encoded = json.dumps(prefs).encode("utf-8")
        if len(encoded) > PREFS_LIMIT:
            raise ValueError("prefs too large")
        write_json(prefs_path(user), prefs)
        return prefs
