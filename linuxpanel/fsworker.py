import grp
import json
import os
import pwd
import secrets
import shutil
import stat
import sys

CHUNK = 1024 * 1024
READ_LIMIT = 5 * 1024 * 1024
NUL_SCAN = 8192

_owners = {}


def _owner(uid, gid):
    key = (uid, gid)
    cached = _owners.get(key)
    if cached is not None:
        return cached
    try:
        user = pwd.getpwuid(uid).pw_name
    except KeyError:
        user = str(uid)
    try:
        group = grp.getgrgid(gid).gr_name
    except KeyError:
        group = str(gid)
    value = (user, group)
    _owners[key] = value
    return value


def _home():
    try:
        return pwd.getpwuid(os.getuid()).pw_dir or "/"
    except KeyError:
        return os.path.expanduser("~") or "/"


def _friendly(exc, path):
    if isinstance(exc, FileNotFoundError):
        return "No such file or directory: %s" % path
    if isinstance(exc, FileExistsError):
        return "Already exists: %s" % path
    if isinstance(exc, PermissionError):
        return "Permission denied: %s" % path
    if isinstance(exc, NotADirectoryError):
        return "Not a directory: %s" % path
    if isinstance(exc, IsADirectoryError):
        return "Is a directory: %s" % path
    if isinstance(exc, OSError) and exc.strerror:
        return "%s: %s" % (exc.strerror, path)
    return str(exc)


def _path(value):
    if not isinstance(value, str) or not value:
        raise ValueError("path is required")
    if "\x00" in value:
        raise ValueError("invalid path")
    return value


def _entry_type(mode):
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode):
        return "link"
    return "other"


def _octal(mode):
    return format(stat.S_IMODE(mode), "03o")


def _file_entry(full, name):
    try:
        st = os.lstat(full)
    except OSError:
        return None
    kind = _entry_type(st.st_mode)
    target_type = None
    link_target = None
    if kind == "link":
        try:
            link_target = os.readlink(full)
        except OSError:
            link_target = None
        try:
            target = os.stat(full)
            target_type = "dir" if stat.S_ISDIR(target.st_mode) else "file"
        except OSError:
            target_type = "broken"
    owner, group = _owner(st.st_uid, st.st_gid)
    return {
        "name": name,
        "type": kind,
        "target_type": target_type,
        "link_target": link_target,
        "size": int(st.st_size),
        "mtime": int(st.st_mtime),
        "mode": stat.filemode(st.st_mode),
        "octal": _octal(st.st_mode),
        "owner": owner,
        "group": group,
    }


def op_list(req):
    path = _path(req.get("path"))
    hidden = bool(req.get("hidden"))
    real = os.path.realpath(path)
    names = os.listdir(real)
    entries = []
    for name in names:
        if not hidden and name.startswith("."):
            continue
        entry = _file_entry(os.path.join(real, name), name)
        if entry is not None:
            entries.append(entry)
    entries.sort(key=lambda item: (0 if item["type"] == "dir" else 1, item["name"].lower()))
    parent = os.path.dirname(real)
    return {"ok": True, "path": real, "parent": parent if parent and parent != real else None, "entries": entries}


def op_search(req):
    path = _path(req.get("path"))
    query = req.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("search query is required")
    query = query.strip()
    needle = query.casefold()
    hidden = bool(req.get("hidden"))
    real = os.path.realpath(path)
    if not os.path.isdir(real):
        raise NotADirectoryError(real)
    entries = []
    truncated = False
    visited = 0
    for root, dirnames, filenames in os.walk(real, topdown=True, followlinks=False):
        dirnames.sort(key=str.casefold)
        filenames.sort(key=str.casefold)
        if not hidden:
            dirnames[:] = [name for name in dirnames if not name.startswith(".")]
        for name in dirnames + filenames:
            if not hidden and name.startswith("."):
                continue
            visited += 1
            if visited > 50000:
                truncated = True
                break
            if needle not in name.casefold():
                continue
            full = os.path.join(root, name)
            entry = _file_entry(full, name)
            if entry is None:
                continue
            entry["path"] = full
            entry["relative_path"] = os.path.relpath(full, real)
            entries.append(entry)
            if len(entries) >= 200:
                truncated = True
                break
        if truncated:
            break
    entries.sort(key=lambda item: item["relative_path"].casefold())
    return {"ok": True, "path": real, "query": query, "entries": entries, "truncated": truncated}


def op_read(req):
    path = _path(req.get("path"))
    size = os.path.getsize(path)
    if size > READ_LIMIT:
        raise ValueError("file is too large to edit (limit 5 MB)")
    with open(path, "rb") as handle:
        data = handle.read(READ_LIMIT + 1)
    if len(data) > READ_LIMIT:
        raise ValueError("file is too large to edit (limit 5 MB)")
    if b"\x00" in data[:NUL_SCAN]:
        raise ValueError("binary file")
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("binary file")
    return {"ok": True, "path": os.path.realpath(path), "content": content, "size": len(data)}


def _write_temp(directory, prefix, data):
    fd, tmp = _mkstemp(directory, prefix)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        _unlink_quiet(tmp)
        raise
    return tmp


def _mkstemp(directory, prefix):
    for _ in range(64):
        candidate = os.path.join(directory, "%s%s" % (prefix, secrets.token_hex(6)))
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        return fd, candidate
    raise OSError("cannot create temporary file in %s" % directory)


def _unlink_quiet(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def op_write(req):
    path = _path(req.get("path"))
    content = req.get("content")
    if not isinstance(content, str):
        raise ValueError("content is required")
    data = content.encode("utf-8")
    directory = os.path.dirname(path) or "."
    mode = None
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        mode = None
    tmp = _write_temp(directory, ".lptmp-", data)
    try:
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        _unlink_quiet(tmp)
        raise
    return {"ok": True, "path": path}


def op_mkdir(req):
    path = _path(req.get("path"))
    os.mkdir(path)
    return {"ok": True, "path": path}


def op_touch(req):
    path = _path(req.get("path"))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    os.close(fd)
    return {"ok": True, "path": path}


def op_rename(req):
    src = _path(req.get("src"))
    dst = _path(req.get("dst"))
    if os.path.lexists(dst):
        raise ValueError("Already exists: %s" % dst)
    os.rename(src, dst)
    return {"ok": True, "path": dst}


def _targets(sources, dest_dir):
    if not isinstance(sources, list) or not sources:
        raise ValueError("sources are required")
    dest = _path(dest_dir)
    if not os.path.isdir(dest):
        raise NotADirectoryError(dest)
    result = []
    for item in sources:
        src = _path(item)
        name = os.path.basename(src.rstrip("/")) or src
        result.append((src, os.path.join(dest, name)))
    return result


def op_copy(req):
    pairs = _targets(req.get("sources"), req.get("dest_dir"))
    for src, dst in pairs:
        if os.path.lexists(dst):
            raise ValueError("Already exists: %s" % dst)
    for src, dst in pairs:
        if os.path.isdir(src) and not os.path.islink(src):
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
    return {"ok": True}


def op_move(req):
    pairs = _targets(req.get("sources"), req.get("dest_dir"))
    for src, dst in pairs:
        if os.path.lexists(dst):
            raise ValueError("Already exists: %s" % dst)
    for src, dst in pairs:
        shutil.move(src, dst)
    return {"ok": True}


def op_delete(req):
    paths = req.get("paths")
    if not isinstance(paths, list) or not paths:
        raise ValueError("paths are required")
    for item in paths:
        path = _path(item)
        if os.path.islink(path) or not os.path.isdir(path):
            os.unlink(path)
        else:
            shutil.rmtree(path)
    return {"ok": True}


def op_chmod(req):
    path = _path(req.get("path"))
    raw = req.get("mode")
    if not isinstance(raw, str) or not raw:
        raise ValueError("mode is required")
    try:
        mode = int(raw, 8)
    except ValueError:
        raise ValueError("invalid mode: %s" % raw)
    if mode < 0 or mode > 0o7777:
        raise ValueError("invalid mode: %s" % raw)
    os.chmod(path, mode)
    return {"ok": True, "path": path, "octal": format(mode, "03o")}


def op_upload(req):
    directory = _path(req.get("dir"))
    name = req.get("name")
    if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\x00" in name:
        raise ValueError("invalid file name")
    if not os.path.isdir(directory):
        raise NotADirectoryError(directory)
    overwrite = bool(req.get("overwrite"))
    target = os.path.join(directory, name)
    if os.path.lexists(target) and not overwrite:
        raise ValueError("Already exists: %s" % target)
    fd, tmp = _mkstemp(directory, "." + name + ".lpupload-")
    try:
        with os.fdopen(fd, "wb") as handle:
            while True:
                chunk = sys.stdin.buffer.read(CHUNK)
                if not chunk:
                    break
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if os.path.lexists(target) and not overwrite:
            raise ValueError("Already exists: %s" % target)
        os.replace(tmp, target)
    except BaseException:
        _unlink_quiet(tmp)
        raise
    return {"ok": True, "path": target}


def op_download(req):
    path = _path(req.get("path"))
    if os.path.isdir(path):
        raise IsADirectoryError(path)
    size = os.path.getsize(path)
    handle = open(path, "rb")
    return {"ok": True, "size": size}, handle


def _authkeys_path():
    return os.path.join(_home(), ".ssh", "authorized_keys")


def op_authkeys_read(req):
    path = _authkeys_path()
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except FileNotFoundError:
        return {"ok": True, "lines": []}
    return {"ok": True, "lines": lines}


def op_authkeys_write(req):
    lines = req.get("lines")
    if not isinstance(lines, list):
        raise ValueError("lines are required")
    cleaned = []
    for line in lines:
        if not isinstance(line, str):
            raise ValueError("invalid key line")
        if "\n" in line or "\r" in line:
            raise ValueError("invalid key line")
        cleaned.append(line)
    home = _home()
    ssh_dir = os.path.join(home, ".ssh")
    target = os.path.join(ssh_dir, "authorized_keys")
    if os.path.islink(ssh_dir) or os.path.islink(target):
        raise ValueError("refusing to write through a symbolic link")
    if not os.path.isdir(ssh_dir):
        os.mkdir(ssh_dir, 0o700)
    os.chmod(ssh_dir, 0o700)
    data = ("\n".join(cleaned) + "\n").encode("utf-8") if cleaned else b""
    tmp = _write_temp(ssh_dir, ".lpauthkeys-", data)
    try:
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        _unlink_quiet(tmp)
        raise
    os.chmod(target, 0o600)
    return {"ok": True, "path": target}


OPS = {
    "list": op_list,
    "search": op_search,
    "read": op_read,
    "write": op_write,
    "mkdir": op_mkdir,
    "touch": op_touch,
    "rename": op_rename,
    "copy": op_copy,
    "move": op_move,
    "delete": op_delete,
    "chmod": op_chmod,
    "upload": op_upload,
    "download": op_download,
    "authkeys_read": op_authkeys_read,
    "authkeys_write": op_authkeys_write,
}


def _emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    raw = sys.stdin.buffer.readline()
    if not raw:
        return 1
    try:
        req = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        _emit({"ok": False, "error": "invalid request"})
        return 1
    if not isinstance(req, dict):
        _emit({"ok": False, "error": "invalid request"})
        return 1
    handler = OPS.get(req.get("op"))
    if handler is None:
        _emit({"ok": False, "error": "unknown operation"})
        return 1
    try:
        result = handler(req)
    except ValueError as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    except OSError as exc:
        _emit({"ok": False, "error": _friendly(exc, exc.filename or req.get("path") or req.get("dir") or "")})
        return 1
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    handle = None
    if isinstance(result, tuple):
        result, handle = result
    _emit(result)
    if handle is not None:
        try:
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
        except OSError:
            pass
        finally:
            handle.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
