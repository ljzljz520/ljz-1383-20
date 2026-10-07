"""业务逻辑：提交、版本、审核竞争、快照、通知。

核心约束：
- 公开页只读 snapshots 表；编辑/撤回/拒绝都会删除快照。
- 审核（批准/拒绝）必须带 expected_version，与当前版本不一致 => 409 VERSION_CONFLICT。
- 幂等键绑定“一份草稿的一次提交”，有 TTL，与邮箱无关；同一人的多条留言绝不合并。
- 明文邮箱只进 contacts 表，仅通知子系统读取；任何 HTTP 响应都不含明文邮箱。
"""
import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta, timezone

from .util import (hash_email, hash_token, mask_email, new_id, new_token,
                   now_iso, valid_email)

IDEM_TTL_DAYS = 7          # 幂等身份的“界”：键只在一周内有效
MAX_LIMIT = 50

STATUS_LABELS = {
    "pending": "待审核",
    "inbox": "站主收件箱（仅站主可见）",
    "approved": "已公开",
    "rejected": "未通过",
    "appealed": "申诉中",
    "withdrawn": "已撤回",
}

NOTIFICATION_LABELS = {
    "channel_not_configured": "未配置发送渠道，送达状态未知",
    "sent_unconfirmed": "已交发送渠道，送达状态未知（无回执）",
    "skipped_opt_out": "作者未订阅通知，未发送",
    "skipped_no_contact": "无可用联系方式（可能已应请求清除），未发送",
}


class ApiError(Exception):
    def __init__(self, status, code, message, extra=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}


# ---------- 校验 ----------

def _validate_text(payload):
    name = str((payload or {}).get("author_name") or "").strip()
    rel = str((payload or {}).get("relationship") or "").strip()
    content = str((payload or {}).get("content") or "").strip()
    if not 1 <= len(name) <= 40:
        raise ApiError(400, "INVALID_NAME", "昵称需为 1-40 个字符")
    if not 1 <= len(rel) <= 60:
        raise ApiError(400, "INVALID_RELATIONSHIP", "关系说明需为 1-60 个字符")
    if not 1 <= len(content) <= 1000:
        raise ApiError(400, "INVALID_CONTENT", "寄语需为 1-1000 个字符")
    return name, rel, content


# ---------- 内部助手 ----------

def _add_event(c, sid, version_no, action, actor, reason, from_status, to_status):
    c.execute(
        "INSERT INTO events (id, submission_id, version_no, action, actor, reason,"
        " from_status, to_status, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (new_id(), sid, version_no, action, actor, reason, from_status, to_status, now_iso()))


def _bump_list_version(c):
    c.execute("UPDATE meta SET value = value + 1 WHERE key='list_version'")


def _list_version(c):
    return c.execute("SELECT value FROM meta WHERE key='list_version'").fetchone()["value"]


def _get_submission(c, sid):
    row = c.execute("SELECT * FROM submissions WHERE id=?", (sid,)).fetchone()
    if not row:
        raise ApiError(404, "NOT_FOUND", "留言不存在")
    return row


def _auth_guest(c, sid, token):
    if not token:
        raise ApiError(401, "AUTH_REQUIRED", "缺少管理令牌")
    sub = _get_submission(c, sid)
    if not hmac.compare_digest(sub["manage_token_hash"], hash_token(token)):
        raise ApiError(403, "FORBIDDEN", "管理令牌无效")
    return sub


def _version_row(c, sid, vno):
    row = c.execute(
        "SELECT * FROM versions WHERE submission_id=? AND version_no=?",
        (sid, vno)).fetchone()
    if not row:
        raise ApiError(500, "INTERNAL", "版本数据缺失")
    return row


def _purge_expired_keys(c):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=IDEM_TTL_DAYS)).isoformat(timespec="seconds")
    c.execute("DELETE FROM idempotency_keys WHERE created_at < ?", (cutoff,))


def _owner_contact_view(c, sub):
    """站主视图：只给脱敏邮箱，明文永不出现在任何 HTTP 响应中。"""
    view = {"present": bool(sub["has_contact"]), "masked": None,
            "notify_opt_in": bool(sub["notify_opt_in"]),
            "cleared_at": sub["contact_cleared_at"]}
    if sub["has_contact"]:
        row = c.execute("SELECT email_plain FROM contacts WHERE submission_id=?",
                        (sub["id"],)).fetchone()
        if row:
            view["masked"] = mask_email(row["email_plain"])
    return view


def _dispatch_notification(c, sub, kind):
    """通知派发。注意：任何分支都不会声称“已送达”。"""
    if sub["contact_cleared_at"]:
        status, detail = "skipped_no_contact", "联系方式已应作者请求清除"
    elif not sub["notify_opt_in"]:
        status, detail = "skipped_opt_out", "作者未选择接收通知"
    elif not sub["has_contact"]:
        status, detail = "skipped_no_contact", "无可用联系方式（可能已应请求清除）"
    else:
        contact = c.execute("SELECT email_plain FROM contacts WHERE submission_id=?",
                            (sub["id"],)).fetchone()
        if not contact:
            status, detail = "skipped_no_contact", "无可用联系方式（可能已应请求清除）"
        elif not os.environ.get("WALL_SMTP_URL"):
            status, detail = "channel_not_configured", "未配置发送渠道；通知未发出，送达状态未知"
        else:
            # 实际部署时在此调用 SMTP；即使发送成功，没有回执也只能标记“送达未知”
            status, detail = "sent_unconfirmed", "已交发送渠道；无送达回执，送达状态未知"
    c.execute(
        "INSERT INTO notifications (id, submission_id, kind, status, detail, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (new_id(), sub["id"], kind, status, detail, now_iso()))


# ---------- 访客：提交 ----------

def create_submission(store, payload, mode):
    if not isinstance(payload, dict):
        raise ApiError(400, "BAD_JSON", "请求体必须是 JSON 对象")
    key = str(payload.get("idempotency_key") or "").strip()
    if not 8 <= len(key) <= 128:
        raise ApiError(400, "INVALID_IDEMPOTENCY_KEY", "缺少有效的幂等键（8-128 字符）")
    name, rel, content = _validate_text(payload)
    email = str(payload.get("email") or "").strip().lower()
    if email and not valid_email(email):
        raise ApiError(400, "INVALID_EMAIL", "邮箱格式不正确")
    notify = bool(payload.get("notify_opt_in"))
    if notify and not email:
        raise ApiError(400, "NOTIFY_REQUIRES_EMAIL", "选择接收通知时需要填写邮箱")

    req_hash = hashlib.sha256(json.dumps(
        {"n": name, "r": rel, "c": content, "e": email, "nt": notify},
        ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    initial = "pending" if mode == "pre_moderation" else "inbox"

    with store.tx() as c:
        _purge_expired_keys(c)
        row = c.execute("SELECT * FROM idempotency_keys WHERE key=?", (key,)).fetchone()
        if row:
            if row["request_hash"] != req_hash:
                raise ApiError(409, "IDEMPOTENCY_KEY_CONFLICT",
                               "同一幂等键提交了不同内容；新留言请重新打开表单")
            return json.loads(row["response_json"]), True   # 有界重试：原样返回

        sid, token, now = new_id(), new_token(), now_iso()
        has_contact = 1 if (email and notify) else 0
        c.execute(
            "INSERT INTO submissions (id, public_id, manage_token_hash, status, current_version,"
            " notify_opt_in, has_contact, email_hash, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (sid, new_id(), hash_token(token), initial, 1,
             1 if notify else 0, has_contact, hash_email(email) if email else None, now, now))
        c.execute(
            "INSERT INTO versions (id, submission_id, version_no, author_name, relationship,"
            " content, created_at) VALUES (?,?,?,?,?,?,?)",
            (new_id(), sid, 1, name, rel, content, now))
        if has_contact:
            # 明文邮箱只进隔离表；仅当作者明确选择接收通知时才保存
            c.execute("INSERT INTO contacts (submission_id, email_plain, created_at)"
                      " VALUES (?,?,?)", (sid, email, now))
        _add_event(c, sid, 1, "submit", "guest", None, None, initial)
        resp = {
            "submission_id": sid,
            "manage_token": token,
            "status": initial,
            "status_label": STATUS_LABELS[initial],
            "current_version": 1,
            "note": "提交成功。请求成功不代表已公开：通过站主审核后才会展示在公开墙。",
        }
        c.execute(
            "INSERT INTO idempotency_keys (key, submission_id, request_hash, response_json,"
            " created_at) VALUES (?,?,?,?,?)",
            (key, sid, req_hash, json.dumps(resp, ensure_ascii=False), now))
        return resp, False


# ---------- 访客：生命周期 ----------

def edit_submission(store, sid, token, payload, mode):
    name, rel, content = _validate_text(payload)
    with store.tx() as c:
        sub = _auth_guest(c, sid, token)
        if sub["status"] == "withdrawn":
            raise ApiError(409, "STATE_WITHDRAWN", "已撤回的留言不能编辑")
        new_version = sub["current_version"] + 1
        was_approved = sub["status"] == "approved"
        if was_approved:
            # 修改后原批准失效：立即移除公开快照
            c.execute("DELETE FROM snapshots WHERE submission_id=?", (sid,))
            _bump_list_version(c)
        new_status = "pending" if mode == "pre_moderation" else "inbox"
        now = now_iso()
        c.execute("UPDATE submissions SET current_version=?, status=?, updated_at=? WHERE id=?",
                  (new_version, new_status, now, sid))
        c.execute(
            "INSERT INTO versions (id, submission_id, version_no, author_name, relationship,"
            " content, created_at) VALUES (?,?,?,?,?,?,?)",
            (new_id(), sid, new_version, name, rel, content, now))
        _add_event(c, sid, new_version, "edit", "guest",
                   "内容已修改，原批准失效" if was_approved else None,
                   sub["status"], new_status)
        return {
            "submission_id": sid,
            "status": new_status,
            "status_label": STATUS_LABELS[new_status],
            "current_version": new_version,
            "approval_invalidated": was_approved,
            "note": ("修改已保存；原批准已失效，需重新审核。" if was_approved
                     else "修改已保存，等待站主审核。"),
        }


def withdraw(store, sid, token):
    with store.tx() as c:
        sub = _auth_guest(c, sid, token)
        if sub["status"] == "withdrawn":
            return {"submission_id": sid, "status": "withdrawn",
                    "status_label": STATUS_LABELS["withdrawn"], "already_withdrawn": True}
        had = c.execute("SELECT 1 FROM snapshots WHERE submission_id=?", (sid,)).fetchone()
        c.execute("DELETE FROM snapshots WHERE submission_id=?", (sid,))
        if had:
            _bump_list_version(c)
        c.execute("UPDATE submissions SET status='withdrawn', updated_at=? WHERE id=?",
                  (now_iso(), sid))
        _add_event(c, sid, sub["current_version"], "withdraw", "guest", None,
                   sub["status"], "withdrawn")
        return {"submission_id": sid, "status": "withdrawn",
                "status_label": STATUS_LABELS["withdrawn"], "already_withdrawn": False,
                "note": "已撤回；公开墙快照已移除。"}


def appeal(store, sid, token, reason=None):
    with store.tx() as c:
        sub = _auth_guest(c, sid, token)
        if sub["status"] != "rejected":
            raise ApiError(409, "STATE", "只有未通过的留言可以申诉")
        c.execute("UPDATE submissions SET status='appealed', updated_at=? WHERE id=?",
                  (now_iso(), sid))
        _add_event(c, sid, sub["current_version"], "appeal", "guest", reason,
                   "rejected", "appealed")
        return {"submission_id": sid, "status": "appealed",
                "status_label": STATUS_LABELS["appealed"]}


def cleanup_contact(store, sid, token):
    """清理联系信息请求：删除明文与哈希，关闭通知。"""
    with store.tx() as c:
        sub = _auth_guest(c, sid, token)
        now = now_iso()
        c.execute("DELETE FROM contacts WHERE submission_id=?", (sid,))
        c.execute("UPDATE submissions SET has_contact=0, email_hash=NULL, notify_opt_in=0,"
                  " contact_cleared_at=?, updated_at=? WHERE id=?", (now, now, sid))
        _add_event(c, sid, sub["current_version"], "contact_cleanup", "guest",
                   "应作者请求清除联系信息", sub["status"], sub["status"])
        return {"submission_id": sid, "contact_cleared": True,
                "note": "联系信息已清除；后续通知将无法送达。"}


# ---------- 站主：审核（带版本条件） ----------

def _check_version(c, sub, expected_version, action_label):
    if sub["current_version"] != expected_version:
        _add_event(c, sub["id"], expected_version, "approve_conflict", "owner",
                   f"{action_label}时期望 v{expected_version}，当前 v{sub['current_version']}",
                   sub["status"], sub["status"])
        raise ApiError(409, "VERSION_CONFLICT", "内容在审核期间已变化，请重新审阅",
                       {"current_version": sub["current_version"]})


def approve(store, sid, expected_version, reason=None):
    with store.tx() as c:
        sub = _get_submission(c, sid)
        if sub["status"] == "withdrawn":
            raise ApiError(409, "STATE_WITHDRAWN", "作者已撤回该留言，不能批准")
        _check_version(c, sub, expected_version, "批准")
        if sub["status"] == "approved":
            return _owner_view(c, sid)   # 同版本重复批准：幂等返回
        v = _version_row(c, sid, expected_version)
        now = now_iso()
        c.execute(
            "INSERT OR REPLACE INTO snapshots (submission_id, public_id, version_no,"
            " author_name, relationship, content, approved_at) VALUES (?,?,?,?,?,?,?)",
            (sid, sub["public_id"], expected_version, v["author_name"], v["relationship"],
             v["content"], now))
        _bump_list_version(c)
        action = "reapprove" if sub["status"] in ("rejected", "appealed") else "approve"
        c.execute("UPDATE submissions SET status='approved', updated_at=? WHERE id=?",
                  (now, sid))
        _add_event(c, sid, expected_version, action, "owner", reason, sub["status"], "approved")
        _dispatch_notification(c, sub, "approved")
        return _owner_view(c, sid)


def reject(store, sid, expected_version, reason=None):
    with store.tx() as c:
        sub = _get_submission(c, sid)
        if sub["status"] == "withdrawn":
            raise ApiError(409, "STATE_WITHDRAWN", "作者已撤回该留言")
        _check_version(c, sub, expected_version, "拒绝")
        if sub["status"] == "rejected":
            return _owner_view(c, sid)
        had = c.execute("SELECT 1 FROM snapshots WHERE submission_id=?", (sid,)).fetchone()
        c.execute("DELETE FROM snapshots WHERE submission_id=?", (sid,))
        if had:
            _bump_list_version(c)
        c.execute("UPDATE submissions SET status='rejected', updated_at=? WHERE id=?",
                  (now_iso(), sid))
        _add_event(c, sid, expected_version, "reject", "owner", reason, sub["status"], "rejected")
        _dispatch_notification(c, sub, "rejected")
        return _owner_view(c, sid)


# ---------- 公开读模型 ----------

def public_list(store, cursor, limit):
    """游标分页：撤回/修改只删快照，偏移式分页会错位，游标不会。"""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 20
    limit = max(1, min(MAX_LIMIT, limit))
    where, args = "", []
    if cursor:
        parts = cursor.split("|", 1)
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise ApiError(400, "INVALID_CURSOR", "分页游标无效")
        where = "WHERE (approved_at < ? OR (approved_at = ? AND public_id < ?))"
        args = [parts[0], parts[0], parts[1]]
    with store.tx() as c:
        rows = c.execute(
            f"SELECT * FROM snapshots {where} ORDER BY approved_at DESC, public_id DESC LIMIT ?",
            (*args, limit + 1)).fetchall()
        items = rows[:limit]
        next_cursor = None
        if len(rows) > limit and items:
            last = items[-1]
            next_cursor = f"{last['approved_at']}|{last['public_id']}"
        return {"items": [_public_view(r) for r in items],
                "next_cursor": next_cursor,
                "list_version": _list_version(c)}


def _public_view(row):
    """公开视图：绝不包含邮箱、令牌、内部状态。"""
    return {
        "id": row["public_id"],
        "author_name": row["author_name"],
        "relationship": row["relationship"],
        "content": row["content"],
        "approved_at": row["approved_at"],
    }


# ---------- 视图 ----------

def guest_view(store, sid, token):
    with store.tx() as c:
        sub = _auth_guest(c, sid, token)
        versions = c.execute(
            "SELECT version_no, author_name, relationship, content, created_at FROM versions"
            " WHERE submission_id=? ORDER BY version_no DESC", (sid,)).fetchall()
        events = c.execute(
            "SELECT action, actor, version_no, reason, from_status, to_status, created_at"
            " FROM events WHERE submission_id=? ORDER BY created_at ASC, rowid ASC",
            (sid,)).fetchall()
        notifs = c.execute(
            "SELECT kind, status, created_at FROM notifications WHERE submission_id=?"
            " ORDER BY created_at ASC", (sid,)).fetchall()
        actions = []
        if sub["status"] != "withdrawn":
            actions += ["edit", "withdraw"]
        if sub["status"] == "rejected":
            actions += ["appeal"]
        if sub["has_contact"] or sub["email_hash"]:
            actions += ["contact_cleanup"]
        return {
            "submission_id": sid,
            "status": sub["status"],
            "status_label": STATUS_LABELS[sub["status"]],
            "current_version": sub["current_version"],
            "created_at": sub["created_at"],
            "versions": [dict(v) for v in versions],
            "events": [dict(e) for e in events],
            "contact": {
                "present": bool(sub["has_contact"]),
                "notify_opt_in": bool(sub["notify_opt_in"]),
                "cleared_at": sub["contact_cleared_at"],
            },
            "notifications": [
                {"kind": n["kind"], "status": n["status"],
                 "status_label": NOTIFICATION_LABELS.get(n["status"], n["status"]),
                 "created_at": n["created_at"]} for n in notifs],
            "available_actions": actions,
        }


def owner_queue(store, mode):
    with store.tx() as c:
        subs = c.execute("SELECT * FROM submissions ORDER BY created_at DESC, id DESC").fetchall()
        items = []
        for s in subs:
            v = _version_row(c, s["id"], s["current_version"])
            reviewed = c.execute(
                "SELECT MAX(version_no) AS mv FROM events WHERE submission_id=?"
                " AND actor='owner' AND action IN ('approve','reject','reapprove','approve_conflict')",
                (s["id"],)).fetchone()["mv"] or 0
            items.append({
                "id": s["id"],
                "public_id": s["public_id"],
                "status": s["status"],
                "status_label": STATUS_LABELS[s["status"]],
                "current_version": s["current_version"],
                "last_reviewed_version": reviewed,
                # 待处理冲突：站主上次见到的版本之后内容又变了
                "has_conflict": s["current_version"] > reviewed
                                and s["status"] in ("pending", "inbox", "appealed"),
                "author_name": v["author_name"],
                "relationship": v["relationship"],
                "content": v["content"],
                "created_at": s["created_at"],
                "updated_at": s["updated_at"],
                "notify_opt_in": bool(s["notify_opt_in"]),
                "contact": _owner_contact_view(c, s),
            })
        return {"mode": mode, "list_version": _list_version(c), "items": items}


def _owner_view(c, sid):
    sub = _get_submission(c, sid)
    versions = c.execute(
        "SELECT version_no, author_name, relationship, content, created_at FROM versions"
        " WHERE submission_id=? ORDER BY version_no DESC", (sid,)).fetchall()
    events = c.execute(
        "SELECT action, actor, version_no, reason, from_status, to_status, created_at"
        " FROM events WHERE submission_id=? ORDER BY created_at ASC, rowid ASC",
        (sid,)).fetchall()
    return {
        "id": sid,
        "public_id": sub["public_id"],
        "status": sub["status"],
        "status_label": STATUS_LABELS[sub["status"]],
        "current_version": sub["current_version"],
        "contact": _owner_contact_view(c, sub),
        "versions": [dict(v) for v in versions],
        "events": [dict(e) for e in events],
    }


def owner_get(store, sid):
    with store.tx() as c:
        return _owner_view(c, sid)


def owner_notifications(store):
    with store.tx() as c:
        rows = c.execute(
            "SELECT n.*, s.public_id AS pid FROM notifications n"
            " JOIN submissions s ON s.id = n.submission_id"
            " ORDER BY n.created_at DESC, n.id DESC").fetchall()
        return {"items": [{
            "id": r["id"],
            "submission_id": r["submission_id"],
            "public_id": r["pid"],
            "kind": r["kind"],
            "status": r["status"],
            "status_label": NOTIFICATION_LABELS.get(r["status"], r["status"]),
            "detail": r["detail"],
            "created_at": r["created_at"],
        } for r in rows]}
