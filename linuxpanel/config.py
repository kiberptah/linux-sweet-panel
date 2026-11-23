import json
import os

DEFAULTS = {
    "port": 4080,
    "bind": "0.0.0.0",
    "tls": True,
    "cert": "/etc/linuxpanel/cert.pem",
    "key": "/etc/linuxpanel/key.pem",
    "session_hours": 12,
    "admin_groups": ["sudo", "wheel", "admin"],
    "login_group": "",
    "pam_service": "linuxpanel",
    "repo": "https://github.com/YOUR_GITHUB_USER/linuxpanel.git",
    "branch": "main",
    "max_upload_mb": 4096,
    "service_name": "linuxpanel",
}

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTALL_DIR = os.path.dirname(PACKAGE_DIR)
STATIC_DIR = os.path.join(INSTALL_DIR, "static")
STATE_DIR = os.environ.get("LINUXPANEL_STATE_DIR") or "/var/lib/linuxpanel"
LOG_DIR = os.environ.get("LINUXPANEL_LOG_DIR") or "/var/log/linuxpanel"

CONFIG_PATH = None
CONFIG = dict(DEFAULTS)


def get(key=None, default=None):
    if key is None:
        return CONFIG
    return CONFIG.get(key, default)


def _as_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _as_float(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _normalize(cfg):
    cfg["port"] = _as_int(cfg.get("port"), DEFAULTS["port"])
    cfg["bind"] = str(cfg.get("bind") or DEFAULTS["bind"])
    cfg["tls"] = bool(cfg.get("tls"))
    cfg["cert"] = str(cfg.get("cert") or DEFAULTS["cert"])
    cfg["key"] = str(cfg.get("key") or DEFAULTS["key"])
    cfg["session_hours"] = _as_float(cfg.get("session_hours"), DEFAULTS["session_hours"])
    groups = cfg.get("admin_groups")
    if not isinstance(groups, list):
        groups = list(DEFAULTS["admin_groups"])
    cfg["admin_groups"] = [str(item) for item in groups if isinstance(item, str) and item]
    cfg["login_group"] = str(cfg.get("login_group") or "")
    cfg["pam_service"] = str(cfg.get("pam_service") or DEFAULTS["pam_service"])
    cfg["repo"] = str(cfg.get("repo") or DEFAULTS["repo"])
    cfg["branch"] = str(cfg.get("branch") or DEFAULTS["branch"])
    cfg["max_upload_mb"] = _as_int(cfg.get("max_upload_mb"), DEFAULTS["max_upload_mb"])
    cfg["service_name"] = str(cfg.get("service_name") or DEFAULTS["service_name"])
    return cfg


def load(path=None, port=None, bind=None, no_tls=False):
    global CONFIG, CONFIG_PATH
    cfg = dict(DEFAULTS)
    cfg["admin_groups"] = list(DEFAULTS["admin_groups"])
    if path:
        CONFIG_PATH = os.path.abspath(path)
        data = None
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            data = None
        except (OSError, ValueError) as exc:
            raise SystemExit("linuxpanel: cannot read config %s: %s" % (CONFIG_PATH, exc))
        if isinstance(data, dict):
            cfg.update(data)
    if port is not None:
        cfg["port"] = port
    if bind:
        cfg["bind"] = bind
    if no_tls:
        cfg["tls"] = False
    CONFIG = _normalize(cfg)
    return CONFIG
