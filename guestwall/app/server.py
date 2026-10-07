"""HTTP 层：路由、安全头、服务端渲染公开墙（输出转义）。"""
import hmac
import json
import mimetypes
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import logic
from .logic import ApiError
from .store import Store
from .util import escape

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

# 只允许同源资源与外链脚本绝缘：富文本无法注入脚本
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; "
       "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")

MAX_BODY = 64 * 1024

EMPTY_HTML = ('<div class="empty" id="emptyState">'
              '<p>墙上还空空的。</p>'
              '<p>写下第一条寄语，审核通过后就会出现在这里。</p>'
              '</div>')


class App:
    def __init__(self, db_path, owner_token, mode):
        self.store = Store(db_path)
        self.owner_token = owner_token
        self.mode = mode


def render_item(it):
    """服务端渲染公开条目：所有用户内容都经过输出转义，且不做自动链接。"""
    return (
        '<li class="msg">'
        f'<p class="content">{escape(it["content"])}</p>'
        '<p class="meta">'
        f'<span class="name">{escape(it["author_name"])}</span>'
        '<span class="dot">·</span>'
        f'<span class="rel">{escape(it["relationship"])}</span>'
        '<span class="dot">·</span>'
        f'<time>{escape(it["approved_at"])}</time>'
        '</p></li>')


class Handler(BaseHTTPRequestHandler):
    server_version = "GuestWall/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("WALL_DEBUG"):
            super().log_message(fmt, *args)

    @property
    def app(self):
        return self.server.app

    # ---- 响应助手 ----
    def _security_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def _json(self, status, obj, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _html(self, status, text, headers=None):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "TOO_LARGE", "请求体过大")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "BAD_JSON", "请求体不是有效的 JSON")

    def _require_owner(self):
        tok = self.headers.get("X-Owner-Token") or ""
        if not tok or not hmac.compare_digest(tok.encode("utf-8", "ignore"),
                                              self.app.owner_token.encode("utf-8")):
            raise ApiError(401, "OWNER_AUTH_REQUIRED", "需要站主令牌")

    def _bearer(self):
        auth = self.headers.get("Authorization", "")
        return auth[7:].strip() if auth.startswith("Bearer ") else ""

    # ---- 路由 ----
    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def _route(self, method):
        try:
            parsed = urlparse(self.path)
            path, qs = parsed.path, parse_qs(parsed.query)
            if method == "GET" and path == "/":
                return self._page_index()
            if method == "GET" and path in ("/owner", "/status"):
                return self._static_file(path.strip("/") + ".html")
            if method == "GET" and path.startswith("/static/"):
                return self._static_file(path[len("/static/"):])
            if method == "GET" and path == "/api/public/messages":
                return self._api_public_messages(qs)
            if method == "POST" and path == "/api/submissions":
                return self._api_create()
            m = re.fullmatch(
                r"/api/submissions/([0-9a-f]{32})(/edits|/withdraw|/appeal|/contact-cleanup)?",
                path)
            if m:
                sid, action = m.group(1), m.group(2)
                if method == "GET" and action is None:
                    return self._json(200, logic.guest_view(self.app.store, sid, self._bearer()))
                if method == "POST" and action == "/edits":
                    return self._json(200, logic.edit_submission(
                        self.app.store, sid, self._bearer(), self._read_json(), self.app.mode))
                if method == "POST" and action == "/withdraw":
                    return self._json(200, logic.withdraw(self.app.store, sid, self._bearer()))
                if method == "POST" and action == "/appeal":
                    return self._json(200, logic.appeal(self.app.store, sid, self._bearer()))
                if method == "POST" and action == "/contact-cleanup":
                    return self._json(200, logic.cleanup_contact(self.app.store, sid, self._bearer()))
            if method == "GET" and path == "/api/owner/queue":
                self._require_owner()
                return self._json(200, logic.owner_queue(self.app.store, self.app.mode))
            if method == "GET" and path == "/api/owner/notifications":
                self._require_owner()
                return self._json(200, logic.owner_notifications(self.app.store))
            m = re.fullmatch(r"/api/owner/submissions/([0-9a-f]{32})(/approve|/reject)?", path)
            if m:
                self._require_owner()
                sid, action = m.group(1), m.group(2)
                if method == "GET" and action is None:
                    return self._json(200, logic.owner_get(self.app.store, sid))
                payload = self._read_json()
                ev = payload.get("expected_version")
                if not isinstance(ev, int):
                    raise ApiError(400, "EXPECTED_VERSION_REQUIRED",
                                   "必须提供 expected_version（版本条件）")
                reason = str(payload.get("reason") or "").strip() or None
                if method == "POST" and action == "/approve":
                    return self._json(200, logic.approve(self.app.store, sid, ev, reason))
                if method == "POST" and action == "/reject":
                    return self._json(200, logic.reject(self.app.store, sid, ev, reason))
            raise ApiError(404, "NOT_FOUND", "资源不存在")
        except ApiError as e:
            return self._json(e.status,
                              {"error": {"code": e.code, "message": e.message, **e.extra}})
        except Exception:  # pragma: no cover
            return self._json(500, {"error": {"code": "INTERNAL", "message": "服务器内部错误"}})

    # ---- 页面 ----
    def _page_index(self):
        data = logic.public_list(self.app.store, None, 10)
        items = "".join(render_item(i) for i in data["items"])
        empty = "" if data["items"] else EMPTY_HTML
        with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
            tpl = f.read()
        html_out = (tpl.replace("{{ITEMS}}", items)
                       .replace("{{EMPTY_STATE}}", empty)
                       .replace("{{NEXT_CURSOR}}", data["next_cursor"] or "")
                       .replace("{{MORE_HIDDEN}}", "" if data["next_cursor"] else "hidden"))
        self._html(200, html_out, {"ETag": f'W/"lv{data["list_version"]}"'})

    def _static_file(self, rel):
        root = os.path.realpath(STATIC_DIR)
        full = os.path.realpath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            raise ApiError(404, "NOT_FOUND", "资源不存在")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    # ---- API ----
    def _api_create(self):
        resp, replayed = logic.create_submission(self.app.store, self._read_json(), self.app.mode)
        headers = {"Idempotent-Replay": "true"} if replayed else {}
        self._json(200 if replayed else 201, resp, headers)

    def _api_public_messages(self, qs):
        cursor = (qs.get("cursor") or [None])[0]
        data = logic.public_list(self.app.store, cursor, (qs.get("limit") or ["20"])[0])
        etag = f'W/"lv{data["list_version"]}-{(cursor or "")[:32]}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self._security_headers()
            self.end_headers()
            return
        self._json(200, data, {"ETag": etag})


def serve(host, port, db_path):
    owner_token = os.environ.get("OWNER_TOKEN", "dev-owner-token")
    mode = os.environ.get("WALL_MODE", "pre_moderation")
    if mode not in ("pre_moderation", "inbox"):
        mode = "pre_moderation"
    if owner_token == "dev-owner-token":
        print("警告：使用默认站主令牌 dev-owner-token，生产环境请设置 OWNER_TOKEN")
    app = App(db_path, owner_token, mode)
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.app = app
    print(f"GuestWall 运行中: http://{host}:{port}  模式: {mode}")
    httpd.serve_forever()
