import fcntl
import os
import pwd
import subprocess
import termios

from . import config

PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DEFAULT_LANG = "C.UTF-8"


def system_lang():
    try:
        with open("/etc/default/locale", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() == "LANG":
                    value = value.strip().strip('"').strip("'")
                    if value:
                        return value
    except OSError:
        pass
    return DEFAULT_LANG


def user_env(pw):
    return {
        "HOME": pw.pw_dir or "/",
        "USER": pw.pw_name,
        "LOGNAME": pw.pw_name,
        "SHELL": pw.pw_shell or "/bin/sh",
        "PATH": PATH,
        "LANG": system_lang(),
    }


def _lookup(username):
    try:
        return pwd.getpwnam(username)
    except KeyError:
        raise PermissionError("unknown user: %s" % username)


def _check(username, pw):
    current = os.getuid()
    if current == 0:
        return
    if pw.pw_uid != current:
        raise PermissionError("cannot run as %s" % username)


def drop_privileges_fn(username, setsid=False, ctty_fd=None):
    pw = _lookup(username)
    _check(username, pw)
    uid = pw.pw_uid
    gid = pw.pw_gid
    name = pw.pw_name
    is_root = os.getuid() == 0

    def _preexec():
        if setsid:
            os.setsid()
        if ctty_fd is not None:
            fcntl.ioctl(ctty_fd, termios.TIOCSCTTY, 0)
        if not is_root:
            return
        if uid == 0:
            return
        os.initgroups(name, gid)
        os.setgid(gid)
        os.setuid(uid)

    return _preexec


def popen_as(username, args, setsid=False, ctty_fd=None, **popen_kwargs):
    pw = _lookup(username)
    _check(username, pw)
    env = user_env(pw)
    extra_env = popen_kwargs.pop("env", None)
    if extra_env:
        env.update(extra_env)
    popen_kwargs["env"] = env
    popen_kwargs.setdefault("close_fds", True)
    popen_kwargs["preexec_fn"] = drop_privileges_fn(username, setsid=setsid, ctty_fd=ctty_fd)
    return subprocess.Popen(args, **popen_kwargs)


def install_dir():
    return config.INSTALL_DIR
