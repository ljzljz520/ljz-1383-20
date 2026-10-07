'use strict';
/**
 * 访客留言审核墙 —— HTTP 应用（零依赖）。
 *
 * 路由总览：
 *   公开：
 *     GET  /guestbook(.html)         SSR 留言墙（只读批准快照，输出转义）
 *     GET  /api/wall                 批准快照分页（游标 + wall_version + ETag）
 *     GET  /api/wall/version         轻量版本探针（客户端丢弃过期分页缓存）
 *   访客（作者凭据 X-Author-Token）：
 *     POST /api/messages             提交（强制 Idempotency-Key，有界幂等）
 *     GET  /api/messages/:id/status  查看自己的留言状态
 *     POST /api/messages/:id/edit    修改（base_version 条件；原批准立即失效）
 *     POST /api/messages/:id/withdraw    撤回
 *     POST /api/messages/:id/appeal      申诉（被拒绝后）
 *     POST /api/messages/:id/erase-contact 清理联系信息
 *   站主（Authorization: Bearer）：
 *     GET  /api/admin/overview       待审/收件箱/申诉/冲突/已批准/通知外发
 *     GET  /api/admin/messages/:id   详情（含版本、事件、受限邮箱字段）
 *     POST /api/admin/messages/:id/(approve|reject|reapprove)  审核（expected_version 条件）
 *     POST /api/admin/outbox/:id/attempt  标记一次发送尝试（送达状态永远为「未知」）
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store.js');
const { renderGuestbookPage } = require('./render.js');
const {
  now, randomId, randomToken, sha256, tokenEqual,
  escapeHtml, validateSubmission, clampInt, LIMITS,
} = require('./util.js');

const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000; // 有界幂等：草稿键 24h 后过期
const WALL_PAGE_DEFAULT = 10;
const WALL_PAGE_MAX = 50;
const MAX_BODY_BYTES = 16 * 1024;
const SUBMIT_RATE = { windowMs: 10 * 60 * 1000, max: 20 }; // 匿名提交限流

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

// 留言墙相关响应的严格 CSP：脚本/样式仅允许同源，杜绝内联注入执行
const WALL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function createApp(config = {}) {
  const {
    rootDir = path.join(__dirname, '..'),
    dbPath = path.join(__dirname, '..', 'data', 'wall.json'),
    mode = 'premoderation',           // 'premoderation'（先审后发）| 'inbox'（私密收件箱）
    adminToken = 'dev-admin-token',
    notifyEnabled = false,            // 全站通知开关：明确选择才启用
    siteSalt = 'dev-site-salt',       // 邮箱哈希盐（仅用于联系信息查找，不作身份）
  } = config;
  if (!['premoderation', 'inbox'].includes(mode)) throw new Error(`unknown mode: ${mode}`);

  const store = new Store(dbPath);
  const submitBuckets = new Map(); // 简单限流：ip -> {count, resetAt}

  // ---------------- 基础工具 ----------------
  function send(res, status, body, headers = {}) {
    const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    const payload = isObj ? JSON.stringify(body) : body;
    res.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...headers,
    });
    res.end(payload);
  }
  const sendJson = (res, status, obj, headers) =>
    send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function rateLimited(ip) {
    const t = Date.now();
    let b = submitBuckets.get(ip);
    if (!b || t > b.resetAt) { b = { count: 0, resetAt: t + SUBMIT_RATE.windowMs }; submitBuckets.set(ip, b); }
    b.count += 1;
    return b.count > SUBMIT_RATE.max;
  }

  const initialStatus = () => (mode === 'inbox' ? 'inbox' : 'pending');

  function authorId(req, id) {
    const token = req.headers['x-author-token'];
    if (!token) return false;
    const msg = store.getMessage(id);
    return !!msg && tokenEqual(msg.author_token_hash, sha256(String(token)));
  }

  function adminOk(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && tokenEqual(m[1], adminToken);
  }

  /** 站主视图的单条摘要：不含邮箱，只有 has_contact 标志 */
  function adminSummary(m) {
    const v = store.getVersion(m.id, m.current_version);
    const c = store.getContact(m.id);
    return {
      id: m.id, status: m.status, version: m.current_version,
      content: v ? v.content : null, relation: v ? v.relation : null,
      notify_opt_in: !!m.notify_opt_in, has_contact: !!(c && c.email),
      has_conflict: !!m.has_conflict, created_at: m.created_at, updated_at: m.updated_at,
    };
  }

  function queueApprovalNotice(s, msg) {
    // 通知是否启用由明确选择决定：全站开关 + 作者逐条 opt-in，二者缺一不可
    if (!notifyEnabled || !msg.notify_opt_in) return;
    const contact = s.contacts[msg.id];
    if (contact && contact.email) {
      s.seq.outbox += 1;
      s.outbox.push({
        id: s.seq.outbox, message_id: msg.id, kind: 'approved_notice',
        email: contact.email, status: 'queued', attempts: 0,
        created_at: now(), updated_at: now(),
      });
      store.addEvent(s, { messageId: msg.id, version: msg.current_version, action: 'notify_queued', actor: 'system' });
    } else {
      store.addEvent(s, { messageId: msg.id, version: msg.current_version, action: 'notify_skipped', actor: 'system', note: '联系信息不可用，无法发送通知' });
    }
  }

  // ---------------- 访客接口 ----------------
  async function handleSubmit(req, res) {
    if (rateLimited(req.socket.remoteAddress || 'unknown')) {
      return sendJson(res, 429, { error: 'rate_limited', message: '提交过于频繁，请稍后再试' });
    }
    // 有界幂等身份：客户端为「每一份草稿」生成随机键；重试复用同一键。
    // 键与邮箱/身份无关 —— 同一个人的不同留言是不同草稿、不同键，绝不会被误合并。
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 128) {
      return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少 Idempotency-Key 请求头' });
    }
    const body = await readJsonBody(req);
    const v = validateSubmission(body);
    if (!v.ok) return sendJson(res, 422, { error: 'validation_failed', details: v.errors });
    const notifyOptIn = body.notify_opt_in === true;
    if (notifyOptIn && !v.email) {
      return sendJson(res, 422, { error: 'notification_requires_email', message: '选择邮件通知时必须填写邮箱' });
    }

    const result = store.withTx((s) => {
      for (const [k, rec] of Object.entries(s.idempotency)) {
        if (rec.expires_at < now()) delete s.idempotency[k]; // 惰性清理过期键（有界）
      }
      const hit = s.idempotency[idemKey];
      if (hit) return { replay: true, response: hit.response };

      const id = randomId('msg');
      const token = randomToken();
      const ts = now();
      s.messages[id] = {
        id, status: initialStatus(), current_version: 1,
        author_token_hash: sha256(token), notify_opt_in: notifyOptIn ? 1 : 0,
        has_conflict: 0, created_at: ts, updated_at: ts,
      };
      s.versions[`${id}:1`] = { message_id: id, version: 1, content: v.content, relation: v.relation, created_at: ts };
      if (v.email) {
        // 邮箱进入隔离受限字段；哈希仅用于联系信息层面的查找，绝不作为身份合并依据
        s.contacts[id] = { email: v.email, email_hash: sha256(`${siteSalt}:${v.email}`), erased_at: null };
      }
      store.addEvent(s, { messageId: id, version: 1, action: 'submit', actor: 'visitor' });
      const response = { id, author_token: token, status: s.messages[id].status, version: 1 };
      s.idempotency[idemKey] = {
        message_id: id, response,
        created_at: ts, expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      };
      return { replay: false, response };
    });
    return sendJson(res, result.replay ? 200 : 201, result.response,
      result.replay ? { 'Idempotent-Replay': 'true' } : undefined);
  }

  function handleStatus(req, res, id) {
    if (!authorId(req, id)) return sendJson(res, 403, { error: 'forbidden' });
    const m = store.getMessage(id);
    const v = store.getVersion(id, m.current_version);
    const c = store.getContact(id);
    return sendJson(res, 200, {
      id: m.id, status: m.status, version: m.current_version,
      content: v.content, relation: v.relation,
      notify_opt_in: !!m.notify_opt_in, has_contact: !!(c && c.email),
    });
  }

  async function handleEdit(req, res, id) {
    if (!authorId(req, id)) return sendJson(res, 403, { error: 'forbidden' });
    const body = await readJsonBody(req);
    const v = validateSubmission(body);
    if (!v.ok) return sendJson(res, 422, { error: 'validation_failed', details: v.errors });
    const baseVersion = Number(body.base_version);
    const notifyOptIn = body.notify_opt_in === true;
    const emailProvided = Object.prototype.hasOwnProperty.call(body, 'email');

    const result = store.withTx((s) => {
      const m = s.messages[id];
      if (!m) return { status: 404, body: { error: 'not_found' } };
      // 版本条件：作者基于 base_version 修改，防止两个标签页互相覆盖
      if (m.current_version !== baseVersion) {
        return { status: 409, body: { error: 'version_conflict', current_version: m.current_version } };
      }
      const contact = s.contacts[id];
      const effectiveEmail = emailProvided ? v.email : (contact && contact.email) || null;
      if (notifyOptIn && !effectiveEmail) {
        return { status: 422, body: { error: 'notification_requires_email', message: '选择邮件通知时必须填写邮箱' } };
      }
      const ts = now();
      const newVersion = m.current_version + 1;
      s.versions[`${id}:${newVersion}`] = { message_id: id, version: newVersion, content: v.content, relation: v.relation, created_at: ts };

      const fromStatus = m.status;
      let wallChanged = false;
      if (m.status === 'approved') {
        // 修改使原批准立即失效：批准快照移除，公开页不再展示，等待重新审核
        delete s.snapshots[id];
        wallChanged = true;
        m.status = initialStatus();
      } else if (['rejected', 'appealed', 'withdrawn'].includes(m.status)) {
        m.status = initialStatus(); // 修改即重新提交
      }
      m.current_version = newVersion;
      m.notify_opt_in = notifyOptIn ? 1 : 0;
      m.updated_at = ts;

      if (emailProvided) {
        if (v.email) {
          s.contacts[id] = { email: v.email, email_hash: sha256(`${siteSalt}:${v.email}`), erased_at: null };
        } else {
          store.eraseContact(s, id); // 显式清空邮箱 = 清理联系信息
        }
      }
      store.addEvent(s, { messageId: id, version: newVersion, action: 'edit', actor: 'visitor', note: `from_status:${fromStatus}` });
      if (wallChanged) store.bumpWallVersion(s);
      return { status: 200, body: { id, version: newVersion, status: m.status } };
    });
    return sendJson(res, result.status, result.body);
  }

  function handleWithdraw(req, res, id) {
    if (!authorId(req, id)) return sendJson(res, 403, { error: 'forbidden' });
    const result = store.withTx((s) => {
      const m = s.messages[id];
      if (!m) return { status: 404, body: { error: 'not_found' } };
      if (m.status === 'withdrawn') return { status: 200, body: { id, status: 'withdrawn' } }; // 幂等
      const ts = now();
      const hadSnapshot = !!s.snapshots[id];
      delete s.snapshots[id]; // 撤回即刻从公开墙消失
      m.status = 'withdrawn';
      m.updated_at = ts;
      for (const o of s.outbox) {
        if (o.message_id === id && o.status === 'queued') { o.status = 'canceled'; o.updated_at = ts; }
      }
      store.addEvent(s, { messageId: id, version: m.current_version, action: 'withdraw', actor: 'visitor' });
      if (hadSnapshot) store.bumpWallVersion(s);
      return { status: 200, body: { id, status: 'withdrawn' } };
    });
    return sendJson(res, result.status, result.body);
  }

  async function handleAppeal(req, res, id) {
    if (!authorId(req, id)) return sendJson(res, 403, { error: 'forbidden' });
    const body = await readJsonBody(req);
    const note = typeof body.note === 'string' ? body.note.slice(0, LIMITS.note) : null;
    const result = store.withTx((s) => {
      const m = s.messages[id];
      if (!m) return { status: 404, body: { error: 'not_found' } };
      if (m.status !== 'rejected') {
        return { status: 409, body: { error: 'invalid_state', current_status: m.status, message: '只有被拒绝的留言可以申诉' } };
      }
      m.status = 'appealed';
      m.updated_at = now();
      store.addEvent(s, { messageId: id, version: m.current_version, action: 'appeal', actor: 'visitor', note });
      return { status: 200, body: { id, status: 'appealed' } };
    });
    return sendJson(res, result.status, result.body);
  }

  function handleEraseContact(req, res, id) {
    if (!authorId(req, id)) return sendJson(res, 403, { error: 'forbidden' });
    const result = store.withTx((s) => {
      const m = s.messages[id];
      if (!m) return { status: 404, body: { error: 'not_found' } };
      store.eraseContact(s, id);
      store.addEvent(s, { messageId: id, version: m.current_version, action: 'contact_erased', actor: 'visitor' });
      return { status: 200, body: { id, erased: true } };
    });
    return sendJson(res, result.status, result.body);
  }

  // ---------------- 公开墙接口 ----------------
  function encodeCursor(c) { return Buffer.from(JSON.stringify(c)).toString('base64url'); }
  function decodeCursor(s) {
    try {
      const o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
      if (typeof o.approved_at === 'string' && typeof o.message_id === 'string') return o;
    } catch { /* fallthrough */ }
    return null;
  }

  function handleWall(req, res, url) {
    const limit = clampInt(url.searchParams.get('limit'), 1, WALL_PAGE_MAX, WALL_PAGE_DEFAULT);
    const cursorRaw = url.searchParams.get('cursor');
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) return sendJson(res, 400, { error: 'bad_cursor' });

    const { items, nextCursor } = store.listSnapshots({ cursor, limit });
    const wallVersion = store.getWallVersion();
    // 公开载荷白名单：绝不包含邮箱、作者凭据、内部状态
    const payload = {
      items: items.map((it) => ({
        id: it.message_id, content: it.content, relation: it.relation,
        version: it.version, approved_at: it.approved_at,
      })),
      next_cursor: nextCursor ? encodeCursor(nextCursor) : null,
      wall_version: wallVersion,
    };
    const etag = `W/"wall-${wallVersion}-${cursorRaw || 'first'}-${limit}"`;
    const headers = { ETag: etag, 'Cache-Control': 'no-cache', 'Content-Security-Policy': WALL_CSP };
    if (req.headers['if-none-match'] === etag) {
      return send(res, 304, null, headers);
    }
    return sendJson(res, 200, payload, headers);
  }

  function handleWallVersion(req, res) {
    return sendJson(res, 200, { wall_version: store.getWallVersion() }, { 'Cache-Control': 'no-store' });
  }

  function handleGuestbookPage(req, res) {
    const { items, nextCursor } = store.listSnapshots({ limit: WALL_PAGE_DEFAULT });
    const html = renderGuestbookPage({
      items, nextCursor, wallVersion: store.getWallVersion(), mode, notifyEnabled,
    });
    return send(res, 200, html, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': WALL_CSP,
      'Cache-Control': 'no-cache',
    });
  }

  // ---------------- 站主接口 ----------------
  function handleAdminOverview(req, res) {
    const pick = (status) => store.listByStatus(status).map(adminSummary);
    const approved = Object.values(store.state.messages)
      .filter((m) => m.status === 'approved')
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .slice(0, 20)
      .map(adminSummary);
    return sendJson(res, 200, {
      mode,
      notifications_enabled: notifyEnabled,
      wall_version: store.getWallVersion(),
      pending: pick('pending'),
      inbox: pick('inbox'),
      appealed: pick('appealed'),
      conflicts: store.listConflicts().map(adminSummary),
      approved,
      outbox: store.listOutbox(50).map((o) => ({
        // 外发队列对站主透明：邮箱只以「是否有收件人」呈现，明细在详情接口
        id: o.id, message_id: o.message_id, kind: o.kind, status: o.status,
        attempts: o.attempts, has_recipient: !!o.email,
        created_at: o.created_at, updated_at: o.updated_at,
      })),
    }, { 'Content-Security-Policy': WALL_CSP });
  }

  function handleAdminDetail(req, res, id) {
    const m = store.getMessage(id);
    if (!m) return sendJson(res, 404, { error: 'not_found' });
    const c = store.getContact(id);
    return sendJson(res, 200, {
      ...adminSummary(m),
      versions: store.listVersions(id),
      events: store.listEvents(id),
      // 隔离受限字段：仅此站主详情接口可读邮箱明文；哈希无法用于发信，故必须保留明文字段
      contact: c ? { email: c.email, erased_at: c.erased_at } : null,
      outbox: store.state.outbox.filter((o) => o.message_id === id),
    }, { 'Content-Security-Policy': WALL_CSP });
  }

  async function handleModerate(req, res, id, action) {
    const body = await readJsonBody(req);
    const expected = Number(body.expected_version);
    const note = typeof body.note === 'string' ? body.note.slice(0, LIMITS.note) : null;

    const result = store.withTx((s) => {
      const m = s.messages[id];
      if (!m) return { status: 404, body: { error: 'not_found' } };
      const allowed = {
        approve: ['pending', 'inbox'],
        reject: ['pending', 'inbox', 'appealed'],
        reapprove: ['rejected', 'appealed'],
      }[action];
      if (!allowed.includes(m.status)) {
        return { status: 409, body: { error: 'invalid_state', current_status: m.status } };
      }
      // 审核与编辑竞争：版本条件不满足 => 冲突，站主需基于最新版本重新决定
      if (m.current_version !== expected) {
        m.has_conflict = 1;
        m.updated_at = now();
        store.addEvent(s, {
          messageId: id, version: m.current_version, action: 'conflict', actor: 'owner',
          note: `${action} 基于 v${expected}，但当前已是 v${m.current_version}`,
        });
        return { status: 409, body: { error: 'version_conflict', current_version: m.current_version } };
      }
      const ts = now();
      m.has_conflict = 0;
      m.updated_at = ts;
      if (action === 'reject') {
        m.status = 'rejected';
        store.addEvent(s, { messageId: id, version: m.current_version, action: 'reject', actor: 'owner', note });
        return { status: 200, body: { id, status: 'rejected', version: m.current_version } };
      }
      // approve / reapprove：写入批准快照 —— 公开墙的唯一数据来源
      const ver = s.versions[`${id}:${m.current_version}`];
      s.snapshots[id] = {
        message_id: id, version: m.current_version,
        content: ver.content, relation: ver.relation, approved_at: ts,
      };
      m.status = 'approved';
      store.bumpWallVersion(s);
      store.addEvent(s, { messageId: id, version: m.current_version, action, actor: 'owner', note });
      queueApprovalNotice(s, m);
      return { status: 200, body: { id, status: 'approved', version: m.current_version } };
    });
    return sendJson(res, result.status, result.body);
  }

  function handleOutboxAttempt(req, res, id) {
    const result = store.withTx((s) => {
      const o = s.outbox.find((x) => x.id === id);
      if (!o) return { status: 404, body: { error: 'not_found' } };
      if (o.status === 'canceled') return { status: 409, body: { error: 'invalid_state', current_status: o.status } };
      o.attempts += 1;
      // 没有投递回执通道：请求发出 ≠ 已送达。状态只能是「unknown（送达未知）」。
      o.status = 'unknown';
      o.updated_at = now();
      return { status: 200, body: { id: o.id, status: o.status, attempts: o.attempts } };
    });
    return sendJson(res, result.status, result.body);
  }

  // ---------------- 静态资源 ----------------
  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    const rel = pathname.replace(/^\/+/, '');
    const filePath = path.join(rootDir, rel);
    if (!filePath.startsWith(rootDir + path.sep)) return send(res, 403, 'Forbidden');
    const ext = path.extname(filePath).toLowerCase();
    const type = STATIC_TYPES[ext];
    if (!type || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return send(res, 404, 'Not Found');
    }
    const headers = { 'Content-Type': type };
    if (rel === 'admin.html') headers['Content-Security-Policy'] = WALL_CSP;
    return send(res, 200, fs.readFileSync(filePath), headers);
  }

  // ---------------- 路由 ----------------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const m = req.method;

      if (m === 'GET' && (p === '/guestbook' || p === '/guestbook.html')) return handleGuestbookPage(req, res);
      if (m === 'GET' && p === '/api/wall') return handleWall(req, res, url);
      if (m === 'GET' && p === '/api/wall/version') return handleWallVersion(req, res);
      if (m === 'POST' && p === '/api/messages') return await handleSubmit(req, res);

      let match = p.match(/^\/api\/messages\/([\w-]+)\/(status|edit|withdraw|appeal|erase-contact)$/);
      if (match) {
        const [, id, action] = match;
        if (m === 'GET' && action === 'status') return handleStatus(req, res, id);
        if (m !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (action === 'edit') return await handleEdit(req, res, id);
        if (action === 'withdraw') return handleWithdraw(req, res, id);
        if (action === 'appeal') return await handleAppeal(req, res, id);
        if (action === 'erase-contact') return handleEraseContact(req, res, id);
      }

      if (p.startsWith('/api/admin/')) {
        if (!adminOk(req)) return sendJson(res, 401, { error: 'unauthorized' });
        if (m === 'GET' && p === '/api/admin/overview') return handleAdminOverview(req, res);
        match = p.match(/^\/api\/admin\/messages\/([\w-]+)$/);
        if (match && m === 'GET') return handleAdminDetail(req, res, match[1]);
        match = p.match(/^\/api\/admin\/messages\/([\w-]+)\/(approve|reject|reapprove)$/);
        if (match && m === 'POST') return await handleModerate(req, res, match[1], match[2]);
        match = p.match(/^\/api\/admin\/outbox\/(\d+)\/attempt$/);
        if (match && m === 'POST') return handleOutboxAttempt(req, res, Number(match[1]));
        return sendJson(res, 404, { error: 'not_found' });
      }

      if (m === 'GET') return serveStatic(req, res, p);
      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return sendJson(res, status, { error: status >= 500 ? 'internal_error' : err.message });
    }
  });

  return { server, store };
}

module.exports = { createApp, WALL_CSP };
