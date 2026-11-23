import ctypes
import ctypes.util
import threading

PAM_SUCCESS = 0
PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4
PAM_CONV_ERR = 19


class PamMessage(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]


class PamResponse(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_char_p), ("resp_retcode", ctypes.c_int)]


CONV_FUNC = ctypes.CFUNCTYPE(
    ctypes.c_int,
    ctypes.c_int,
    ctypes.POINTER(ctypes.POINTER(PamMessage)),
    ctypes.POINTER(ctypes.POINTER(PamResponse)),
    ctypes.c_void_p,
)


class PamConv(ctypes.Structure):
    _fields_ = [("conv", CONV_FUNC), ("appdata_ptr", ctypes.c_void_p)]


_load_lock = threading.Lock()
_lib = None
_libc = None
_load_failed = False


def _load_libc():
    for name in ("libc.so.6", None):
        try:
            libc = ctypes.CDLL(name)
        except OSError:
            continue
        libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
        libc.calloc.restype = ctypes.c_void_p
        return libc
    return None


def _load():
    global _lib, _libc, _load_failed
    with _load_lock:
        if _lib is not None or _load_failed:
            return _lib
        candidates = []
        found = ctypes.util.find_library("pam")
        if found:
            candidates.append(found)
        candidates.append("libpam.so.0")
        lib = None
        for name in candidates:
            try:
                lib = ctypes.CDLL(name)
                break
            except OSError:
                continue
        if lib is None:
            _load_failed = True
            return None
        lib.pam_start.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.POINTER(PamConv),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        lib.pam_start.restype = ctypes.c_int
        lib.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.pam_authenticate.restype = ctypes.c_int
        lib.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.pam_acct_mgmt.restype = ctypes.c_int
        lib.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.pam_end.restype = ctypes.c_int
        lib.pam_strerror.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.pam_strerror.restype = ctypes.c_char_p
        _libc = _load_libc()
        if _libc is None:
            _load_failed = True
            return None
        _lib = lib
        return _lib


def _strdup(text):
    data = text.encode("utf-8", "replace")
    buf = _libc.calloc(len(data) + 1, 1)
    if not buf:
        return None
    ctypes.memmove(buf, data, len(data))
    return buf


def _make_callback(username, password):
    def _callback(num_msg, msg, resp, appdata):
        try:
            count = int(num_msg)
            if count <= 0:
                return PAM_CONV_ERR
            array = _libc.calloc(count, ctypes.sizeof(PamResponse))
            if not array:
                return PAM_CONV_ERR
            responses = ctypes.cast(array, ctypes.POINTER(PamResponse))
            for index in range(count):
                style = msg[index].contents.msg_style
                if style == PAM_PROMPT_ECHO_OFF:
                    value = password
                elif style == PAM_PROMPT_ECHO_ON:
                    value = username
                else:
                    responses[index].resp = None
                    responses[index].resp_retcode = 0
                    continue
                buf = _strdup(value)
                if not buf:
                    return PAM_CONV_ERR
                responses[index].resp = ctypes.cast(buf, ctypes.c_char_p)
                responses[index].resp_retcode = 0
            resp[0] = responses
            return PAM_SUCCESS
        except Exception:
            return PAM_CONV_ERR

    return CONV_FUNC(_callback)


def _strerror(lib, handle, code):
    try:
        message = lib.pam_strerror(handle, code)
    except Exception:
        message = None
    if message:
        return message.decode("utf-8", "replace")
    return "PAM error %d" % code


def authenticate(service, username, password):
    lib = _load()
    if lib is None:
        return False, "PAM is not available on this system"
    callback = _make_callback(username, password)
    conv = PamConv(callback, None)
    handle = ctypes.c_void_p()
    status = lib.pam_start(
        service.encode("utf-8"),
        username.encode("utf-8"),
        ctypes.byref(conv),
        ctypes.byref(handle),
    )
    if status != PAM_SUCCESS:
        return False, _strerror(lib, None, status)
    try:
        status = lib.pam_authenticate(handle, 0)
        if status != PAM_SUCCESS:
            return False, _strerror(lib, handle, status)
        status = lib.pam_acct_mgmt(handle, 0)
        if status != PAM_SUCCESS:
            return False, _strerror(lib, handle, status)
        return True, "ok"
    finally:
        try:
            lib.pam_end(handle, status)
        except Exception:
            pass
