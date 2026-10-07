'use strict';
/**
 * 启动入口。
 * 环境变量：
 *   PORT            监听端口（默认 3000）
 *   DB_PATH         持久化文件（默认 data/wall.json；':memory:' 不落地）
 *   WALL_MODE       'premoderation'（先审后发，默认）| 'inbox'（私密收件箱）
 *   ADMIN_TOKEN     站主令牌（生产必须设置，默认 dev-admin-token 仅供本地）
 *   NOTIFY_ENABLED  '1' 才启用邮件通知外发队列（默认关闭 —— 明确选择才启用）
 *   SITE_SALT       邮箱哈希盐（仅用于联系信息查找）
 */
const path = require('node:path');
const { createApp } = require('./app.js');

const adminToken = process.env.ADMIN_TOKEN || 'dev-admin-token';
if (adminToken === 'dev-admin-token') {
  console.warn('[warn] 正在使用默认 ADMIN_TOKEN，仅限本地开发；生产环境请通过环境变量设置强随机令牌。');
}

const { server } = createApp({
  rootDir: path.join(__dirname, '..'),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'wall.json'),
  mode: process.env.WALL_MODE || 'premoderation',
  adminToken,
  notifyEnabled: process.env.NOTIFY_ENABLED === '1',
  siteSalt: process.env.SITE_SALT || 'dev-site-salt',
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`留言墙已启动: http://localhost:${port}/guestbook （模式: ${process.env.WALL_MODE || 'premoderation'}）`);
  console.log(`站主后台: http://localhost:${port}/admin.html`);
});
