'use strict';
/**
 * 持久化存储层（零依赖）。
 *
 * 设计要点：
 * - 单进程内所有写操作同步执行，天然串行；withTx 在提交点一次性原子落盘
 *   （临时文件 + rename），异常时回滚到事务前快照，满足「校验后持久存储」。
 * - 数据模型围绕两条主线：
 *   1) versions：留言的每一次提交版本（不可变、追加式）；
 *   2) events：每一次审核/作者动作事件（不可变、追加式）。
 * - snapshots 是「批准快照」，公开页面只读它；它与 messages 当前状态解耦，
 *   留言被修改/撤回时快照被移除，公开页立即不可见。
 * - contacts 是隔离受限字段：邮箱只出现在这里与 outbox（发送副本），
 *   任何公开读取路径都不接触它。
 */
const fs = require('node:fs');
const path = require('node:path');
const { now } = require('./util.js');

const WALL_VERSION_KEY = 'wall_version';

function emptyState() {
  return {
    meta: { [WALL_VERSION_KEY]: 0 },
    messages: {},   // id -> {id,status,current_version,author_token_hash,notify_opt_in,has_conflict,created_at,updated_at}
    versions: {},   // `${id}:${version}` -> {message_id,version,content,relation,created_at}
    contacts: {},   // message_id -> {email,email_hash,erased_at}  —— 隔离受限字段
    events: [],     // {seq,message_id,version,action,actor,note,created_at}
    snapshots: {},  // message_id -> {message_id,version,content,relation,approved_at} —— 公开页唯一数据源
    idempotency: {},// key -> {message_id,response,created_at,expires_at}
    outbox: [],     // {id,message_id,kind,email,status,attempts,created_at,updated_at}
    seq: { event: 0, outbox: 0 },
  };
}

class Store {
  /**
   * @param {string} filePath 持久化文件路径；':memory:' 表示纯内存（测试用）
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.state = emptyState();
    if (filePath !== ':memory:' && fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim()) this.state = { ...emptyState(), ...JSON.parse(raw) };
    } else if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this._persist();
    }
  }

  _persist() {
    if (this.filePath === ':memory:') return;
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.filePath); // 原子替换，避免半截文件
  }

  /**
   * 事务：fn 内全部变更要么一起落盘，要么整体回滚。
   */
  withTx(fn) {
    const backup = structuredClone(this.state);
    try {
      const out = fn(this.state);
      this._persist();
      return out;
    } catch (err) {
      this.state = backup;
      throw err;
    }
  }

  // ---------- 只读辅助 ----------
  getWallVersion() {
    return this.state.meta[WALL_VERSION_KEY];
  }

  getMessage(id) {
    return this.state.messages[id] || null;
  }

  getVersion(messageId, version) {
    return this.state.versions[`${messageId}:${version}`] || null;
  }

  getContact(messageId) {
    return this.state.contacts[messageId] || null;
  }

  listVersions(messageId) {
    return Object.values(this.state.versions)
      .filter((v) => v.message_id === messageId)
      .sort((a, b) => a.version - b.version);
  }

  listEvents(messageId) {
    return this.state.events.filter((e) => e.message_id === messageId);
  }

  listByStatus(status) {
    return Object.values(this.state.messages)
      .filter((m) => m.status === status)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }

  listConflicts() {
    return Object.values(this.state.messages).filter((m) => m.has_conflict);
  }

  /** 公开墙分页：只读批准快照，游标 (approved_at, message_id) 倒序 */
  listSnapshots({ cursor = null, limit = 10 }) {
    const all = Object.values(this.state.snapshots).sort((a, b) =>
      a.approved_at === b.approved_at
        ? (a.message_id < b.message_id ? 1 : -1)
        : (a.approved_at < b.approved_at ? 1 : -1));
    let start = 0;
    if (cursor) {
      const idx = all.findIndex((s) =>
        s.approved_at < cursor.approved_at ||
        (s.approved_at === cursor.approved_at && s.message_id < cursor.message_id));
      start = idx === -1 ? all.length : idx;
    }
    const page = all.slice(start, start + limit + 1);
    const hasMore = page.length > limit;
    const items = page.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? { approved_at: last.approved_at, message_id: last.message_id } : null,
    };
  }

  listOutbox(limit = 50) {
    return this.state.outbox.slice(-limit).reverse();
  }

  getOutbox(id) {
    return this.state.outbox.find((o) => o.id === id) || null;
  }

  // ---------- 写辅助（须在 withTx 内调用） ----------
  bumpWallVersion(s) {
    s.meta[WALL_VERSION_KEY] += 1;
  }

  addEvent(s, { messageId, version = null, action, actor, note = null }) {
    s.seq.event += 1;
    s.events.push({
      seq: s.seq.event, message_id: messageId, version,
      action, actor, note: note ? String(note).slice(0, 500) : null,
      created_at: now(),
    });
  }

  /** 联系信息清理：抹除受限字段与待发邮件副本中的邮箱 */
  eraseContact(s, messageId) {
    const ts = now();
    s.contacts[messageId] = { email: null, email_hash: null, erased_at: ts };
    for (const o of s.outbox) {
      if (o.message_id !== messageId) continue;
      o.email = null;
      o.updated_at = ts;
      if (o.status === 'queued') o.status = 'canceled';
    }
  }
}

module.exports = { Store, WALL_VERSION_KEY };
