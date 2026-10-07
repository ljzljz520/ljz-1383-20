"""SQLite 持久层：提交、版本、审核事件、批准快照、隔离的联系信息、通知记录。"""
import sqlite3
import threading
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,        -- 公开页使用的标识，与内部 id 分离
  manage_token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,                  -- pending|inbox|approved|rejected|appealed|withdrawn
  current_version INTEGER NOT NULL,
  notify_opt_in INTEGER NOT NULL DEFAULT 0,  -- 通知由作者明确选择开启
  has_contact INTEGER NOT NULL DEFAULT 0,    -- contacts 表中是否存在明文邮箱
  email_hash TEXT,                       -- 仅标识用哈希；不能用于发信，也不用于合并提交
  contact_cleared_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 有界幂等身份：一个键只绑定一条提交，带 TTL，与“人”无关
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,            -- 同键不同载荷 => 409
  response_json TEXT NOT NULL,           -- 重试时原样返回首个响应
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(submission_id, version_no)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  version_no INTEGER,                    -- 该事件作用的版本
  action TEXT NOT NULL,                  -- submit|edit|approve|reject|reapprove|appeal|withdraw|contact_cleanup|approve_conflict
  actor TEXT NOT NULL,                   -- guest|owner|system
  reason TEXT,
  from_status TEXT,
  to_status TEXT,
  created_at TEXT NOT NULL
);

-- 公开页唯一数据源：只有这里的内容对外可见
CREATE TABLE IF NOT EXISTS snapshots (
  submission_id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  content TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

-- 隔离受限字段：明文邮箱独立存放，只有通知子系统可以读取
CREATE TABLE IF NOT EXISTS contacts (
  submission_id TEXT PRIMARY KEY,
  email_plain TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- approved|rejected
  status TEXT NOT NULL,                  -- channel_not_configured|sent_unconfirmed|skipped_opt_out|skipped_no_contact
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('list_version', 0);
"""


class Store:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.lock = threading.RLock()

    @contextmanager
    def tx(self):
        """串行化的短事务；多步写入（状态+快照+事件+通知）保持原子。"""
        with self.lock:
            try:
                yield self.conn
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def close(self):
        with self.lock:
            self.conn.close()
