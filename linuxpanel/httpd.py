import base64
import hashlib
import json
import mimetypes
import os
import socket
import ssl
import struct
import sys
import threading
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import auth as auth_mod
from . import config

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 1024 * 1024
MAX_JSON = 1024 * 1024
COOKIE_NAME = "lp_session"

SECURITY_HEADERS = [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    (
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        "connect-src 'self' ws: wss:",
    ),
]

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
}

ROUTES = {}
WS_ROUTES = {}


class ApiError(Exception):
    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status
        self.message = message


class HandshakeError(Exception):
    pass


class Response:
    def __init__(self, status=200, body=b"", headers=None, content_type=None):
        self.status = status
        if isinstance(body, bytes):
            self.body = body
        else:
            self.body = str(body).encode("utf-8")
        self.headers = list(headers or [])
        self.content_type = content_type

    @classmethod
    def json(cls, obj, status=200, headers=None):
        return cls(status, json.dumps(obj).encode("utf-8"), headers, "application/json")

    @classmethod
    def text(cls, text, status=200, headers=None, content_type="text/plain; charset=utf-8"):
        return cls(status, str(text).encode("utf-8"), headers, content_type)


class StreamResponse:
    def __init__(
        self,
        status=200,
        headers=None,
        content_type="application/octet-stream",
        length=None,
        iterator=None,
        writer=None,
    ):
        self.status = status
        self.headers = list(headers or [])
        self.content_type = content_type
        self.length = length
        self.iterator = iterator
        self.writer = writer


def route(method, path, auth="user"):
    def decorator(func):
        ROUTES[(method.upper(), path)] = (func, auth)
        return func

    return decorator


def ws_route(path, auth="user"):
    def decorator(func):
        WS_ROUTES[path] = (func, auth)
        return func

    return decorator


class Request:
    def __init__(self, handler, method, path, query, headers, ip, user, session_token):
        self.handler = handler
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.ip = ip
        self.user = user
        self.session_token = session_token
        self.rfile = handler.rfile
        self.content_length = self._content_length()

    def _content_length(self):
        if self.headers.get("Transfer-Encoding"):
            raise ApiError(400, "chunked encoding is not supported")
        raw = self.headers.get("Content-Length")
        if not raw:
            return 0
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise ApiError(400, "invalid content-length")
        if value < 0:
            raise ApiError(400, "invalid content-length")
        return value

    def body(self, limit=MAX_JSON):
        if self.content_length > limit:
            raise ApiError(413, "request body too large")
        if self.content_length <= 0:
            return b""
        data = self.rfile.read(self.content_length)
        if data is None or len(data) < self.content_length:
            raise ApiError(400, "incomplete request body")
        return data

    def json(self, limit=MAX_JSON):
        data = self.body(limit)
        if not data:
            return {}
        try:
            value = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "invalid json")
        if not isinstance(value, dict):
            raise ApiError(400, "invalid json")
        return value


class WebSocket:
    def __init__(self, rfile, wfile, sock):
        self._rfile = rfile
        self._wfile = wfile
        self._sock = sock
        self._lock = threading.Lock()
        self._closed = False

    def fileno(self):
        return self._sock.fileno()

    def has_pending(self):
        pending = getattr(self._sock, "pending", None)
        if pending is None:
            return False
        try:
            return bool(pending())
        except OSError:
            return False

    def _read_exact(self, count):
        if count <= 0:
            return b""
        try:
            data = self._rfile.read(count)
        except (OSError, ValueError):
            self._closed = True
            return None
        if not data or len(data) < count:
            self._closed = True
            return None
        return data

    def _read_frame(self):
        header = self._read_exact(2)
        if header is None:
            return None
        first = header[0]
        second = header[1]
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            raw = self._read_exact(2)
            if raw is None:
                return None
            length = struct.unpack("!H", raw)[0]
        elif length == 127:
            raw = self._read_exact(8)
            if raw is None:
                return None
            length = struct.unpack("!Q", raw)[0]
        if length > MAX_FRAME:
            self._send_frame(0x8, struct.pack("!H", 1009))
            self._closed = True
            return None
        mask = None
        if masked:
            mask = self._read_exact(4)
            if mask is None:
                return None
        payload = b""
        if length:
            payload = self._read_exact(length)
            if payload is None:
                return None
        if mask:
            payload = _unmask(payload, mask)
        return (fin, opcode, payload)

    def recv(self):
        fragments = []
        first_opcode = None
        while True:
            frame = self._read_frame()
            if frame is None:
                return None
            fin, opcode, payload = frame
            if opcode == 0x8:
                self._send_frame(0x8, payload[:2])
                self._closed = True
                return None
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                if fin:
                    return (opcode, payload)
                first_opcode = opcode
                fragments = [payload]
                continue
            if opcode == 0x0:
                if first_opcode is None:
                    continue
                fragments.append(payload)
                if fin:
                    data = b"".join(fragments)
                    result = (first_opcode, data)
                    fragments = []
                    first_opcode = None
                    return result
                continue
            self._closed = True
            return None

    def _send_frame(self, opcode, payload):
        if self._closed:
            return False
        payload = payload or b""
        header = bytearray()
        header.append(0x80 | (opcode & 0x0F))
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header += struct.pack("!H", length)
        else:
            header.append(127)
            header += struct.pack("!Q", length)
        with self._lock:
            if self._closed:
                return False
            try:
                self._wfile.write(bytes(header) + payload)
                self._wfile.flush()
                return True
            except (OSError, ValueError):
                self._closed = True
                return False

    def send_text(self, text):
        return self._send_frame(0x1, str(text).encode("utf-8"))

    def send_binary(self, data):
        return self._send_frame(0x2, bytes(data))

    def close(self, code=1000):
        if self._closed:
            return
        self._send_frame(0x8, struct.pack("!H", code))
        self._closed = True


def _unmask(payload, mask):
    if not payload:
        return b""
    key = (mask * ((len(payload) // 4) + 1))[: len(payload)]
    return bytes(left ^ right for left, right in zip(payload, key))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LinuxPanel"
    sys_version = ""
    timeout = 60

    def setup(self):
        if isinstance(self.request, ssl.SSLSocket):
            try:
                self.request.settimeout(self.timeout)
                self.request.do_handshake()
            except (OSError, ssl.SSLError, ValueError) as exc:
                try:
                    self.request.close()
                except OSError:
                    pass
                raise HandshakeError(str(exc))
        BaseHTTPRequestHandler.setup(self)

    def handle_one_request(self):
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionResetError, BrokenPipeError, socket.timeout, ssl.SSLError):
            self.close_connection = True

    def log_message(self, fmt, *args):
        pass

    def log_error(self, fmt, *args):
        sys.stderr.write("linuxpanel: " + (fmt % args) + "\n")

    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()

    def do_POST(self):
        self._dispatch()

    def do_PUT(self):
        self._dispatch()

    def do_DELETE(self):
        self._dispatch()

    def do_PATCH(self):
        self._dispatch()

    def do_OPTIONS(self):
        self._dispatch()

    def _dispatch(self):
        try:
            self._handle()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            traceback.print_exc()
            try:
                self._send_json(500, {"error": "internal error"})
            except Exception:
                self.close_connection = True

    def _handle(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path or "/"
        query = {}
        if parts.query:
            for key, values in urllib.parse.parse_qs(parts.query, keep_blank_values=True).items():
                query[key] = values[0] if values else ""
        method = self.command.upper()
        head_only = method == "HEAD"
        token = self._cookie(COOKIE_NAME)
        session = auth_mod.get_session(token) if token else None
        user = None
        if session:
            user = auth_mod.get_user(session.get("user"))
            if user is None:
                auth_mod.destroy_session(token)
                session = None
                token = None
        if method == "GET" and (self.headers.get("Upgrade") or "").strip().lower() == "websocket":
            self._handle_ws(path, query, user, token)
            return
        if method not in ("GET", "HEAD") and path.startswith("/api"):
            if (self.headers.get("X-LP") or "").strip() != "1":
                self._send_json(403, {"error": "missing X-LP header"}, head_only)
                return
        entry = ROUTES.get((method, path))
        if entry is None and method == "HEAD":
            entry = ROUTES.get(("GET", path))
        if entry is None:
            if path.startswith("/api"):
                self._send_json(404, {"error": "not found"}, head_only)
            else:
                self._serve_static(path, head_only)
            return
        handler, level = entry
        if level == "user" and user is None:
            self._send_json(401, {"error": "not authenticated"}, head_only)
            return
        if level == "admin":
            if user is None:
                self._send_json(401, {"error": "not authenticated"}, head_only)
                return
            if not user.admin:
                self._send_json(403, {"error": "admin required"}, head_only)
                return
        try:
            req = Request(self, method, path, query, self.headers, self._client_ip(), user, token)
            result = handler(req)
        except ApiError as exc:
            self._send_json(exc.status, {"error": exc.message}, head_only)
            return
        self._respond(result, head_only)

    def _respond(self, result, head_only):
        if isinstance(result, StreamResponse):
            self._send_stream(result, head_only)
        elif isinstance(result, Response):
            self._send(result.status, result.body, result.content_type, result.headers, head_only)
        elif isinstance(result, dict):
            self._send_json(200, result, head_only)
        else:
            self._send_json(200, {"ok": True}, head_only)

    def _client_ip(self):
        try:
            return self.client_address[0]
        except (IndexError, TypeError):
            return None

    def _cookie(self, name):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        for chunk in raw.split(";"):
            if "=" not in chunk:
                continue
            key, value = chunk.split("=", 1)
            if key.strip() == name:
                return value.strip()
        return None

    def _is_api(self):
        return (self.path or "").split("?", 1)[0].startswith("/api")

    def _send(self, status, body, content_type, headers=None, head_only=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        for key, value in SECURITY_HEADERS:
            self.send_header(key, value)
        if self._is_api():
            self.send_header("Cache-Control", "no-store")
        for key, value in headers or []:
            self.send_header(key, value)
        self.end_headers()
        if not head_only and body:
            self.wfile.write(body)

    def _send_json(self, status, obj, head_only=False, headers=None):
        body = json.dumps(obj).encode("utf-8")
        self._send(status, body, "application/json", headers, head_only)

    def _send_stream(self, resp, head_only=False):
        self.send_response(resp.status)
        self.send_header("Content-Type", resp.content_type or "application/octet-stream")
        if resp.length is not None:
            self.send_header("Content-Length", str(resp.length))
        else:
            self.send_header("Connection", "close")
            self.close_connection = True
        for key, value in SECURITY_HEADERS:
            self.send_header(key, value)
        if self._is_api():
            self.send_header("Cache-Control", "no-store")
        for key, value in resp.headers or []:
            self.send_header(key, value)
        self.end_headers()
        if head_only:
            return
        try:
            if resp.writer is not None:
                resp.writer(self.wfile)
            elif resp.iterator is not None:
                for chunk in resp.iterator:
                    if chunk:
                        self.wfile.write(chunk)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _serve_static(self, path, head_only):
        rel = urllib.parse.unquote(path).lstrip("/")
        if not rel:
            rel = "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        root = os.path.realpath(config.STATIC_DIR)
        full = os.path.realpath(os.path.join(root, rel))
        if full != root and not full.startswith(root + os.sep):
            self._send(404, b"not found", "text/plain; charset=utf-8", None, head_only)
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            self._send(404, b"not found", "text/plain; charset=utf-8", None, head_only)
            return
        try:
            with open(full, "rb") as handle:
                body = handle.read()
        except OSError:
            self._send(404, b"not found", "text/plain; charset=utf-8", None, head_only)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        self._send(200, body, ctype, None, head_only)

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if not origin or not host:
            return False
        try:
            parts = urllib.parse.urlsplit(origin)
        except ValueError:
            return False
        if parts.scheme not in ("http", "https"):
            return False
        return (parts.netloc or "").lower() == host.strip().lower()

    def _handle_ws(self, path, query, user, token):
        entry = WS_ROUTES.get(path)
        if entry is None:
            self._send_json(404, {"error": "not found"})
            return
        handler, level = entry
        if level == "user" and user is None:
            self._send_json(401, {"error": "not authenticated"})
            return
        if level == "admin":
            if user is None:
                self._send_json(401, {"error": "not authenticated"})
                return
            if not user.admin:
                self._send_json(403, {"error": "admin required"})
                return
        if not self._origin_ok():
            self._send_json(403, {"error": "bad origin"})
            return
        key = (self.headers.get("Sec-WebSocket-Key") or "").strip()
        if not key:
            self._send_json(400, {"error": "missing Sec-WebSocket-Key"})
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        try:
            self.request.settimeout(3600)
        except OSError:
            pass
        ws = WebSocket(self.rfile, self.wfile, self.request)
        try:
            req = Request(self, "GET", path, query, self.headers, self._client_ip(), user, token)
            handler(req, ws)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            ws.close()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, tls_context=None):
        self.tls_context = tls_context
        ThreadingHTTPServer.__init__(self, address, handler)

    def server_bind(self):
        ThreadingHTTPServer.server_bind(self)
        if self.tls_context is not None:
            self.socket = self.tls_context.wrap_socket(
                self.socket, server_side=True, do_handshake_on_connect=False
            )

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(
            exc,
            (
                HandshakeError,
                ssl.SSLError,
                ConnectionResetError,
                BrokenPipeError,
                socket.timeout,
                TimeoutError,
            ),
        ):
            return
        ThreadingHTTPServer.handle_error(self, request, client_address)


def make_tls_context(cert, key):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    return context


def make_server(bind, port, tls_context=None):
    return Server((bind, port), Handler, tls_context)
