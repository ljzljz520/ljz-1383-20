"""通用工具：令牌、哈希、转义、时间。"""
import hashlib
import html
import re
import secrets
import uuid
from datetime import datetime, timezone

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]+$")


def now_iso():
    """UTC 秒级 ISO 时间戳；格式定宽，可按字典序排序。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id():
    return uuid.uuid4().hex


def new_token():
    return secrets.token_urlsafe(32)


def hash_token(token):
    """管理令牌只存哈希，明文令牌仅在创建响应中返回一次。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_email(email):
    """邮箱哈希仅用于“是否留有联系方式”的标识，绝不用于合并提交、也不能用于发信。"""
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def escape(text):
    return html.escape(text or "", quote=True)


def valid_email(email):
    return bool(EMAIL_RE.match(email or ""))


def mask_email(email):
    if not email or "@" not in email:
        return "***"
    local, domain = email.split("@", 1)
    head = local[:1] if local else "*"
    return f"{head}***@{domain}"
