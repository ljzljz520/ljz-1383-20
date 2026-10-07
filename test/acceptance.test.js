'use strict';
/**
 * 验收测试：覆盖需求中的关键场景。
 * 每个用例使用独立的内存存储 + 随机端口，互不干扰。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app.js');

const ADMIN = 'test-admin-token';

async function setup(opts = {}) {
  const app = createApp({
    dbPath: ':memory:', adminToken: ADMIN, siteSalt: 'test-salt',
    notifyEnabled: false, mode: 'premoderation', ...opts,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => new Promise((r) => app.server.close(r)) };
}

// ---------- 请求辅助 ----------
const KEY = () => `draft-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function submit(base, body, key = KEY()) {
  const res = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json().catch(() => ({})) };
}
const adminGet = async (base, p) => (await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
const adminPost = (base, p, payload) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
  body: JSON.stringify(payload ?? {}),
});
const authorPost = (base, id, action, token, payload) => fetch(`${base}/api/messages/${id}/${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Author-Token': token },
  body: JSON.stringify(payload ?? {}),
});
const wall = async (base, qs = '') => {
  const res = await fetch(`${base}/api/wall${qs}`);
  return { res, body: await res.json() };
};
async function submitAndApprove(base, content, relation = '读者', extra = {}) {
  const s = await submit(base, { content, relation, ...extra });
  assert.equal(s.res.status, 201, JSON.stringify(s.body));
  const ok = await adminPost(base, `/api/admin/messages/${s.body.id}/approve`, { expected_version: 1 });
  assert.equal(ok.status, 200);
  return s.body;
}

// ---------- 1. 重复提交与有界幂等 ----------
test('重复提交：相同幂等键重试返回同一结果，不产生重复留言', async () => {
  const { base, close } = await setup();
  try {
    const key = KEY();
    const a = await submit(base, { content: '第一条', relation: '老同学' }, key);
    assert.equal(a.res.status, 201);
    const b = await submit(base, { content: '第一条', relation: '老同学' }, key);
    assert.equal(b.res.status, 200);
    assert.equal(b.res.headers.get('idempotent-replay'), 'true');
    assert.equal(b.body.id, a.body.id);
    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.pending.length, 1);
  } finally { await close(); }
});

test('同一邮箱的多条不同留言不会被误合并（邮箱哈希不是身份）', async () => {
  const { base, close } = await setup();
  try {
    const email = 'same-person@example.com';
    const a = await submit(base, { content: '留言甲', relation: '读者', email });
    const b = await submit(base, { content: '留言乙', relation: '读者', email });
    assert.notEqual(a.body.id, b.body.id);
    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.pending.length, 2);
  } finally { await close(); }
});

test('缺少 Idempotency-Key 的匿名提交被拒绝', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x', relation: 'y' }),
    });
    assert.equal(res.status, 400);
  } finally { await close(); }
});

// ---------- 2. 审核与编辑竞争 ----------
test('审核时内容变化：版本条件触发 409 冲突，站主可见并基于新版重新批准', async () => {
  const { base, close } = await setup();
  try {
    const s = await submit(base, { content: '原始内容', relation: '读者' });
    const { id, author_token: token } = s.body;
    // 站主看到的是 v1；此时作者修改为 v2
    const edit = await authorPost(base, id, 'edit', token, { base_version: 1, content: '修改后的内容', relation: '读者' });
    assert.equal(edit.status, 200);
    // 站主基于过期的 v1 批准 => 409 冲突
    const stale = await adminPost(base, `/api/admin/messages/${id}/approve`, { expected_version: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'version_conflict');
    // 冲突对站主可见
    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.conflicts.length, 1);
    assert.equal(ov.conflicts[0].id, id);
    assert.equal(ov.conflicts[0].version, 2);
    // 基于最新版本批准后冲突消除，公开墙展示新内容
    const ok = await adminPost(base, `/api/admin/messages/${id}/approve`, { expected_version: 2 });
    assert.equal(ok.status, 200);
    const ov2 = await adminGet(base, '/api/admin/overview');
    assert.equal(ov2.conflicts.length, 0);
    const w = await wall(base);
    assert.equal(w.body.items[0].content, '修改后的内容');
  } finally { await close(); }
});

// ---------- 3. 修改使原批准失效 ----------
test('留言修改后原批准立即失效：公开墙立刻下架，需重新审核', async () => {
  const { base, close } = await setup();
  try {
    const { id, author_token: token } = await submitAndApprove(base, '已公开的话');
    assert.equal((await wall(base)).body.items.length, 1);
    const edit = await authorPost(base, id, 'edit', token, { base_version: 1, content: '改过的版本', relation: '读者' });
    assert.equal(edit.status, 200);
    assert.equal((await edit.clone?.() ?? edit).status, 200);
    // 公开墙立即不再展示
    assert.equal((await wall(base)).body.items.length, 0);
    // 状态回到待审
    const st = await (await fetch(`${base}/api/messages/${id}/status`, { headers: { 'X-Author-Token': token } })).json();
    assert.equal(st.status, 'pending');
    assert.equal(st.version, 2);
    // 重新批准后展示新内容
    await adminPost(base, `/api/admin/messages/${id}/approve`, { expected_version: 2 });
    assert.equal((await wall(base)).body.items[0].content, '改过的版本');
  } finally { await close(); }
});

// ---------- 4. 撤回 / 申诉 / 重新批准 ----------
test('撤回、申诉、重新批准各有可见状态', async () => {
  const { base, close } = await setup();
  try {
    const { id, author_token: token } = await submitAndApprove(base, '先公开再撤回');
    const statusOf = async () => (await (await fetch(`${base}/api/messages/${id}/status`, { headers: { 'X-Author-Token': token } })).json()).status;

    // 撤回：公开墙消失，状态可见
    assert.equal((await authorPost(base, id, 'withdraw', token)).status, 200);
    assert.equal(await statusOf(), 'withdrawn');
    assert.equal((await wall(base)).body.items.length, 0);

    // 撤回后作者修改 = 重新提交
    await authorPost(base, id, 'edit', token, { base_version: 1, content: '重新提交的内容', relation: '读者' });
    assert.equal(await statusOf(), 'pending');

    // 拒绝 => 申诉 => 重新批准
    await adminPost(base, `/api/admin/messages/${id}/reject`, { expected_version: 2, note: '不太合适' });
    assert.equal(await statusOf(), 'rejected');
    assert.equal((await authorPost(base, id, 'appeal', token, { note: '请再看看' })).status, 200);
    assert.equal(await statusOf(), 'appealed');
    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.appealed.length, 1);
    assert.equal((await adminPost(base, `/api/admin/messages/${id}/reapprove`, { expected_version: 2 })).status, 200);
    assert.equal(await statusOf(), 'approved');
    assert.equal((await wall(base)).body.items[0].content, '重新提交的内容');

    // 事件流完整记录
    const detail = await adminGet(base, `/api/admin/messages/${id}`);
    const actions = detail.events.map((e) => e.action);
    for (const a of ['submit', 'approve', 'withdraw', 'edit', 'reject', 'appeal', 'reapprove']) {
      assert.ok(actions.includes(a), `缺少事件 ${a}：${actions}`);
    }
  } finally { await close(); }
});

// ---------- 5. 撤回后旧分页缓存 ----------
test('撤回后墙版本与 ETag 变化，旧分页缓存失效且撤回内容不再出现', async () => {
  const { base, close } = await setup();
  try {
    const a = await submitAndApprove(base, '留言 A');
    await submitAndApprove(base, '留言 B');
    await submitAndApprove(base, '留言 C');

    const first = await wall(base, '?limit=2');
    assert.equal(first.body.items.length, 2);
    const etagV1 = first.res.headers.get('etag');
    const versionV1 = first.body.wall_version;
    assert.ok(etagV1);

    // 缓存命中：同 ETag => 304
    const cached = await fetch(`${base}/api/wall?limit=2`, { headers: { 'If-None-Match': etagV1 } });
    assert.equal(cached.status, 304);

    // 撤回第一页上的留言
    await authorPost(base, a.id, 'withdraw', a.author_token);

    // 旧 ETag 不再命中：必须重新获取，且撤回内容消失
    const stale = await fetch(`${base}/api/wall?limit=2`, { headers: { 'If-None-Match': etagV1 } });
    assert.equal(stale.status, 200);
    const fresh = await stale.json();
    assert.ok(fresh.wall_version > versionV1);
    assert.ok(!JSON.stringify(fresh).includes('留言 A'));
    // 版本探针同样反映变化（客户端据此丢弃旧分页）
    const probe = await (await fetch(`${base}/api/wall/version`)).json();
    assert.equal(probe.wall_version, fresh.wall_version);
  } finally { await close(); }
});

// ---------- 6. 恶意富文本与链接 ----------
test('恶意富文本与 javascript: 链接被输出转义，无法注入脚本', async () => {
  const { base, close } = await setup();
  try {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    await submitAndApprove(base, evil, 'javascript:alert(3)');

    const page = await (await fetch(`${base}/guestbook`)).text();
    assert.ok(!page.includes(evil), '原始脚本串不得出现在 HTML 中');
    assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '必须以转义文本呈现');
    assert.ok(!page.includes('<img src=x onerror'), '事件处理器不得成为可解析的标签属性');
    assert.ok(page.includes('&lt;img src=x onerror=alert(2)&gt;'), '恶意标记应以转义文本呈现');
    // javascript: 伪协议只作为纯文本出现，页面没有任何自动链接
    assert.ok(!page.includes('href="javascript:'), '不得生成 javascript: 链接');

    const res = await fetch(`${base}/guestbook`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'"), 'CSP 禁止内联脚本');
    assert.ok(csp.includes("object-src 'none'"));

    // JSON API 返回原文（数据层），由渲染侧负责转义
    const w = await wall(base);
    assert.equal(w.body.items[0].content, evil);
  } finally { await close(); }
});

// ---------- 7. 公开 API 不返回邮箱 ----------
test('公开页面与公开 API 均不泄露邮箱', async () => {
  const { base, close } = await setup();
  try {
    const email = 'secret-reader@example.com';
    await submitAndApprove(base, '带邮箱的留言', '读者', { email, notify_opt_in: true });

    const w = await wall(base);
    const raw = JSON.stringify(w.body);
    assert.ok(!raw.includes(email), '公开 API 不得包含邮箱明文');
    assert.ok(!/"email"/.test(raw), '公开 API 不得出现 email 字段');
    assert.ok(!raw.includes('author_token'), '公开 API 不得包含作者凭据');

    const page = await (await fetch(`${base}/guestbook`)).text();
    assert.ok(!page.includes(email), '公开 HTML 不得包含邮箱');

    // 站主详情可以看到受限字段（用于实际通知）
    const detail = await adminGet(base, `/api/admin/messages/${w.body.items[0].id}`);
    assert.equal(detail.contact.email, email);
  } finally { await close(); }
});

// ---------- 8. 清理联系信息 ----------
test('清理联系信息：邮箱被抹除、外发副本取消，留言本身保留', async () => {
  const { base, close } = await setup({ notifyEnabled: true });
  try {
    const email = 'erase-me@example.com';
    const { id, author_token: token } = await submitAndApprove(base, '我会撤回邮箱', '读者', { email, notify_opt_in: true });

    let detail = await adminGet(base, `/api/admin/messages/${id}`);
    assert.equal(detail.contact.email, email);
    assert.equal(detail.outbox.length, 1);
    assert.equal(detail.outbox[0].status, 'queued');

    const res = await authorPost(base, id, 'erase-contact', token);
    assert.equal(res.status, 200);

    detail = await adminGet(base, `/api/admin/messages/${id}`);
    assert.equal(detail.contact.email, null, '邮箱明文必须被抹除');
    assert.ok(detail.contact.erased_at, '应记录抹除时间');
    assert.equal(detail.outbox[0].status, 'canceled', '待发通知应取消');
    assert.equal(detail.outbox[0].email, null, '外发副本中的邮箱必须抹除');
    assert.ok(detail.events.some((e) => e.action === 'contact_erased'));

    // 留言仍公开可见
    assert.equal((await wall(base)).body.items.length, 1);
    // 作者视角 has_contact 变为 false
    const st = await (await fetch(`${base}/api/messages/${id}/status`, { headers: { 'X-Author-Token': token } })).json();
    assert.equal(st.has_contact, false);
  } finally { await close(); }
});

// ---------- 9. 通知：明确选择 + 送达未知 ----------
test('通知由明确选择决定：未启用或未 opt-in 都不外发', async () => {
  const { base, close } = await setup({ notifyEnabled: false });
  try {
    // 全站未启用：即使作者 opt-in 也不生成外发
    const { id } = await submitAndApprove(base, '想收通知', '读者', { email: 'a@b.co', notify_opt_in: true });
    const detail = await adminGet(base, `/api/admin/messages/${id}`);
    assert.equal(detail.outbox.length, 0);
    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.notifications_enabled, false);
  } finally { await close(); }
});

test('通知外发状态只能是「送达未知」，不得把请求成功当作已送达', async () => {
  const { base, close } = await setup({ notifyEnabled: true });
  try {
    // opt-in => 批准后进入外发队列
    const opted = await submitAndApprove(base, '要通知我', '读者', { email: 'optin@example.com', notify_opt_in: true });
    // 未 opt-in => 不外发
    const silent = await submitAndApprove(base, '不用通知', '读者', { email: 'silent@example.com' });

    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.outbox.length, 1);
    const entry = ov.outbox[0];
    assert.equal(entry.status, 'queued');
    assert.ok(!('email' in entry), '外发列表不暴露邮箱明文');

    // 标记一次发送尝试：状态变为 unknown（送达未知），永远不是 delivered
    const attempt = await adminPost(base, `/api/admin/outbox/${entry.id}/attempt`);
    assert.equal(attempt.status, 200);
    const after = await attempt.json();
    assert.equal(after.status, 'unknown');
    assert.notEqual(after.status, 'delivered');

    const detail = await adminGet(base, `/api/admin/messages/${opted.id}`);
    assert.equal(detail.outbox[0].status, 'unknown');
    assert.equal(detail.outbox[0].attempts, 1);
    const silentDetail = await adminGet(base, `/api/admin/messages/${silent.id}`);
    assert.equal(silentDetail.outbox.length, 0);
  } finally { await close(); }
});

// ---------- 10. 空状态 ----------
test('空状态温和呈现：公开墙与后台均有空态文案', async () => {
  const { base, close } = await setup();
  try {
    const page = await (await fetch(`${base}/guestbook`)).text();
    assert.ok(page.includes('这里还很安静'), '公开墙应有空状态文案');
    const ov = await adminGet(base, '/api/admin/overview');
    assert.deepEqual(ov.pending, []);
    assert.deepEqual(ov.conflicts, []);
    assert.deepEqual(ov.outbox, []);
  } finally { await close(); }
});

// ---------- 11. 收件箱模式 ----------
test('收件箱模式：新留言仅站主可见，批准后才公开', async () => {
  const { base, close } = await setup({ mode: 'inbox' });
  try {
    const s = await submit(base, { content: '进收件箱', relation: '读者' });
    assert.equal(s.body.status, 'inbox');
    assert.equal((await wall(base)).body.items.length, 0, '收件箱内容不得公开');
    const ov = await adminGet(base, '/api/admin/overview');
    assert.equal(ov.inbox.length, 1);
    assert.equal(ov.pending.length, 0);
    await adminPost(base, `/api/admin/messages/${s.body.id}/approve`, { expected_version: 1 });
    assert.equal((await wall(base)).body.items.length, 1);
  } finally { await close(); }
});

// ---------- 12. 作者接口鉴权与校验 ----------
test('作者接口需要凭据；非法输入被拒绝', async () => {
  const { base, close } = await setup();
  try {
    const s = await submit(base, { content: '鉴权测试', relation: '读者' });
    const { id } = s.body;
    // 无凭据
    assert.equal((await fetch(`${base}/api/messages/${id}/status`)).status, 403);
    assert.equal((await authorPost(base, id, 'withdraw', 'wrong-token')).status, 403);
    // 非法输入
    assert.equal((await submit(base, { content: '', relation: '读者' })).res.status, 422);
    assert.equal((await submit(base, { content: 'x'.repeat(1001), relation: '读者' })).res.status, 422);
    assert.equal((await submit(base, { content: 'ok', relation: '读者', email: 'not-an-email' })).res.status, 422);
    // 勾选通知但不填邮箱
    const noEmail = await submit(base, { content: 'ok', relation: '读者', notify_opt_in: true });
    assert.equal(noEmail.res.status, 422);
    // 站主接口鉴权
    assert.equal((await fetch(`${base}/api/admin/overview`)).status, 401);
  } finally { await close(); }
});
