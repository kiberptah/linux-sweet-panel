import argparse
import os
import signal
import sys
import threading

from . import VERSION
from . import audit
from . import auth
from . import config
from . import httpd
from . import state
from . import stats
from . import updater
from .httpd import ApiError, Response, route

OPTIONAL_MODULES = ("terminal", "files", "accounts", "security")


def _cookie(token, clear=False):
    return ("Set-Cookie", auth.session_cookie(token, clear=clear))


@route("POST", "/api/login", auth=None)
def api_login(req):
    data = req.json()
    username = data.get("username")
    password = data.get("password")
    try:
        token, user = auth.login(
            username if isinstance(username, str) else "",
            password if isinstance(password, str) else "",
            req.ip,
        )
    except auth.LoginError as exc:
        raise ApiError(exc.status, exc.message)
    return Response.json({"user": user.to_dict()}, headers=[_cookie(token)])


@route("POST", "/api/logout", auth=None)
def api_logout(req):
    if req.session_token and auth.destroy_session(req.session_token):
        audit.log("logout", user=req.user.name if req.user else None, ip=req.ip, ok=True)
    return Response.json({"ok": True}, headers=[_cookie("", clear=True)])


@route("GET", "/api/me")
def api_me(req):
    return req.user.to_dict()


@route("GET", "/api/prefs")
def api_prefs_get(req):
    return state.get_prefs(req.user.name)


@route("POST", "/api/prefs")
def api_prefs_set(req):
    data = req.json()
    try:
        state.merge_prefs(req.user.name, data)
    except ValueError as exc:
        raise ApiError(400, str(exc))
    return {"ok": True}


@route("GET", "/api/stats")
def api_stats(req):
    return stats.get_stats()


@route("GET", "/api/settings", auth="admin")
def api_settings(req):
    return updater.settings_info()


@route("GET", "/api/update/check", auth="admin")
def api_update_check(req):
    try:
        return updater.check_update()
    except updater.UpdateError as exc:
        raise ApiError(400, str(exc))


@route("POST", "/api/update/apply", auth="admin")
def api_update_apply(req):
    try:
        return updater.apply_update(user=req.user.name, ip=req.ip)
    except updater.UpdateError as exc:
        raise ApiError(400, str(exc))


@route("GET", "/api/audit", auth="admin")
def api_audit(req):
    return {"entries": audit.read(req.query.get("limit") or 200)}


def _load_optional_modules():
    package = __name__.rsplit(".", 1)[0]
    for name in OPTIONAL_MODULES:
        try:
            __import__(package + "." + name)
        except ImportError as exc:
            sys.stderr.write("linuxpanel: optional module %s not available (%s)\n" % (name, exc))


def _tls_context(cfg):
    if not cfg.get("tls"):
        return None
    cert = cfg.get("cert")
    key = cfg.get("key")
    if not cert or not key or not os.path.isfile(cert) or not os.path.isfile(key):
        sys.stderr.write("linuxpanel: warning: TLS certificate not found (%s), serving plain HTTP\n" % cert)
        cfg["tls"] = False
        return None
    try:
        return httpd.make_tls_context(cert, key)
    except (OSError, ValueError) as exc:
        sys.stderr.write("linuxpanel: warning: cannot load TLS certificate (%s), serving plain HTTP\n" % exc)
        cfg["tls"] = False
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(prog="linuxpanel", description="LinuxPanel server")
    parser.add_argument("--config", help="path to config.json")
    parser.add_argument("--port", type=int, help="listen port")
    parser.add_argument("--bind", help="bind address")
    parser.add_argument("--no-tls", action="store_true", dest="no_tls", help="serve plain HTTP")
    args = parser.parse_args(argv)
    cfg = config.load(args.config, port=args.port, bind=args.bind, no_tls=args.no_tls)
    state.ensure_dirs()
    if os.geteuid() != 0:
        sys.stderr.write("linuxpanel: warning: not running as root, privilege dropping is limited\n")
    tls_context = _tls_context(cfg)
    _load_optional_modules()
    try:
        server = httpd.make_server(cfg["bind"], cfg["port"], tls_context)
    except OSError as exc:
        sys.stderr.write("linuxpanel: cannot bind %s:%s: %s\n" % (cfg["bind"], cfg["port"], exc))
        return 1
    scheme = "https" if tls_context else "http"
    sys.stderr.write(
        "linuxpanel %s listening on %s://%s:%s/\n" % (VERSION, scheme, cfg["bind"], cfg["port"])
    )
    sys.stderr.flush()
    stopped = threading.Event()

    def _shutdown(signum, frame):
        if stopped.is_set():
            return
        stopped.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
