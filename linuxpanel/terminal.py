import errno
import fcntl
import json
import os
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import threading

from . import config
from . import privdrop
from .httpd import ApiError, route, ws_route

SOCKET = "linuxpanel"
ID_RE = re.compile(r"^[a-z0-9]{1,16}$")
TMUX_CONF = os.path.join(config.INSTALL_DIR, "tmux.conf")
READ_SIZE = 65536


def _clamp(value, default, low, high):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            return
        if written <= 0:
            return
        view = view[written:]


def _terminate(proc):
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGHUP)
    except OSError:
        pass
    try:
        proc.wait(timeout=1.0)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=3)
    except (subprocess.TimeoutExpired, OSError):
        pass


def _tmux(username, args, timeout=10):
    try:
        proc = privdrop.popen_as(
            username,
            ["tmux", "-L", SOCKET] + list(args),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        raise ApiError(400, "tmux is not installed on this server")
    except PermissionError as exc:
        raise ApiError(400, str(exc))
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.communicate(timeout=5)
        except (subprocess.TimeoutExpired, OSError):
            pass
        raise ApiError(504, "tmux timed out")
    return proc.returncode, out or b"", err or b""


def _target(session_id):
    if not isinstance(session_id, str) or not ID_RE.match(session_id):
        raise ApiError(400, "invalid session id")
    return "lp-" + session_id


def _terminal_state(username, session_id):
    code, out, err = _tmux(
        username,
        [
            "display-message",
            "-p",
            "-t",
            _target(session_id),
            "#{window_panes}\t#{pane_marked}\t#{pane_marked_set}\t#{window_zoomed_flag}\t#{pane_in_mode}",
        ],
    )
    if code != 0:
        message = err.decode("utf-8", "replace").strip() or "session not found"
        raise ApiError(400, message)
    fields = out.decode("utf-8", "replace").strip().split("\t")
    if len(fields) != 5:
        raise ApiError(500, "unexpected tmux state")
    return {
        "panes": _clamp(fields[0], 1, 1, 10000),
        "marked": fields[1] == "1",
        "marked_set": fields[2] == "1",
        "zoomed": fields[3] == "1",
        "in_mode": fields[4] == "1",
    }


def _action_commands(action, target, text):
    if action in ("search-selection", "type-selection"):
        if not isinstance(text, str) or not text or len(text) > 10000:
            raise ApiError(400, "invalid selection")
        if action == "search-selection":
            return [
                ["copy-mode", "-t", target],
                ["send-keys", "-X", "-t", target, "search-backward", "--", text],
            ]
        return [
            ["copy-mode", "-q", "-t", target],
            ["send-keys", "-l", "-t", target, "--", text],
        ]
    commands = {
        "split-horizontal": [["split-window", "-h", "-t", target, "-c", "#{pane_current_path}"]],
        "split-vertical": [["split-window", "-v", "-t", target, "-c", "#{pane_current_path}"]],
        "swap-up": [["swap-pane", "-U", "-t", target]],
        "swap-down": [["swap-pane", "-D", "-t", target]],
        "swap-marked": [["swap-pane", "-t", target]],
        "kill-pane": [["kill-pane", "-t", target]],
        "respawn-pane": [["respawn-pane", "-k", "-t", target]],
        "toggle-mark": [["select-pane", "-m", "-t", target]],
        "toggle-zoom": [["resize-pane", "-Z", "-t", target]],
        "history-top": [["send-keys", "-X", "-t", target, "history-top"]],
        "history-bottom": [["send-keys", "-X", "-t", target, "history-bottom"]],
    }
    if action not in commands:
        raise ApiError(400, "invalid terminal action")
    return commands[action]


@route("GET", "/api/terminal/sessions")
def api_terminal_sessions(req):
    code, out, _ = _tmux(req.user.name, ["list-sessions", "-F", "#{session_name}"])
    if code != 0:
        return {"sessions": []}
    sessions = []
    for line in out.decode("utf-8", "replace").splitlines():
        name = line.strip()
        if not name.startswith("lp-"):
            continue
        session_id = name[3:]
        if ID_RE.match(session_id):
            sessions.append(session_id)
    return {"sessions": sorted(sessions)}


@route("GET", "/api/terminal/status")
def api_terminal_status(req):
    session_id = (req.query.get("id") or "").strip()
    if not ID_RE.match(session_id):
        raise ApiError(400, "invalid session id")
    code, out, err = _tmux(
        req.user.name,
        ["list-panes", "-s", "-t", "lp-" + session_id, "-F", "#{pane_current_command}"],
    )
    if code != 0:
        message = err.decode("utf-8", "replace").strip() or "session not found"
        raise ApiError(400, message)
    shell = os.path.basename(req.user.shell or "/bin/sh")
    commands = [line.strip() for line in out.decode("utf-8", "replace").splitlines()]
    running = any(command and command != shell for command in commands)
    return {"running": running}


@route("GET", "/api/terminal/pane-state")
def api_terminal_pane_state(req):
    session_id = (req.query.get("id") or "").strip()
    return _terminal_state(req.user.name, session_id)


@route("POST", "/api/terminal/action")
def api_terminal_action(req):
    data = req.json()
    target = _target(data.get("id"))
    commands = _action_commands(data.get("action"), target, data.get("text"))
    for args in commands:
        code, _, err = _tmux(req.user.name, args)
        if code != 0:
            message = err.decode("utf-8", "replace").strip() or "terminal action failed"
            raise ApiError(400, message)
    return {"ok": True}


@route("POST", "/api/terminal/kill")
def api_terminal_kill(req):
    data = req.json()
    session_id = data.get("id")
    if not isinstance(session_id, str) or not ID_RE.match(session_id):
        raise ApiError(400, "invalid session id")
    code, _, err = _tmux(req.user.name, ["kill-session", "-t", "lp-" + session_id])
    if code != 0:
        message = err.decode("utf-8", "replace").strip() or "session not found"
        raise ApiError(400, message)
    return {"ok": True}


@ws_route("/ws/terminal")
def ws_terminal(req, ws):
    session_id = (req.query.get("id") or "").strip()
    if not ID_RE.match(session_id):
        ws.send_text(json.dumps({"t": "exit"}))
        return
    cols = _clamp(req.query.get("cols"), 80, 2, 500)
    rows = _clamp(req.query.get("rows"), 24, 2, 300)
    if shutil.which("tmux") is None:
        ws.send_binary(b"tmux is not installed on this server\r\n")
        ws.close(1011)
        return
    user = req.user
    _tmux(user.name, ["source-file", TMUX_CONF])
    cwd = user.home if user.home and os.path.isdir(user.home) else "/"
    master, slave = os.openpty()
    try:
        _set_winsize(slave, cols, rows)
        proc = privdrop.popen_as(
            user.name,
            [
                "tmux",
                "-L",
                SOCKET,
                "-f",
                TMUX_CONF,
                "new-session",
                "-A",
                "-s",
                "lp-" + session_id,
                "-x",
                str(cols),
                "-y",
                str(rows),
            ],
            setsid=True,
            ctty_fd=0,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            env={"TERM": "xterm-256color"},
        )
    except (OSError, PermissionError, subprocess.SubprocessError) as exc:
        os.close(slave)
        os.close(master)
        ws.send_binary(("cannot start tmux: %s\r\n" % exc).encode("utf-8"))
        ws.close(1011)
        return
    os.close(slave)
    stop = threading.Event()

    def _reader():
        while not stop.is_set():
            try:
                ready, _, _ = select.select([master], [], [], 0.5)
            except (OSError, ValueError):
                break
            if stop.is_set():
                break
            if not ready:
                continue
            try:
                data = os.read(master, READ_SIZE)
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                data = b""
            if not data:
                break
            if not ws.send_binary(data):
                break
        if not stop.is_set():
            ws.send_text(json.dumps({"t": "exit"}))
            ws.close(1000)

    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()
    try:
        while True:
            frame = ws.recv()
            if frame is None:
                break
            opcode, payload = frame
            if opcode != 0x1:
                continue
            try:
                message = json.loads(payload.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("t")
            if kind == "i":
                text = message.get("d")
                if isinstance(text, str) and text:
                    _write_all(master, text.encode("utf-8"))
            elif kind == "r":
                new_cols = _clamp(message.get("c"), cols, 2, 500)
                new_rows = _clamp(message.get("r"), rows, 2, 300)
                try:
                    _set_winsize(master, new_cols, new_rows)
                except OSError:
                    pass
    finally:
        stop.set()
        _terminate(proc)
        try:
            os.close(master)
        except OSError:
            pass
        thread.join(timeout=2)
