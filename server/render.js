'use strict';
/**
 * 公开留言墙的服务端渲染。
 * 不变量：公开页只读取「批准快照」；所有动态文本经 escapeHtml 输出转义，
 * 客户端追加渲染只使用 textContent —— 恶意富文本/链接只能以纯文本形式出现。
 */
const { escapeHtml } = require('./util.js');

function renderSnapshotCard(it) {
  return `        <article class="wall-card glass">
          <p class="wall-content">${escapeHtml(it.content)}</p>
          <footer class="wall-meta">
            <span class="wall-relation">${escapeHtml(it.relation)}</span>
            <time datetime="${escapeHtml(it.approved_at)}">${escapeHtml(it.approved_at.slice(0, 10))}</time>
          </footer>
        </article>`;
}

/**
 * @param {object} p
 * @param {Array}  p.items       批准快照（已按分页截断）
 * @param {object|null} p.nextCursor
 * @param {number} p.wallVersion 墙版本号：客户端据此丢弃过期分页缓存
 * @param {string} p.mode        'premoderation' | 'inbox'
 * @param {boolean} p.notifyEnabled 全站通知开关（决定是否在表单展示通知选项）
 */
function renderGuestbookPage({ items, nextCursor, wallVersion, mode, notifyEnabled }) {
  const cards = items.map(renderSnapshotCard).join('\n');
  const emptyState = `        <p class="wall-empty glass" id="wall-empty">这里还很安静，像清晨未醒的花园。<br>欢迎写下第一条寄语 🌱</p>`;
  const cursorAttr = nextCursor
    ? escapeHtml(Buffer.from(JSON.stringify(nextCursor)).toString('base64url'))
    : '';
  const modeHint = mode === 'inbox'
    ? '提交的留言会先进入站主的私密收件箱，仅站主可见；站主选择发布后才会公开展示。'
    : '提交的留言需经站主审核通过后才会公开展示。';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="wall-version" content="${Number(wallVersion)}">
    <title>访客留言墙 | 灵墨创意</title>
    <link rel="stylesheet" href="css/style.css">
    <link rel="stylesheet" href="css/guestbook.css">
    <script src="js/guestbook.js" defer></script>
</head>
<body>
    <header>
        <div class="container">
            <nav>
                <a href="index.html" class="logo">灵墨创意</a>
                <ul class="nav-links">
                    <li><a href="index.html">首页</a></li>
                    <li><a href="hobbies.html">兴趣爱好</a></li>
                    <li><a href="portfolio.html">个人作品</a></li>
                    <li><a href="contact.html">联系我</a></li>
                    <li><a href="guestbook.html" class="active">留言墙</a></li>
                </ul>
            </nav>
        </div>
    </header>

    <main class="wall-main container">
        <section class="wall-hero">
            <h1>访客留言墙</h1>
            <p class="wall-hint">${escapeHtml(modeHint)}</p>
        </section>

        <section id="wall-list" class="wall-list" data-next-cursor="${cursorAttr}" aria-live="polite">
${items.length ? cards : emptyState}
        </section>
        <div class="wall-more">
            <button id="load-more" type="button" class="btn btn-outline"${nextCursor ? '' : ' hidden'}>加载更多</button>
        </div>

        <section class="wall-submit glass" id="submit-section">
            <h2 id="form-title">写下你的寄语</h2>
            <form id="submit-form" novalidate>
                <div class="form-group">
                    <label for="f-content">寄语 <span class="req">*</span>（1000 字以内）</label>
                    <textarea id="f-content" name="content" class="form-control" maxlength="1000" required></textarea>
                </div>
                <div class="form-group">
                    <label for="f-relation">你与这里的关系 <span class="req">*</span>（100 字以内，如「老同学」「读者」）</label>
                    <input id="f-relation" name="relation" class="form-control" maxlength="100" required>
                </div>
                <div class="form-group">
                    <label for="f-email">邮箱（可选，仅用于必要的通知，绝不会公开）</label>
                    <input id="f-email" name="email" type="email" class="form-control" maxlength="254">
                </div>
                ${notifyEnabled ? `<div class="form-group form-check">
                    <label><input type="checkbox" id="f-notify" name="notify_opt_in"> 审核结果通过邮件通知我（需填写邮箱；邮件送达无法保证）</label>
                </div>` : ''}
                <p class="edit-hint" id="edit-hint" hidden>正在修改已提交的留言：邮箱留空表示保持不变；修改后需重新审核，原公开状态立即失效。</p>
                <button type="submit" class="btn btn-primary" id="submit-btn">提交留言</button>
                <button type="button" class="btn btn-outline" id="cancel-edit" hidden>取消修改</button>
                <p class="form-status" id="form-status" role="status"></p>
            </form>
        </section>

        <section class="wall-mine glass" id="mine-section">
            <h2>我的留言</h2>
            <p class="wall-empty-small" id="mine-empty">这个浏览器还没有提交记录。提交后，你可以在这里查看状态、修改、撤回或申诉。</p>
            <ul id="mine-list" class="mine-list"></ul>
        </section>
    </main>

    <footer>
        <div class="container">
            <div class="footer-bottom">
                <p>&copy; 2024 林墨的个人主页. All Rights Reserved.</p>
            </div>
        </div>
    </footer>
    <div id="toast-container"></div>
</body>
</html>`;
}

module.exports = { renderGuestbookPage };
