# 个人创意主页 - 技术说明文档

本项目是一个现代化的个人主页系统，采用 3 级页面架构，旨在展示个人的技术见解、兴趣爱好及专业作品。

## 项目特点

1.  **现代化视觉设计**：采用流行的 "Glassmorphism" (毛玻璃) 风格，结合动态渐变背景和丝滑的微动画，提供极佳的视觉体验。
2.  **3 级导航结构**：
    *   **Level 1**: 首页 (`index.html`) - 整体概览。
    *   **Level 2**: 列表页 (`hobbies.html`, `portfolio.html`, `contact.html`) - 分类展示。
    *   **Level 3**: 详情页 (`hobby-detail.html`, `work-detail.html`) - 深度内容。
3.  **自定义交互系统**：弃用原生 `alert`，开发了基于 Vanilla JS 的 Toast 通知系统，用于表单验证反馈和交互提示。
4.  **纯净技术栈**：仅使用 HTML5, CSS3 和原生 JavaScript，无需任何外部框架。

## 文件结构

- `index.html`: 入口首页
- `hobbies.html`: 兴趣爱好列表 (L2)
- `hobby-detail.html`: 摄影兴趣详情 (L3)
- `portfolio.html`: 作品集列表 (L2)
- `work-detail.html`: Neo-Finance 应用案例 (L3)
- `contact.html`: 联系表单页 (L2)
- `css/style.css`: 全局样式表
- `js/main.js`: 交互逻辑与表单验证
- `images/`: 项目多媒体资源

## 技术要点

- **CSS 选择器**：广泛使用伪类 (`:hover`, `:focus`), 子选择器及复杂层叠关系。
- **盒模型布局**：利用 Flexbox 和 CSS Grid 实现响应式布局。
- **表单验证**：实时检测用户输入，并通过自定义 UI 组件进行错误提示。

---

# 访客留言审核墙（v1.1 新增）

在静态主页之上叠加了一个**零依赖 Node 后端**（仅使用 Node ≥18 内置模块），实现带完整审核生命周期的访客留言墙。

## 运行

```bash
npm start                 # 默认 :3000，先审后发模式
WALL_MODE=inbox npm start # 私密收件箱模式
npm test                  # 15 个验收测试（内存存储 + 随机端口，无副作用）
```

环境变量：`PORT`、`DB_PATH`（默认 `data/wall.json`，`:memory:` 不落地）、`WALL_MODE`、`ADMIN_TOKEN`（生产必改）、`NOTIFY_ENABLED`（`=1` 才启用通知）、`SITE_SALT`。

页面：公开墙 `/guestbook`（已并入全站导航），站主后台 `/admin.html`。

## 两种流程比较：先审后发 vs 私密收件箱

| 维度 | 先审后发（premoderation） | 私密收件箱（inbox） |
|---|---|---|
| 提交后状态 | `pending`（进入审核队列） | `inbox`（仅站主可见的私信） |
| 作者预期 | 「默认要公开，除非被拒」 | 「默认是私信，公开是站主的主动选择」 |
| 公开路径 | 批准 → 写入批准快照 | 批准（=发布）→ 写入批准快照 |
| 适用场景 | 公开留言墙、祝福墙 | 联系表单升级、反馈信箱兼精选展示 |
| 误公开风险 | 队列即公开候选，审核疏忽即外泄 | 多一道「发布」语义，默认不公开更安全 |
| 通知时机 | 批准时（若启用且 opt-in） | 发布时（同上） |

两种模式共用同一套版本、事件、快照与通知机制，仅初始状态与语义不同，由 `WALL_MODE` 切换。

## 核心设计

**数据模型（追加式 + 快照）**
- `versions`：留言的每一次提交版本，不可变追加；
- `events`：提交/修改/批准/拒绝/撤回/申诉/重新批准/冲突/通知等全部事件；
- `snapshots`：批准快照 —— **公开页唯一数据源**。修改或撤回即删除快照，公开页立即下架；
- `contacts`：**隔离受限字段**，邮箱明文仅存于此（及外发队列的发送副本），仅站主详情接口可读；`email_hash` 只用于联系信息查找，**不作为身份依据**。

**有界幂等身份（匿名重试安全）**
- 客户端为**每一份草稿**生成随机 `Idempotency-Key`（提交成功后才换新的）；
- 服务端强制该头（缺失 400），键 → 结果映射保存 24h（有界），重试返回原结果并带 `Idempotent-Replay: true`；
- 键与邮箱/身份无关：同一人的多条不同留言是不同草稿、不同键，**绝不误合并**（有测试保障）。

**审核与编辑竞争：版本条件**
- 作者修改需带 `base_version`，站主审核需带 `expected_version`；
- 审核期间内容被修改 → 409 `version_conflict`，留言被标记冲突并在后台「待处理冲突」醒目呈现，站主基于最新版本重新决定；
- 留言一旦被修改，原批准立即失效（快照删除、回到待审/收件箱）。

**状态机（各有可见状态）**
`pending/inbox → approved/rejected`，`rejected → appealed → (reapprove|reject)`，任意状态 `→ withdrawn`（作者撤回，公开即时消失），撤回后修改 = 重新提交。作者凭提交时下发的作者凭据（服务端只存哈希）在「我的留言」中查看状态、修改、撤回、申诉、清理联系方式。

**输出转义与注入防护**
- 内容原文存储，SSR 一律 `escapeHtml`，客户端追加渲染只用 `textContent`；不做任何自动链接，`javascript:` 伪协议只能是惰性文本；
- 留言墙/后台/API 响应带严格 CSP（`script-src 'self'` 等），即使转义失效也无内联脚本可执行。

**通知：明确选择 + 送达未知**
- 双重明确选择：全站 `NOTIFY_ENABLED=1` **且**作者逐条勾选 `notify_opt_in`（勾选必须填邮箱）；
- 只存邮箱哈希无法发信，故实际通知依赖受限字段中的明文；「清理联系信息」会抹除明文并取消待发副本；
- 外发队列状态只有 `queued / unknown / canceled`：标记发送尝试后变为 **unknown（送达未知）**——没有投递回执，**请求成功 ≠ 已送达**，后台如实呈现。

**分页缓存一致性**
- 公开墙使用游标分页 + 单调递增 `wall_version` + ETag（`Cache-Control: no-cache`）；
- 撤回/新增/修改会使版本号变化：客户端轮询版本探针或在「加载更多」时校验版本，不一致即丢弃旧分页缓存整页刷新（含 bfcache 拦截）。

## API 摘要

| 方法/路径 | 说明 |
|---|---|
| `POST /api/messages` | 提交（需 `Idempotency-Key`）→ `{id, author_token, status, version}` |
| `GET /api/messages/:id/status` | 作者查看自己的状态（`X-Author-Token`） |
| `POST /api/messages/:id/edit` | 修改（`base_version` 条件；原批准失效） |
| `POST /api/messages/:id/withdraw` `/appeal` `/erase-contact` | 撤回 / 申诉 / 清理联系信息 |
| `GET /api/wall?cursor&limit` | 批准快照分页（白名单字段，绝无邮箱） |
| `GET /api/wall/version` | 墙版本探针 |
| `GET /api/admin/overview` | 待审/收件箱/申诉/**冲突**/已公开/外发队列 |
| `GET /api/admin/messages/:id` | 详情（版本、事件、受限邮箱字段） |
| `POST /api/admin/messages/:id/{approve,reject,reapprove}` | 审核（`expected_version` 条件） |
| `POST /api/admin/outbox/:id/attempt` | 标记发送尝试 → `unknown` |

## 验收测试（`npm test`，15 例）

重复提交幂等 / 同邮箱不合并 / 缺幂等键拒绝 / 审核时内容变化（409+冲突可见）/ 修改使批准失效 / 撤回·申诉·重新批准状态流转与事件完整性 / 撤回后旧分页缓存失效（ETag+版本探针）/ 恶意富文本与 `javascript:` 链接转义 + CSP / 公开 API 与页面不含邮箱 / 清理联系信息（含外发副本抹除）/ 通知未启用不外发 / 送达未知语义 / 空状态 / 收件箱模式 / 作者接口鉴权与输入校验。
