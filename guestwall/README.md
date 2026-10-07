# 访客留言审核墙（GuestWall）

零外部依赖的全栈实现：Python 标准库 HTTP 服务 + SQLite 持久化 + 原生前端。
网页收集**寄语、关系说明、可选邮箱**；后台校验后持久存储**提交版本**与**审核事件**；
公开页只读取**批准快照**。

## 运行

```bash
cd guestwall
OWNER_TOKEN=请改成强随机值 python3 run.py --port 8000
# 打开 http://127.0.0.1:8000/        公开墙 + 提交表单
# 打开 http://127.0.0.1:8000/status  访客管理自己的留言（修改/撤回/申诉/清除联系信息）
# 打开 http://127.0.0.1:8000/owner   站主后台（输入 OWNER_TOKEN）
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OWNER_TOKEN` | `dev-owner-token` | 站主令牌（生产必须修改） |
| `WALL_MODE` | `pre_moderation` | `pre_moderation` 先审后发 / `inbox` 站主收件箱 |
| `WALL_SMTP_URL` | 未设置 | 配置后通知进入“已交渠道、送达未知（无回执）” |

## 验收测试

```bash
python3 tests/acceptance.py   # 55 项断言，全部通过时退出码为 0
```

覆盖：重复提交（有界幂等）、审核时内容变化（版本条件 409）、撤回后旧分页缓存
（游标不复活 + list_version/ETag 变化）、恶意链接与富文本（转义 + CSP）、
清理联系信息请求、公开 API 不返回邮箱、通知送达未知、申诉与重新批准、
空状态、鉴权、收件箱模式。

## 数据模型

| 表 | 作用 |
|---|---|
| `submissions` | 提交主体：状态、当前版本号、通知选择、联系信息标志位 |
| `versions` | 每次提交/修改产生一个不可变版本（审核针对具体版本） |
| `events` | 审核事件流：submit/edit/approve/reject/reapprove/appeal/withdraw/contact_cleanup/approve_conflict |
| `snapshots` | **批准快照，公开页唯一数据源**；修改/撤回/拒绝即删除 |
| `idempotency_keys` | 有界幂等身份：一键绑定一条提交，存请求哈希与首个响应，7 天 TTL |
| `contacts` | **隔离受限字段**：明文邮箱独立存放，仅通知子系统读取 |
| `notifications` | 通知记录：状态只表达可确认的程度，永不声称“已送达” |
| `meta` | `list_version`：快照变更计数器，供缓存校验 |

## 状态机

```
            submit                submit (inbox 模式)
              │                       │
           pending                 inbox            ← 仅站主可见
              │                       │
        owner approve ────────────────┘
              │
           approved ──guest edit──► pending（原批准失效，快照移除）
              │                        ▲
        owner reject                   │ owner approve（版本条件）
              ▼                        │
           rejected ──guest appeal──► appealed ──owner reapprove──► approved
              │
        guest withdraw（任意非撤回状态）──► withdrawn（快照移除，终态）
```

- **审核与编辑竞争**：`approve/reject` 必须携带 `expected_version`；
  与当前版本不一致返回 `409 VERSION_CONFLICT` 并记录 `approve_conflict` 事件，
  站主队列以 `has_conflict` 标记“审核后内容已变化”。
- **修改后原批准失效**：编辑即删快照、版本号 +1、状态回到待审。
- **撤回、申诉、重新批准各有可见状态**：访客时间线与站主分组均可见。

## 两种审核流程比较

| | 先审后发（`pre_moderation`） | 站主收件箱（`inbox`） |
|---|---|---|
| 初始状态 | `pending` 待审核 | `inbox` 仅站主可见 |
| 公开路径 | 批准 → 快照 → 公开 | 从收件箱“公开”→ 快照 → 公开 |
| 访客预期 | “提交后等审核”语义明确 | “先投递给站主，站主挑选后公开” |
| 站主负担 | 队列即待办，积压可见 | 收件箱可长期囤积，无“待办”压力 |
| 适用 | 公开墙是主场景，内容默认应公开 | 更私密：留言首先是给站主的信 |
| 共同点 | 公开前都必须经过批准动作；公开页都只读快照；版本条件、撤回、申诉、通知机制完全一致 |

两种模式共用同一套机制，仅初始状态与站主界面文案不同（`WALL_MODE` 切换）。

## 关键设计

### 有界幂等身份（匿名重试安全）
- 每份草稿生成一个随机幂等键（`sessionStorage`，网络重试复用，成功后销毁）。
- 服务端唯一约束：同键同载荷 → 原样返回首个响应（含管理令牌，重试可恢复）；
  同键不同载荷 → `409 IDEMPOTENCY_KEY_CONFLICT`；键 7 天过期清理。
- **不以邮箱哈希做幂等**：同一人的多条不同留言各自独立，绝不误合并；
  邮箱哈希仅作“是否留有联系方式”的标志位。

### 公开读模型与缓存
- 公开页与公开 API 只读 `snapshots`；撤回/修改/拒绝即时删除快照。
- **游标分页**（`approved_at|public_id`）：删除不会导致偏移错位，旧游标不会复活已撤回内容。
- `list_version` 单调递增并进入 ETag；响应 `Cache-Control: no-cache`，
  缓存必须回源校验，撤回后旧分页缓存不会继续展示。

### 输出转义与注入防护
- 服务端渲染公开墙时对所有用户内容 `html.escape`；不做 URL 自动链接，
  恶意链接只是纯文本。
- 前端只使用 `textContent` 渲染 API 数据（无 `innerHTML`）。
- 全站 CSP：`script-src 'self'` 等，注入的内联脚本无法执行。

### 邮箱隔离与通知
- 明文邮箱只存 `contacts` 表，且**仅在作者明确勾选通知时**保存；
  未勾选只留哈希——**仅哈希无法发送邮件**。
- 任何 HTTP 响应都不含明文邮箱：公开 API 无 email 字段，站主 API 仅返回脱敏形式。
- 清理联系信息请求：删除明文与哈希、关闭通知、记录事件；后续通知降级为
  `skipped_no_contact`。
- 通知状态机：`channel_not_configured` / `sent_unconfirmed` / `skipped_opt_out` /
  `skipped_no_contact`——**送达状态始终未知，不将请求成功等同于已展示/已送达**。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/submissions` | 提交（`idempotency_key` 必填；返回一次性管理令牌） |
| GET | `/api/submissions/{id}` | 访客查看状态/版本/事件（Bearer 管理令牌） |
| POST | `/api/submissions/{id}/edits` | 修改（新版本；已批准则原批准失效） |
| POST | `/api/submissions/{id}/withdraw` | 撤回（幂等） |
| POST | `/api/submissions/{id}/appeal` | 申诉（仅未通过状态） |
| POST | `/api/submissions/{id}/contact-cleanup` | 清除联系信息 |
| GET | `/api/public/messages?cursor&limit` | 公开列表（游标分页，无邮箱） |
| GET | `/api/owner/queue` | 站主队列（含冲突标记、脱敏联系信息） |
| GET | `/api/owner/submissions/{id}` | 站主查看版本与事件 |
| POST | `/api/owner/submissions/{id}/approve` | 批准（`expected_version` 必填） |
| POST | `/api/owner/submissions/{id}/reject` | 不通过（`expected_version` 必填） |
| GET | `/api/owner/notifications` | 通知记录（送达状态未知语义） |

## 已知限制

- 单进程 + SQLite 串行写，适合小站；高并发需换客户端-服务器数据库。
- 管理令牌保存在访客浏览器 localStorage，丢失即失去管理能力（匿名设计的取舍）。
- 通知派发为存根：配置 `WALL_SMTP_URL` 后需自行接入真实 SMTP；无回执时状态只能是“送达未知”。
