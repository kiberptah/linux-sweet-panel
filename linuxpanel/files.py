import json
import os
import subprocess
import sys
import threading
import urllib.parse

from . import audit
from . import config
from . import privdrop
from .httpd import ApiError, StreamResponse, route

CHUNK = 1024 * 1024
WORKER_ARGS = ["-m", "linuxpanel.fsworker"]
SLOW_OPS = ("copy", "move", "delete")


def _worker_env():
    return {"PYTHONPATH": config.INSTALL_DIR, "PYTHONUNBUFFERED": "1"}


def _spawn(username, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE):
    return privdrop.popen_as(
        username,
        [sys.executable] + WORKER_ARGS,
        cwd=config.INSTALL_DIR,
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
        env=_worker_env(),
    )


def _kill(proc):
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        pass


def _reap(proc):
    try:
        if proc.stdin is not None and not proc.stdin.closed:
            proc.stdin.close()
    except (OSError, ValueError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _kill(proc)
    except OSError:
        pass
    for stream in (proc.stdout, proc.stderr):
        try:
            if stream is not None:
                stream.close()
        except (OSError, ValueError):
            pass


def _read_line(proc, timeout):
    box = {}

    def _reader():
        try:
            box["line"] = proc.stdout.readline()
        except (OSError, ValueError) as exc:
            box["error"] = exc

    thread = threading.Thread(target=_reader, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        _kill(proc)
        raise ApiError(504, "file operation timed out")
    if "error" in box:
        raise ApiError(500, "file operation failed")
    line = box.get("line") or b""
    if not line:
        message = ""
        try:
            _, err = proc.communicate(timeout=5)
            text = (err or b"").decode("utf-8", "replace").strip()
            if text:
                message = text.splitlines()[-1]
        except (subprocess.TimeoutExpired, OSError, ValueError):
            _kill(proc)
        raise ApiError(400, message or "file operation failed")
    try:
        result = json.loads(line.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ApiError(500, "file operation failed")
    if not isinstance(result, dict):
        raise ApiError(500, "file operation failed")
    return result


def run_worker(username, request, timeout=30):
    proc = _spawn(username)
    try:
        payload = json.dumps(request).encode("utf-8") + b"\n"
        try:
            proc.stdin.write(payload)
            proc.stdin.flush()
            proc.stdin.close()
        except (OSError, ValueError):
            raise ApiError(500, "file operation failed")
        result = _read_line(proc, timeout)
    finally:
        _reap(proc)
    if result.get("ok") is False:
        raise ApiError(400, str(result.get("error") or "file operation failed"))
    return result


def _timeout(op):
    return 120 if op in SLOW_OPS else 30


def _path_param(req, key="path"):
    value = req.query.get(key)
    if value is None or value == "":
        return req.user.home or "/"
    return value


def _json_op(req, op, timeout=None):
    data = req.json()
    request = {"op": op}
    request.update(data)
    return run_worker(req.user.name, request, timeout or _timeout(op))


@route("GET", "/api/files/list")
def api_files_list(req):
    hidden = req.query.get("hidden") in ("1", "true", "yes")
    return run_worker(
        req.user.name,
        {"op": "list", "path": _path_param(req), "hidden": hidden},
        _timeout("list"),
    )


@route("GET", "/api/files/search")
def api_files_search(req):
    hidden = req.query.get("hidden") in ("1", "true", "yes")
    return run_worker(
        req.user.name,
        {"op": "search", "path": _path_param(req), "query": req.query.get("q") or "", "hidden": hidden},
        _timeout("search"),
    )


@route("GET", "/api/files/read")
def api_files_read(req):
    return run_worker(req.user.name, {"op": "read", "path": _path_param(req)}, _timeout("read"))


@route("POST", "/api/files/write")
def api_files_write(req):
    return _json_op(req, "write")


@route("POST", "/api/files/mkdir")
def api_files_mkdir(req):
    return _json_op(req, "mkdir")


@route("POST", "/api/files/touch")
def api_files_touch(req):
    return _json_op(req, "touch")


@route("POST", "/api/files/rename")
def api_files_rename(req):
    return _json_op(req, "rename")


@route("POST", "/api/files/copy")
def api_files_copy(req):
    return _json_op(req, "copy")


@route("POST", "/api/files/move")
def api_files_move(req):
    return _json_op(req, "move")


@route("POST", "/api/files/delete")
def api_files_delete(req):
    data = req.json()
    paths = data.get("paths")
    result = run_worker(req.user.name, {"op": "delete", "paths": paths}, _timeout("delete"))
    audit.log(
        "file_delete",
        user=req.user.name,
        ip=req.ip,
        target=", ".join([item for item in paths if isinstance(item, str)])[:500],
        ok=True,
    )
    return result


@route("POST", "/api/files/chmod")
def api_files_chmod(req):
    return _json_op(req, "chmod")


@route("PUT", "/api/files/upload")
def api_files_upload(req):
    directory = req.query.get("dir") or req.user.home or "/"
    name = req.query.get("name") or ""
    overwrite = req.query.get("overwrite") in ("1", "true", "yes")
    if not name or name in (".", "..") or "/" in name or "\x00" in name:
        raise ApiError(400, "invalid file name")
    if req.content_length <= 0:
        raise ApiError(400, "content-length is required")
    try:
        limit = int(config.get("max_upload_mb", 4096)) * 1024 * 1024
    except (TypeError, ValueError):
        limit = 4096 * 1024 * 1024
    if req.content_length > limit:
        raise ApiError(413, "file is too large")
    proc = _spawn(req.user.name)
    try:
        header = {
            "op": "upload",
            "dir": directory,
            "name": name,
            "overwrite": overwrite,
            "size": req.content_length,
        }
        try:
            proc.stdin.write(json.dumps(header).encode("utf-8") + b"\n")
            proc.stdin.flush()
        except (OSError, ValueError):
            raise ApiError(500, "file operation failed")
        remaining = req.content_length
        try:
            while remaining > 0:
                chunk = req.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    raise ApiError(400, "incomplete request body")
                proc.stdin.write(chunk)
                remaining -= len(chunk)
            proc.stdin.flush()
            proc.stdin.close()
        except ApiError:
            _kill(proc)
            raise
        except (OSError, ValueError):
            _kill(proc)
            raise ApiError(500, "file operation failed")
        result = _read_line(proc, 600)
    finally:
        _reap(proc)
    if not result.get("ok"):
        raise ApiError(400, str(result.get("error") or "upload failed"))
    path = result.get("path") or os.path.join(directory, name)
    audit.log("file_upload", user=req.user.name, ip=req.ip, target=path, detail=req.content_length, ok=True)
    return {"ok": True, "path": path}


@route("GET", "/api/files/download")
def api_files_download(req):
    path = _path_param(req)
    proc = _spawn(req.user.name)
    try:
        try:
            proc.stdin.write(json.dumps({"op": "download", "path": path}).encode("utf-8") + b"\n")
            proc.stdin.flush()
            proc.stdin.close()
        except (OSError, ValueError):
            raise ApiError(500, "file operation failed")
        result = _read_line(proc, 30)
    except BaseException:
        _reap(proc)
        raise
    if not result.get("ok"):
        _reap(proc)
        raise ApiError(400, str(result.get("error") or "download failed"))
    try:
        size = int(result.get("size") or 0)
    except (TypeError, ValueError):
        _reap(proc)
        raise ApiError(500, "file operation failed")
    filename = os.path.basename(path.rstrip("/")) or "download"
    disposition = "attachment; filename*=UTF-8''" + urllib.parse.quote(filename, safe="")

    def _iterator():
        remaining = size
        try:
            while remaining > 0:
                chunk = proc.stdout.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            _reap(proc)

    return StreamResponse(
        headers=[("Content-Disposition", disposition)],
        content_type="application/octet-stream",
        length=size,
        iterator=_iterator(),
    )
