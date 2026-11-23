import os
import pwd
import threading
import time

CACHE_TTL = 1.0
CPU_SAMPLE_GAP = 0.3
CPU_MAX_AGE = 5.0
TOP_PROCS = 15

SKIP_FS = {
    "tmpfs",
    "devtmpfs",
    "proc",
    "sysfs",
    "overlay",
    "squashfs",
    "autofs",
    "devpts",
    "securityfs",
    "debugfs",
    "tracefs",
    "pstore",
    "bpf",
    "configfs",
    "fusectl",
    "mqueue",
    "hugetlbfs",
    "ramfs",
    "nsfs",
    "binfmt_misc",
    "efivarfs",
    "rpc_pipefs",
    "selinuxfs",
    "rootfs",
    "none",
}

_lock = threading.Lock()
_cache = {"ts": 0.0, "data": None}
_prev_cpu = None
_prev_procs = {}
_prev_procs_ts = 0.0
_user_cache = {}


def _read_cpu():
    try:
        with open("/proc/stat", "r", encoding="utf-8", errors="replace") as handle:
            line = handle.readline()
    except OSError:
        return None
    parts = line.split()
    if not parts or parts[0] != "cpu":
        return None
    values = []
    for item in parts[1:]:
        try:
            values.append(int(item))
        except ValueError:
            continue
    if len(values) < 4:
        return None
    total = sum(values)
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return total, idle


def _cpu_percent():
    global _prev_cpu
    sample = _read_cpu()
    if sample is None:
        return 0.0
    now = time.time()
    previous = _prev_cpu
    if previous is None or now - previous[0] > CPU_MAX_AGE:
        time.sleep(CPU_SAMPLE_GAP)
        second = _read_cpu()
        now = time.time()
        if second is not None:
            previous = (now - CPU_SAMPLE_GAP, sample[0], sample[1])
            sample = second
        else:
            previous = (now - CPU_SAMPLE_GAP, sample[0], sample[1])
    total_delta = sample[0] - previous[1]
    idle_delta = sample[1] - previous[2]
    _prev_cpu = (now, sample[0], sample[1])
    if total_delta <= 0:
        return 0.0
    percent = 100.0 * (1.0 - float(idle_delta) / float(total_delta))
    return round(max(0.0, min(100.0, percent)), 1)


def _meminfo():
    info = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if ":" not in line:
                    continue
                key, rest = line.split(":", 1)
                parts = rest.split()
                if not parts:
                    continue
                try:
                    value = int(parts[0])
                except ValueError:
                    continue
                if len(parts) > 1 and parts[1].lower() == "kb":
                    value *= 1024
                info[key.strip()] = value
    except OSError:
        pass
    return info


def _memory(info):
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable")
    if available is None:
        available = info.get("MemFree", 0) + info.get("Buffers", 0) + info.get("Cached", 0)
    used = max(0, total - available)
    percent = round(used * 100.0 / total, 1) if total else 0.0
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    swap_used = max(0, swap_total - swap_free)
    swap_percent = round(swap_used * 100.0 / swap_total, 1) if swap_total else 0.0
    return (
        {"total": total, "used": used, "available": available, "percent": percent},
        {"total": swap_total, "used": swap_used, "percent": swap_percent},
    )


def _loadavg():
    try:
        with open("/proc/loadavg", "r", encoding="utf-8", errors="replace") as handle:
            parts = handle.read().split()
        return [float(parts[0]), float(parts[1]), float(parts[2])]
    except (OSError, IndexError, ValueError):
        return [0.0, 0.0, 0.0]


def _uptime():
    try:
        with open("/proc/uptime", "r", encoding="utf-8", errors="replace") as handle:
            return int(float(handle.read().split()[0]))
    except (OSError, IndexError, ValueError):
        return 0


def _os_name():
    try:
        with open("/etc/os-release", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return "Linux"


def _disks():
    try:
        with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError:
        return []
    disks = []
    seen = set()
    for line in lines:
        parts = line.split()
        if len(parts) < 3:
            continue
        device = parts[0]
        mount = parts[1].replace("\\040", " ")
        fstype = parts[2]
        if fstype in SKIP_FS or fstype.startswith("cgroup"):
            continue
        if mount.startswith(("/proc", "/sys", "/dev", "/run")):
            continue
        if device in seen:
            continue
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total <= 0:
            continue
        used = total - st.f_bfree * st.f_frsize
        percent = round(used * 100.0 / total, 1)
        seen.add(device)
        disks.append(
            {
                "mount": mount,
                "fs": fstype,
                "device": device,
                "total": int(total),
                "used": int(used),
                "percent": percent,
            }
        )
    disks.sort(key=lambda item: item["mount"])
    return disks


def _username(uid):
    name = _user_cache.get(uid)
    if name is not None:
        return name
    try:
        name = pwd.getpwuid(uid).pw_name
    except KeyError:
        name = str(uid)
    _user_cache[uid] = name
    return name


def _read_stat(pid):
    try:
        with open("/proc/%s/stat" % pid, "rb") as handle:
            data = handle.read()
    except OSError:
        return None
    end = data.rfind(b")")
    if end < 0:
        return None
    start = data.find(b"(")
    comm = data[start + 1 : end].decode("utf-8", "replace") if start >= 0 else ""
    fields = data[end + 2 :].split()
    try:
        ticks = int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None
    return comm, ticks


def _read_uid(pid):
    try:
        with open("/proc/%s/status" % pid, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.startswith("Uid:"):
                    return int(line.split()[1])
    except (OSError, IndexError, ValueError):
        pass
    return None


def _read_rss(pid):
    try:
        with open("/proc/%s/statm" % pid, "r", encoding="utf-8", errors="replace") as handle:
            parts = handle.read().split()
        return int(parts[1])
    except (OSError, IndexError, ValueError):
        return 0


def _read_cmdline(pid, comm):
    try:
        with open("/proc/%s/cmdline" % pid, "rb") as handle:
            raw = handle.read()
    except OSError:
        return "[%s]" % comm
    text = raw.replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    if not text:
        return "[%s]" % comm
    return text


def _procs(mem_total):
    global _prev_procs, _prev_procs_ts
    try:
        clk = os.sysconf("SC_CLK_TCK")
    except (ValueError, OSError, AttributeError):
        clk = 100
    try:
        page = os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        page = 4096
    now = time.time()
    elapsed = now - _prev_procs_ts if _prev_procs_ts else 0.0
    current = {}
    rows = []
    try:
        names = os.listdir("/proc")
    except OSError:
        names = []
    for name in names:
        if not name.isdigit():
            continue
        stat = _read_stat(name)
        if stat is None:
            continue
        comm, ticks = stat
        current[name] = ticks
        previous = _prev_procs.get(name)
        cpu = 0.0
        if previous is not None and elapsed > 0:
            cpu = (ticks - previous) / float(clk) / elapsed * 100.0
        rss = _read_rss(name) * page
        uid = _read_uid(name)
        rows.append(
            {
                "pid": int(name),
                "user": _username(uid) if uid is not None else "?",
                "cpu": round(max(0.0, cpu), 1),
                "mem": round(rss * 100.0 / mem_total, 1) if mem_total else 0.0,
                "rss": int(rss),
                "cmd": _read_cmdline(name, comm),
            }
        )
    _prev_procs = current
    _prev_procs_ts = now
    rows.sort(key=lambda item: (-item["cpu"], -item["rss"]))
    return rows[:TOP_PROCS]


def _snapshot():
    info = _meminfo()
    mem, swap = _memory(info)
    cores = os.cpu_count() or 1
    uname = os.uname()
    return {
        "hostname": uname.nodename,
        "os": _os_name(),
        "kernel": uname.release,
        "uptime_s": _uptime(),
        "load": _loadavg(),
        "cpu": {"percent": _cpu_percent(), "cores": cores},
        "mem": mem,
        "swap": swap,
        "disks": _disks(),
        "procs": _procs(mem["total"]),
    }


def get_stats():
    with _lock:
        cached = _cache.get("data")
        if cached is not None and time.time() - _cache.get("ts", 0.0) < CACHE_TTL:
            return cached
        data = _snapshot()
        _cache["ts"] = time.time()
        _cache["data"] = data
        return data
