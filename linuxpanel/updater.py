import os
import subprocess
import threading

from . import VERSION
from . import audit
from . import config


class UpdateError(Exception):
    pass


def install_dir():
    return config.INSTALL_DIR


def is_git():
    return os.path.isdir(os.path.join(install_dir(), ".git"))


def _git(args, timeout=60):
    try:
        proc = subprocess.run(
            ["git"] + list(args),
            cwd=install_dir(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise UpdateError("git failed: %s" % exc)
    out = proc.stdout.decode("utf-8", "replace").strip()
    err = proc.stderr.decode("utf-8", "replace").strip()
    return proc.returncode, out, err


def current_commit():
    if not is_git():
        return None
    code, out, _ = _git(["rev-parse", "--short", "HEAD"])
    return out if code == 0 and out else None


def settings_info():
    return {
        "version": VERSION,
        "commit": current_commit(),
        "port": config.get("port"),
        "bind": config.get("bind"),
        "tls": bool(config.get("tls")),
        "repo": config.get("repo"),
        "branch": config.get("branch"),
        "install_dir": install_dir(),
        "is_git": is_git(),
    }


def check_update():
    if not is_git():
        raise UpdateError("not a git repository")
    repo = config.get("repo")
    if not repo or "YOUR_GITHUB_USER" in repo:
        repo = "origin"
    branch = config.get("branch") or "main"
    current = current_commit()
    code, out, err = _git(["ls-remote", repo, "refs/heads/" + branch])
    if code != 0:
        raise UpdateError(err or "git ls-remote failed")
    latest = None
    wanted = "refs/heads/" + branch
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == wanted:
            latest = parts[0][:7]
            break
    if latest is None:
        raise UpdateError("branch %s not found" % branch)
    return {
        "current": current,
        "latest": latest,
        "update_available": bool(current and current != latest),
    }


def schedule_restart(delay=1.0):
    timer = threading.Timer(delay, _restart)
    timer.daemon = True
    timer.start()
    return timer


def _restart():
    name = config.get("service_name") or "linuxpanel"
    try:
        subprocess.Popen(
            ["systemctl", "restart", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def apply_update(user=None, ip=None):
    if not is_git():
        raise UpdateError("not a git repository")
    branch = config.get("branch") or "main"
    before = current_commit()
    code, _, err = _git(["fetch", "origin", branch], timeout=180)
    if code != 0:
        raise UpdateError(err or "git fetch failed")
    code, _, err = _git(["reset", "--hard", "origin/" + branch])
    if code != 0:
        raise UpdateError(err or "git reset failed")
    after = current_commit()
    audit.log(
        "update",
        user=user,
        ip=ip,
        target=install_dir(),
        detail="%s -> %s" % (before, after),
        ok=True,
    )
    schedule_restart()
    return {"ok": True, "from": before, "to": after}
