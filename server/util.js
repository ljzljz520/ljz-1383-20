'use strict';
/**
 * 通用工具：标识生成、哈希、HTML 转义、提交校验。
 * 安全约定：内容一律「原文存储、输出时转义」，本模块提供唯一转义入口。
 */
const crypto = require('node:crypto');

const now = () => new Date().toISOString();

/** 消息 ID：随机、不可枚举、不携带任何个人信息 */
function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** 作者凭据（capability token）：仅提交时返回一次，服务端只存哈希 */
function randomToken() {
  return `atk_${crypto.randomBytes(24).toString('hex')}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** 常量时间比较，避免令牌时序侧信道 */
function tokenEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 输出转义：所有进入 HTML 的动态文本必须经过它（或客户端 textContent） */
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function isValidEmail(email) {
  const e = String(email).trim();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

const LIMITS = { content: 1000, relation: 100, note: 500 };

/**
 * 校验留言提交/编辑载荷。
 * 返回规范化后的字段；email 为空串/缺省 => null（表示未提供）。
 */
function validateSubmission(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const content = typeof b.content === 'string' ? b.content.trim() : '';
  const relation = typeof b.relation === 'string' ? b.relation.trim() : '';
  if (content.length < 1 || content.length > LIMITS.content) {
    errors.push(`寄语长度须为 1~${LIMITS.content} 字`);
  }
  if (relation.length < 1 || relation.length > LIMITS.relation) {
    errors.push(`关系说明长度须为 1~${LIMITS.relation} 字`);
  }
  let email = null;
  if (b.email !== undefined && b.email !== null && String(b.email).trim() !== '') {
    if (!isValidEmail(b.email)) errors.push('邮箱格式不正确');
    else email = normalizeEmail(b.email);
  }
  return { ok: errors.length === 0, errors, content, relation, email };
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  now, randomId, randomToken, sha256, tokenEqual,
  escapeHtml, normalizeEmail, isValidEmail,
  validateSubmission, clampInt, LIMITS,
};
