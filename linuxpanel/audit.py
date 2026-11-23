import datetime
import json
import os
import threading

from . import config
from . import state

TAIL_BYTES = 2 * 1024 * 1024

_lock = threading.Lock()


def log_path():
    return os.path.join(config.LOG_DIR, "audit.log")


def _now():
    stamp = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    return stamp.replace("+00:00", "Z")


def log(action, user=None, ip=None, target=None, detail=None, ok=True):
    entry = {
        "ts": _now(),
        "user": user,
        "ip": ip,
        "action": action,
        "target": target,
        "detail": detail,
        "ok": bool(ok),
    }
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _lock:
        try:
            state.ensure_dir(config.LOG_DIR)
            fd = os.open(log_path(), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        except OSError:
            return None
        try:
            os.write(fd, line.encode("utf-8"))
        except OSError:
            return None
        finally:
            os.close(fd)
    return entry


def read(limit=200, actions=None):
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 200
    limit = max(1, min(limit, 5000))
    if isinstance(actions, str):
        actions = [actions]
    wanted = set(actions) if actions else None
    path = log_path()
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    start = max(0, size - TAIL_BYTES)
    try:
        with open(path, "rb") as handle:
            if start:
                handle.seek(start)
            data = handle.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    if start:
        lines = lines[1:]
    entries = []
    for raw in reversed(lines):
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if wanted is not None and entry.get("action") not in wanted:
            continue
        entries.append(entry)
        if len(entries) >= limit:
            break
    return entries
