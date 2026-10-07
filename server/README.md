# 新员工仿真培训系统 · 服务端

零依赖 Node 服务层：**账号登录鉴权 + 按角色数据范围隔离 + 任务下发闭环 + 带教辅导与对话质检（含逐轮对话复盘）+ 真实大模型双角色评分 + SQLite 落库 + 场景治理 + 操作审计 + 金标集校准 + 一键备份**。

前端三端（学员端 / 管理后台 / 教练台）在**没有本服务时依然可以离线运行**（走本地关键词引擎与浏览器存储）；
启动本服务后自动切换为「真实模型评分 + 服务端落库 + 按角色强制校验」，无需改动任何页面代码。

---

## 一、启动（30 秒）

```bash
# 方式一：脚本（推荐）
./start-server.sh            # macOS / Linux / Git Bash
start-server.bat             # Windows 双击

# 方式二：命令
node server/index.js         # 等价于 npm start
```

**然后请从服务地址打开页面**（`http://127.0.0.1:8848/管理后台-仿真培训.html`）——这样天然同源，无跨域问题。

> 也可以用 `file://` 双击打开，或起个静态服务（`python -m http.server 8791`）；
> 前端会自动依次尝试「同源 → http://127.0.0.1:8848」两个基址，探到哪个用哪个，无需手带参数。
> 也可以用 `?api=http://10.0.0.7:8848/api/v1` 显式指定局域网地址。

启动后访问 <http://127.0.0.1:8848/api/v1/status> 应返回 `{"ok":true,...}`。
学员端右下角会出现角标：`● AI 评分已启用` / `● 服务已连接（降级模式）` / `● 离线模式（本地评分）`。

**无需 `npm install`**——本服务只用 Node 22+ 内置模块：`node:sqlite`、`node:http`、原生 `fetch`、`node:crypto`。
仓库里的 `package.json` 只声明了 scripts，`dependencies` 是空的。

### 一条命令验证全链路（152 项断言）

```bash
node server/index.js &            # 自测需要一个已在跑的实例（默认 8848，可用 PORT 改）
node server/tools/selftest.js     # 或 npm run test:server
```

覆盖：**落盘级别（journal_mode / synchronous 真值，防止被改回出厂 FULL 而"只剩性能坏掉"）** /
登录 / token 篡改 / 越权 403 / 提交人≠审核人 / 版本与回滚 / 练习通道匿名可用 /
**任务下发与进度闭环** / **按角色数据范围隔离** / **教练辅导记录与对话质检（含越权与范围外被拒）** /
**学员端「已发布场景池」匿名可读、只含已发布、不泄漏治理字段** /
**逐轮对话（查得到、形状统一、逐轮均分与成绩单口径精确一致、越范围 403）** /
金标校准 / 备份 / CORS 白名单 /
**enforce 模式（会另起一个进程实测无 token 一律 401）**。
它只在服务端新建一个临时场景、一条临时任务与两条临时成绩，结束时逐项删除 ——
**开跑前还会先清扫上一次中断留下的残渣**（清理段在结尾，中途抛错就永远跑不到），
所以反复跑不会把演示数据越跑越脏。唯一会增长的是 `audit_log`（审计按设计只追加）
与 `server/store/backup/` 下的快照（每跑一次留一份，按保留策略自动只留最近 20 份，且已 gitignore）。

### 没有浏览器也能验前端（185 项断言）

```bash
node server/tools/frontend-test.js    # 或 npm run test:frontend
```

十个层次（①②②b③③b③c③d③e④⑤）：① 五个页面的内联脚本与共享脚本**语法可解析**；
② **按需水合语义**（原地替换后 `overview()/statsOf()` 的口径正确、空数组被接受、
`null` 保留本地数据）；②b **场景池合并语义**（`mergeScenes` 必须「按 id 原地更新 + 追加」，
且**不重排、不删除、不换数组与元素引用** —— 学员端 `cur` 是下标、`SCENES[cur]` 到处实时求值，
换了引用就会「练着练着场景变了」且**不报错**）；
③ 在 Node `vm` 沙箱里用真实 `assets/admin-server-sync.js` 打**真接口往返**（登录/场景/任务/记录）；
③b **教练端往返**（辅导记录增删、质检写入/撤销、范围外 403、空内容 400）；
③c **学员端场景池往返**（`AIBOOT.scenes()` 匿名取回 → 合并进场景库；后端不可达时必须**返回 null
而不是抛错**）；③d **逐轮对话往返**（`SYNC.turns()` 范围内容 200、越范围/不存在/空 id 一律
**静默返回 null**、逐轮字段集完整、每轮同时有客户台词与学员作答）；
③e **逐轮卡片渲染器**：把 `esc / scriptTurns / turnDimLine / roundsHtml` 的**真实源码**抠进沙箱，
配真实场景 + 真实逐轮数据跑一遍 —— 断言落点是**渲染结果里逐字出现学员的每一句作答**
（正则只能证明"函数存在"，证明不了"它把学员的话渲染出来了"），且"有真实作答时参考表达默认收起"；
④ 47 条「接线」断言（页面确实调了同步层与 AI 适配层的新方法，且这些方法
**真的在导出块里存在** —— 只写方法名字符串，拼错了语法检查查不出来）；
⑤ **把学员端整页脚本放进沙箱真跑一遍**：运营新建 → 提交 → 审核通过一个场景，然后断言
它**真的出现在学员端的会话列表 HTML 里**（这是「发布 → 学员练」的最后一跳）。
它同样需要一个在跑的服务端，并会在结束时把临时场景下线 + 删除。

> 本机环境的 Chrome / Edge 完全不可用（连 `--version` 都无输出，沙箱内外皆然），
> 所以前端验证不走无头浏览器，改为上面的 Node 沙箱方案 —— 见 `server/tools/frontend-test.js` 顶部说明。
> 第 ⑤ 层用一组最小元素桩替代真实 DOM（页面只用到 `getElementById / createElement /
> classList / dataset / innerHTML`），因此**它验证的是逻辑与渲染路径，不验证布局与观感**。

> 首次启动会自动播种：3 个场景 / 12 名学员 / 5 个任务 / 28 条成绩 / 7 个用户 / 10 条金标样本 /
> **2 条演示辅导记录 + 3 条演示质检结论 + 28 条成绩的逐轮对话（共 164 轮）**，
> 并**自动创建账号与初始口令（启动日志里会打印一份）**。
> 老库升级到 P5 时会**补一次**演示辅导内容（只在两张表都为空时补，避免覆盖运维已维护的数据）；
> 升级到 P7 时会**补一次**逐轮对话（只补 `source='seed'` 且 evidence 为空的成绩 ——
> 真实练习产生的成绩 `source` 是 `llm`/`local`，一行都不会被改写）。

### 想先看效果但还没有 API Key？

```bash
start-mock-demo.bat          # Windows：先起 mock 模型再起后端
npm run mock                 # 或手动：node server/mock-llm.js 8999
```

内置 mock 模型有真实区分度（能算出 Pearson），可把整条链路跑通，见第三节。

---

## 二、登录与鉴权（P3 新增）

### 初始账号

首次启动时若用户还没有口令，服务会自动生成并打印：

| 账号 | 初始口令 | 角色 | 权限 | 数据可见范围 |
|---|---|---|---|---|
| `admin` | `admin123` | 系统管理员 | 编辑 + 审核 | 全部数据 |
| `wangqian` | `op123456` | 培训运营（培训运营组） | 编辑 | 全部数据 |
| `limeng` | `op123456` | 培训运营（连锁渠道事业部） | 编辑 | 本部门数据 |
| `zhangtao` | `rev123456` | 带教主管 | 审核 | 全部数据 |
| `chenxi` | `coach123` | 区域教练（华东大区） | 只读 | 本部门数据 |
| `zhoumin` | `coach123` | 区域教练（连锁渠道事业部） | 只读 | 本人带教（周敏名下学员） |
| `zhaolei` | `coach123` | 区域教练（华东大区） | 只读 | 本人带教（赵磊名下学员） |

> 口令用 `scrypt` 加盐哈希存库，**服务端不保存明文**；登录后可用 `POST /auth/password` 修改。
> 生产环境请登录后立即改密，或把账号接到企业统一身份（替换 `server/auth.js` 即可，接口不变）。

> ⚠️ `users.name` 是**带前缀的展示名**（如「区域教练 · 周敏」），永远匹配不上
> `learners.coach`（那里存的是干净姓名「周敏」）。所以 P5 起 `users` 多了一列
> `staff_name`（干净姓名），登录响应里叫 `staffName`，**教练台用它来筛「我带的学员」**。
> 老库由 `migrateP5()` 自动回填，规则是取展示名「 · 」之后的片段。

### 数据可见范围（`data_scope`，P4 新增）

权限（能不能改）与可见范围（能看谁）是两件事：教练不该看到全公司学员。每个账号带一个
`data_scope`，`/learners`、`/records`、`/tasks`、`/audit` 一律按它过滤，**服务端过滤，不依赖前端自觉**。

| `data_scope` | 含义 | 匹配依据 |
|---|---|---|
| `all` | 全部数据 | 不过滤 |
| `dept` | 本部门数据 | `learners.dept == users.dept` |
| `mentor` | 本人带教 | `learners.coach == users.scope_ref`（存导师姓名，如 `周敏`） |

- 未识别取值 **fail-closed**（看不到任何人），不会因为写错范围而放开全量。
- 匹配走的是**学员 id 集合**（进程内 5 秒缓存），所以列表与详情口径必然一致。
- 想让某个教练只带自己名下学员，把 `users.data_scope='mentor'`、`users.scope_ref='其姓名'` 即可；
  注意**姓名用 `scope_ref` 而不是 `users.name`** —— `users.name` 是「区域教练 · 周敏」这种带前缀的展示名，永远匹配不上。
- ⚠️ 老库升级时 `learners.coach` 曾被写成空（`app-data.js` 里字段叫 `mentor`，播种脚本读的是 `coach`），
  `migrateTasksP4()` 已自动从 `payload.mentor` 回填；若手工改过数据发现 mentor 范围查不到人，先查这一列。

### 两种模式

| `AUTH_MODE` | 行为 | 适用 |
|---|---|---|
| `open`（默认） | 带 token 时按 token 身份**严格校验**；不带 token 时回落为演示身份（方便本地演示 / 内部脚本） | 本地演示、内部试用 |
| `enforce` | **所有管理类接口必须带有效 token**，否则 `401`；浏览器的 `/status`、`/auth/login` 仍公开 | 生产 / 试点上线 |

```bash
AUTH_MODE=enforce node server/index.js       # 强制登录
```

接口按三档要求身份：

| 档位 | 接口 | 说明 |
|---|---|---|
| `public` | `/status`、`/ai/status`、`/rubric`、`/auth/login` | 无需身份 |
| `practice` | `/session/:id/turn`、`/session/:id/finish`、**`GET /scenes/published`** | 允许匿名 —— 学员端必须「没登录也能练」 |
| `staff` | 场景 CRUD、审批、审计、记录、金标、备份、账号 | 需要身份；`enforce` 下必须有 token |

token 是 **HMAC-SHA256 签名的无状态令牌**（`base64url(payload).signature`），默认有效期 12 小时
（`AUTH_TTL_HOURS`）。签名密钥首次启动生成并写入库的 meta 表，因此**重启服务不会踢掉在线用户**。

---

## 三、接入真实大模型

支持任何 **OpenAI 兼容** 接口（DeepSeek / 通义千问 / 智谱 / OpenAI 等）。

### 方式 A：环境变量（推荐用于部署）

```bash
# Windows PowerShell
$env:LLM_API_KEY="sk-你的Key"
$env:LLM_BASE_URL="https://api.deepseek.com/v1"
$env:LLM_MODEL="deepseek-chat"
node server/index.js
```

### 方式 B：本地配置文件（推荐用于开发）

在 `server/.env.json` 写入（该文件已在 `.gitignore` 中，不会入库）：

```json
{
  "PORT": 8848,
  "LLM_API_KEY": "sk-你的Key",
  "LLM_BASE_URL": "https://api.deepseek.com/v1",
  "LLM_MODEL": "deepseek-chat",
  "LLM_TIMEOUT_MS": 30000
}
```

未配置 Key 时服务仍可运行，评分自动降级为**关键词引擎 + 剧本兜底**，返回体 `source` 字段标记为
`keyword-fallback` / `script-fallback`，练习不中断。

---

## 四、无 Key 也能验证全链路：内置 Mock 模型

`server/mock-llm.js` 是一个 **OpenAI 兼容的本地模拟服务**，用确定性启发式规则打分（有真实区分度），
用来在没有 Key 的情况下把「双角色对话 → 评分 → 落库 → 校准」整条链路跑通。

```bash
# 终端 1：启动 mock 模型
node server/mock-llm.js 8999

# 终端 2：让后端指向 mock
LLM_API_KEY=mock-key LLM_BASE_URL=http://127.0.0.1:8999/v1 LLM_MODEL=mock-scorer-v1 node server/index.js
```

切回真实模型只需把 `LLM_BASE_URL` 指回真服务，**其余代码零改动**。
详细的「用 mock 验证校准数学」流程与预期数字见下方「金标集校准」。

---

## 五、接口一览

所有接口前缀 `/api/v1`，成功返回 `{ok:true,data:...}`，失败返回 `{ok:false,error,...}`。

**身份传递**：首选请求头 `Authorization: Bearer <token>`（登录后获得）。
`open` 模式下也兼容请求体 `userId` 或请求头 `X-User-Id`（演示用）；`enforce` 模式下只认 token。
带 token 时**以 token 身份为准**，请求体自称的 `userId` 会被忽略。

| 方法 | 路径 | 档位 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | public | 账号口令登录 → `{token, expiresAt, user}` |
| GET | `/auth/me` | staff | 当前身份 + 鉴权模式 |
| POST | `/auth/password` | staff | 修改自己的口令（`oldPassword` / `newPassword`） |
| GET | `/auth/accounts` | staff | 账号与权限矩阵（**不含口令哈希**） |
| GET | `/status` | public | 服务状态、模型配置、在线探活、鉴权模式、**落盘级别（`dbSync`：journal + synchronous 真值）**、数据统计 |
| GET | `/ai/status` | public | 仅 AI 通道状态（含探活耗时） |
| GET | `/rubric` | public | 当前 Rubric（5 维锚点与权重） |
| GET | `/scenes` | staff | 场景库（支持 `?publish=`、`?assignable=1`） |
| POST | `/scenes` | staff | 新建 / 更新场景（自动留版本；已发布场景编辑后转待审） |
| GET/PUT/DELETE | `/scenes/:id` | staff | 场景详情 / 更新 / 删除 |
| GET | `/scenes/:id/versions` | staff | 版本列表 |
| POST | `/scenes/:id/rollback` | staff | 回滚到指定版本（`v`） |
| POST | `/scenes/:id/submit` | staff | 提交审核 |
| POST | `/scenes/:id/approve` | staff | 审批通过（**提交人 ≠ 审批人**） |
| POST | `/scenes/:id/reject` | staff | 驳回（需 `reason`） |
| POST | `/scenes/:id/offline` | staff | 下线 |
| GET | `/scenes/published` | **practice** | **学员端「已发布场景池」（匿名可读）**。只返回 `publish='published'` 的场景，且只带学员端要用的字段（`script/tips/objectives/voicePool/passLine/…`），**不带 `audit`/`versions`/`owner`/`publish`/`status`/`updatedAt`/`brief`** —— 因为这是匿名端点 |
| POST | `/session/:id/turn` | practice | 一轮对话：AI 评分 + NPC 回复（允许匿名） |
| POST | `/session/:id/finish` | practice | 结束会话，写一条成绩记录（允许匿名） |
| GET | `/records` `/learners` `/users` | staff | 培训数据（**按登录身份的数据范围过滤**；`/records` 每条带 `qc` 质检状态、`turnCount` 与 `mode` 来源（`task`=任务考核 / `free`=自主练习，由 `task_id` 推导），**刻意不带逐轮对话正文**，见下方「逐轮对话」；支持 `?mode=task|free` 筛选，可与 `?learnerId=` 组合） |
| GET | `/records` `/learners` `/tasks` `/coach-notes` `/audit` | — | **列表分页统一口径（P9）**：`?limit=&offset=`（`limit∈[1,500]`、`offset≥0`，非法 400），返回 `{ items, total, limit, offset, hasMore }`，`total` 是筛选后总数；**不带分页参数仍是全量**（三端水合依赖，audit 例外：无参默认最近 100 条）。翻页配**稳定排序**（主键次级定序），不重不漏 |
| GET | `/records/:id/turns` | staff | **一条成绩的逐轮对话（P7）**。只卡**数据可见范围**（不卡 `can_edit`/`can_review` —— 看自己名下学员的对话是带教本职）。越范围 / 无归属成绩一律 403，不存在 404 |
| DELETE | `/records/:id` | staff（需编辑权） | 删除一条成绩（**连带删掉它的质检结论**，避免留下无主结论） |
| GET | `/coach-notes` | staff | 辅导记录（按数据范围过滤；`?learnerId=` 收窄到某学员，**`?q=` 全文包含检索（P9）**——LIKE 通配符 `%`/`_`/`\` 已转义，用户输入按字面匹配） |
| POST | `/coach-notes` | staff | 写一条辅导记录（`learnerId` / `text` / 可选 `recordId` `type`） |
| DELETE | `/coach-notes/:id` | staff | 删除辅导记录（**仅限本人写的**，admin 例外） |
| GET | `/qc` | staff | 质检结论列表（按数据范围过滤） |
| POST | `/records/:id/qc` | staff | 写质检结论（`state`: `ok` 通过 / `flag` 待统一话术，可选 `note`） |
| DELETE | `/records/:id/qc` | staff | 撤销质检结论（标错了要能改回来） |
| GET | `/tasks` | practice | 带 `?learnerId=` 时返回**该学员本人的任务**（允许匿名，学员端用）；不带时按身份返回管理列表（无身份 401） |
| GET | `/tasks/:id` | staff | 任务详情（含 `assignees` 与 `progress`） |
| POST | `/tasks` | staff | 新建任务（校验场景存在且**已发布**、指派人存在、达标线 0–100） |
| PUT | `/tasks/:id` | staff | 更新任务（路径 `id` 优先于请求体） |
| POST | `/tasks/:id/status` | staff | 改状态（`running` / `finished` / `draft`） |
| DELETE | `/tasks/:id` | staff | 删除任务（连带清掉指派人关联） |
| GET | `/audit` | staff | 操作审计日志（**按数据范围过滤**；P9 起 SQL 化范围过滤 + 分页——旧实现「先 LIMIT 再 JS 过滤」会让带范围账号看到**少于 limit** 的行且没有 total，已修正；管理端服务端页的审计卡片带翻页，逐页浏览全量留痕） |
| GET | `/goldset` | staff | 金标集 |
| POST | `/goldset/import` | staff | 导入金标样本（同 id 覆盖更新） |
| POST | `/goldset/calibrate` | staff | 运行校准（`mode`: auto/llm/keyword） |
| GET | `/goldset/runs` | staff | 历史校准结果 |
| GET | `/admin/backup` | staff | 备份列表 |
| POST | `/admin/backup` | staff | 立即生成一份一致性快照 |

### CORS 策略

不再使用通配 `*`。**放行条件（任一满足）**：

- 请求无 `Origin`（命令行 / 服务端调用）
- `Origin: null`（`file://` 打开的页面，可用 `CORS_ALLOW_FILE=false` 关闭）
- 在 `CORS_ORIGINS` 显式清单中（逗号分隔，如 `http://10.0.0.7:8080,http://oa.example.com`）
- 本机来源（`127.0.0.1` / `localhost` / `::1` 任意端口，可用 `CORS_ALLOW_LOCAL=false` 关闭）
- 与请求 `Host` 同源

其余来源返回 `403`（预检同样拦截）。

### 一轮对话的返回形状（PRD 契约）

```jsonc
{
  "sessionId": "S-20261005-A1B2", "turn": 2, "score": 78,
  "dimScores": { "d1": 86, "d2": 72, "d3": 68, "d4": 80, "d5": 74 },
  "objectives": [{ "dim": "d2", "achieved": true, "evidence": "..." }],
  "feedback": "本轮接住了客户顾虑，可再补一组数据。",
  "confidence": 0.85,
  "customerReply": { "text": "...", "emotion": "skeptical", "voiceSec": 6, "source": "llm" },
  "source": "llm",              // llm | keyword-fallback | script-fallback
  "fallback": false,
  "notes": [], "nextState": { ... }
}
```

`scoreTurn()` 语义与前端 `data/scoring-engine.js` 一致，因此**三端调用代码零改动**。

### 学员端场景池：让「运营发布 → 学员练到」闭环（P6）

在 P6 之前，学员端场景库读的是**页面加载时**的 `window.SCENES`（静态种子），
所以一个在剧本编辑器里新建、走完审批、被下发的场景，**学员刷新多少次都练不到**——
「下发 → 学员练」这条链路对新场景是断的。

现在：学员端启动时（与拉「我的任务」并列）**匿名**拉一次 `GET /scenes/published`，
拿到后交给 `TRAIN.helpers.mergeScenes()` 合并进场景库，有变化才重渲染会话列表与任务卡；
离线或失败**一律静默**，保持本地种子场景不变（`file://` 双击照样能用）。

三个容易踩的点：

1. **合并语义必须是「按 id 原地更新 + 未知 id 追加」，且不重排、不删除、不换引用。**
   不重排：学员端 `cur` 是**数组下标**、`SCENES[cur]` 在几十处实时求值，重排会让
   「当前会话」指向别的场景；不删除：服务端库可能不全（只播了部分场景），
   把本地种子一并清掉会让学员**直接没场景可练**。两件事都**不会报错**，只能靠断言拦住。
2. **路由注册顺序**：`/scenes/published` 必须注册在 `/scenes/:id` **之前**
   （路由按注册顺序取首个匹配），否则 `published` 会被当成场景 id 走进详情分支。
3. **它是匿名端点**，所以只回学员端要用的字段。新增返回字段前先问一句
   「这东西给没登录的人看合适吗」——自测里有一条专门断言不泄漏
   `audit/versions/owner/publish/status/updatedAt/brief`。

> 场景**下线**的收口在服务端：`publish!=='published'` 就查不到，学员刷新即复位，
> 因此不在前端做「删除本地场景」这个动作。

### 逐轮对话：让「对话质检」真的看得到对话（P7）

P7 修的是一处**"看起来有、其实没有"**的缺口：

- `session_turns` 表一直在写（每次 `turn` 都落库），但**从来没有读的路径** ——
  既没有接口，也没有任何页面渲染它；
- 教练台的「逐轮复盘」整块是拿**场景剧本**拼出来的（客户说了什么 + 参考表达），
  **学员当时答了什么一个字都没有**，而它旁边就摆着「针对这一轮写辅导」的按钮；
- 「对话质检」页只有分数、最弱维度和两个按钮 —— 质检人只能凭分数猜，看不到对话。

现在补齐两端：

1. **接口**：`GET /records/:id/turns`，按需读取一条成绩的逐轮对话。
   正文**不进列表接口**（演示库 28 条 × 5~6 轮 ≈ 150 段文本，列表页一个字都不渲染），
   列表改回 `turnCount` 让页面知道「这条有没有对话可看」。
2. **页面**：教练台「逐轮复盘」优先渲染服务端逐轮明细（**客户实际台词 / 学员实际作答 /
   本轮得分 / 本轮五维小分**），参考表达降级为可折叠对比；「对话质检」新增「看对话」抽屉；
   管理端学员报告里每条成绩可展开逐轮对话。

**四个必须守住的点**（都是"不报错但会错"的类型）：

1. **形状必须只有一处定义。** 以前 `finish()` 返回的 `turns` 是
   `{idx,learnerText,customerReply,emotion,score,dimScores,confidence,source}`
   而落库的 `evidence` 是 `{turn,learner,customer,score}` —— **同一份数据两种字段名**，
   按前者写的前端拿后者会**静默读出 `undefined`**（不抛错、只显示空白）。
   现在三处（`finish` 返回 / `evidence` 落库 / 逐轮接口）统一走 `turnRow()`。
2. **口径必须精确一致。** `finish()` 按「逐轮算术平均再取整」聚合。演示数据的逐轮分
   不能用"看起来差不多"的一组数，否则教练台并排显示时会出现**「逐轮均分 72 / 总分 58」**。
   `db.js` 的 `spreadExact()` 用**余数分摊**把每维凑到 `sum === 目标分 × 轮数`，
   使 `round(mean(逐轮))` 恒等于成绩单上的数（含 5 个维度）。
3. **轮次取 `payload.turns`（5 或 6），不是 `script.length`。** 场景剧本 6 轮而训练目标
   只有 5 条，两者本来就不相等（学员端判分同款坑）。
4. **必须有"这不是学员作答"的显式标注。** 离线 / 未登录 / 越范围时页面**保留剧本骨架**，
   但要在顶部写明"以下为场景剧本参考，不是学员的真实作答"；
   服务端明确答复"无逐轮记录"与"读不到"也要分开说 —— 前者是历史数据如此，
   后者是权限/连接问题，混为一谈会让教练误判。

> 权限上刻意与场景/任务不同：读写逐轮对话只卡**数据可见范围**，不卡 `can_edit`/`can_review`
> —— 看自己名下学员的对话是带教主管的本职，不是内容运营动作。
> 无归属成绩（练习未带 `learnerId`）对谁都 403，报错文案会带上具体动作
> （"无法查看逐轮对话"而不是"无法做质检"）。

---

## 六、权限模型（角色分离）

| 账号 | 角色 | 可编辑场景 | 可审批 |
|---|---|---|---|
| `admin`（U-ADMIN） | 系统管理员 | ✅ | ✅ |
| `wangqian` / `limeng` | 培训运营（按部门） | ✅ | ❌ |
| `zhangtao`（U-REV01） | 带教主管（审核） | ❌ | ✅ |
| `chenxi`（U-COACH1） | 区域教练 | ❌ | ❌ |
| `zhoumin`（U-COACH2） | 区域教练 | ❌ | ❌ |
| `zhaolei`（U-COACH3） | 区域教练 | ❌ | ❌ |

规则：**提交人不能审批自己提交的场景**；越权返回 `403`；所有写操作写入 `audit_log`。
**权限（能否改）与可见范围（能看谁）是两把独立的锁**：前者是 `can_edit/can_review`，后者是
`data_scope`（见第二节）。教练能在「教练工作台」里只看到自己带的学员，靠的是后者。

**管理后台已接服务端写**：新建 / 保存场景、提交审核、审批通过、驳回、下线、回滚、删除
全部先走服务端（`applyServerScene` 把服务端结果合并回本地工作副本），服务端不可用时自动回落
`localStorage`，页面行为不变。**所有 403/400 都会如实提示，并且界面会回滚为服务端真实状态**，
不会出现「界面上看着改成功了、其实服务端拒绝了」的假象。

### 教练工作台（P5 新增）

教练台是三个前端里**最后**接上服务端的（P0–P4 期间它的身份写死、辅导记录只存内存）。
现在它：登录拿身份 → 按服务端给的数据范围筛学员 → 辅导记录与质检结论**真正落库**。

| 动作 | 权限判定 | 说明 |
|---|---|---|
| 看学员 / 成绩 / 任务 | `data_scope` | 服务端过滤，前端只负责显示 |
| 写辅导记录 `POST /coach-notes` | `data_scope` | **不卡 `can_edit`** |
| 做对话质检 `POST /records/:id/qc` | `data_scope` | **不卡 `can_edit`** |
| 删除别人写的辅导记录 | 本人（admin 例外） | |
| 删除成绩 `DELETE /records/:id` | **卡 `can_edit`** | 属于内容运营动作，教练无权 |

> ⚠️ 教练的权限是**刻意**与场景编辑、任务下发区分的：写辅导记录、做质检是带教主管的**本职**，
> 而教练角色的 `can_edit` 本来就是 0。若这里也卡 `can_edit`，教练台会变成一个只能看的页面。
> 真正该卡的是**可见范围** —— 只能读写自己带教的学员，越界一律 `403`。

无归属成绩（请求体不带 `learnerId` 的练习）**对谁都不可质检**，统一 `403`。
这里踩过两个坑：① 一度返回 `400 缺少学员 id`，把服务端自己的数据状态说成调用方参数错误；
② `inScope(user,'')` 在 `scope=all` 时因 `ids===null` 返回 `true`，导致管理员能给无主成绩打质检结论。
两条都已在 `assertRecordScope()` 里堵住，并有断言看住。

三种验证越权的方式：

```bash
# 1) 用教练账号登录后台，尝试保存场景 → 403 提示
# 2) 运营提交审核后，同一账号点「审核通过」→ 403（角色分离）
# 3) 命令行直接打接口（见下方自测脚本）
node server/tools/selftest.js      # 端到端自测，含越权与 enforce 拦截
```

---

## 七、金标集校准

金标集是 **10 条人工双盲标注**的对话样本（`server/store/goldset-seed.json`，首次启动自动导入）。
校准计算「模型综合分 vs 人工总分」的 **Pearson 相关系数**（目标 ≥ 0.8）与 **MAE**（目标 ≤ 8）。

**扩充样本**：管理后台 →「服务端 / AI」→「金标集导入」，粘贴 JSON 数组即可批量入库
（同 `id` 覆盖更新）。PRD 目标是 100+ 条；10 条只够证明链路与排序一致性，样本越多结论越可靠。

```bash
curl -X POST http://127.0.0.1:8848/api/v1/goldset/calibrate \
  -H "Content-Type: application/json" -d '{"mode":"auto"}'
```

- `mode=auto`：有 Key 走真实模型，否则走关键词引擎
- `mode=llm`：强制走真实模型（无 Key 会报错）
- `mode=keyword`：强制走关键词引擎

**只有 `channel=llm` 的结果才具备校准意义**；关键词引擎分数无区分度，返回体 `meaningful:false` 且
附带 `pearsonNote` 说明（相关系数在数学上无定义），仅用于验证链路可通。

### 用 mock 模型的实测参考值

| 通道 | Pearson | MAE | 结论 |
|---|---|---|---|
| 真实模型（mock） | **0.885** ✅ | 13.8 ❌ | 排序一致性好，但绝对分偏高，Rubric 需收紧 |
| 关键词引擎 | null（无区分度） | 22 | 仅证明链路可通 |

分维一致性：`d2 需求挖掘 0.918`、`d5 促成推进 0.879` 强；`d4 方案讲解 0.577` 最弱 → 说明
「方案讲解」维度的 Rubric 描述最需要补充可判定的锚点。

---

## 八、目录结构

```
server/
├── index.js        HTTP 服务 + 路由（三档鉴权）+ 静态托管 + CORS 白名单
├── config.js       配置中心（环境变量 → .env.json 兜底）
├── db.js           SQLite 建表 / 轻量迁移 / 播种 / 通用工具（含 P7 演示逐轮对话播种）
├── auth.js         登录鉴权：账号口令 → 无状态 token（HMAC-SHA256）+ 身份解析
├── password.js     scrypt 口令哈希（零依赖）
├── llm-client.js   OpenAI 兼容客户端（超时 / 重试 / JSON 提取）
├── rubric.js       Rubric 锚点 + 双角色 prompt 生成（权重取自 TRAIN.dims）
├── ai.js           双角色编排：评分官 + 客户 NPC，各自独立降级
├── service.js      业务层：权限 / 场景 CRUD / 版本 / 审批 / 会话 / 逐轮对话 / 查询
├── goldset.js      金标集导入 + Pearson/MAE 校准
├── backup.js       SQLite 一致性快照（VACUUM INTO）+ 保留策略
├── mock-llm.js     本地 OpenAI 兼容模拟模型（无 Key 验证用）
├── tools/
│   ├── selftest.js     端到端自测（鉴权 / 越权 / 审批流 / 场景池发布闸门 / 逐轮对话与口径 / 任务闭环 / 数据范围 / 教练动作 / CORS / enforce）
│   ├── frontend-test.js 无浏览器前端验证（脚本可解析 / 水合与场景池合并语义 / 真接口往返 / 逐轮对话与渲染器沙箱 / 接线断言 / **学员端整页沙箱真跑**）
│   ├── backup.js       备份 CLI
│   └── reset.js        恢复出厂（删库 + 重新播种）
├── store/
│   ├── goldset-seed.json   10 条人工标注样本
│   ├── backup/            自动快照（已 gitignore）
│   └── training.db         SQLite（自动生成，已 gitignore）
└── .env.json       本地密钥（已 gitignore）
```

前端适配层（可选加载，失败即降级）：

- `assets/ai-bridge.js` —— 学员端用：探测服务、提交对话轮次、落库、**拉取本人任务列表**、**拉取已发布场景池**（候选基址：同源 → 127.0.0.1:8848）
- `assets/admin-server-sync.js` —— **管理后台与教练工作台共用**：登录 / 拉取场景库 / 保存 / 审批 / 审计 / 校准 / 金标导入 / 备份 / **任务 CRUD 与状态变更** / **按范围拉取学员与记录** / **辅导记录增删** / **质检结论写入与撤销** / **按需读取逐轮对话**

启动脚本：`start-server.sh`、`start-server.bat`、`start-mock-demo.bat`。

---

## 九、部署与内网访问

### 小范围试点（同一局域网内几台机器）

```bash
# 1) 让服务监听内网地址（默认只监听 127.0.0.1）
HOST=0.0.0.0 PORT=8848 node server/index.js

# 2) 强制登录（试点必须开，否则任何人都能改场景）
AUTH_MODE=enforce HOST=0.0.0.0 node server/index.js

# 3) 如果页面是从别的地址打开的，把那个来源加进白名单
CORS_ORIGINS=http://10.0.0.7:8080 node server/index.js
```

同事直接用 `http://<你的内网IP>:8848/管理后台-仿真培训.html` 访问即可（推荐从服务地址打开，同源最省事）。

### 单机能扛多少（本机实测）

压测方式：独立临时库 + **关掉大模型**（隔离服务端自身开销）+ Node 22 单进程。

| 接口 | 并发 | P50 | 吞吐 |
|---|---|---|---|
| 读 `GET /scenes/published`（匿名场景池） | 60 | 8ms | ~2900 req/s |
| 读 `GET /records/:id/turns`（逐轮对话详情） | 60 | 21ms | ~1700 req/s |
| 读 `GET /records`（成绩列表，含关联） | 60 | 25ms | ~1100 req/s |
| **写 `POST /session/:id/turn`（一轮对话：判分 + 落库）** | 40 | **49ms** | **~470 req/s** |
| 混合（读 30 + 写 30 同时打） | 60 | 读 9ms / 写 184ms | 混合墙钟 222ms |

**真正的并发上限不在服务端，而在大模型**：单轮真实模型调用 0.5–3s，再叠加供应商限流（RPM / TPM）。
100 人同时练、每人每轮约 2s，峰值也只有 ~50 次调用/秒 —— 服务端这边远远不是瓶颈，
容量要按**模型的 RPM 配额**来算，而不是按这台机器。

> ⚠️ 上表依赖 `PRAGMA synchronous = NORMAL`（见下节）。若被改回 SQLite 出厂默认 `FULL`，
> **功能一切正常、只有性能塌掉**：单轮落库从 3ms 涨到 155ms，写吞吐从 470 req/s 掉到 **6 req/s**；
> 更糟的是 fsync 会阻塞单线程事件循环 —— 写入并发时**读接口从 2ms 劣化到 1.5s**（实测）。
> `/status` 的 `dbSync` 字段会如实回报当前生效值，自测里也有断言看住它。

### 落盘级别（`DB_SYNC`）

SQLite 出厂默认 `synchronous=FULL`，在 WAL 模式下**每次提交都要 fsync 一次**。本机实测单条写入提交耗时：

| 设置 | 单条 INSERT 提交 | 说明 |
|---|---|---|
| `FULL`（SQLite 出厂默认） | 43.96ms | 每次提交 fsync |
| **`NORMAL`（本方案默认）** | **0.06ms** | WAL 官方推荐值，相差约 **700 倍** |
| `OFF` | 0.05ms | 不建议（断电可能损坏库文件） |

默认 `DB_SYNC=NORMAL`：WAL + NORMAL 下**进程崩溃不会损坏数据库**，只可能丢「崩溃前最后几个已提交事务」；
断电 / 系统崩溃才会丢一小段。对培训系统（可重练、成绩可补录）这个取舍是合适的。

若合规上要求「断电也不丢」，设 `DB_SYNC=FULL` 回到旧行为（代价是写吞吐掉到个位数）：

```bash
DB_SYNC=FULL node server/index.js
```

### 仍未覆盖（正式上线前需要补）

| 项 | 说明 |
|---|---|
| HTTPS / 反向代理 | 内网可先不加；跨网段或公网必须加（Nginx/Caddy 反代到 8848） |
| 进程守护 | 脚本只是前台运行；生产建议用 systemd / pm2 / Windows 服务包装 |
| 数据库 | 当前 SQLite 单文件 + **单进程同步 API**（写入天然串行）：实测写吞吐 ~470 req/s（`DB_SYNC=NORMAL`），够数百人同时练；并发写压力再大时迁 PostgreSQL |
| 统一身份 | `server/auth.js` 接口不变，可整体换成企业 SSO / 企业微信扫码 |
| 接口分页 | **P9 已统一补齐**：五个列表接口都支持 `?limit=&offset=`（校验 + `total`/`hasMore` + 稳定排序）。三端页面的「一次拉全量 + 本地统计」是**刻意架构**（离线兜底依赖本地全量），分页面向导出 / 对接 / 未来轻客户端 |
| 逐轮对话留存 | 逐轮明细存在 `records.evidence` 这一列 JSON 里；它有按需接口与权限，但**没有独立的检索/统计**（比如"全校最常出现的敷衍话术"），要另做 |
| 辅导记录检索 | **P9 已补 `?q=` 全文包含检索**（服务端能力，LIKE 通配符已转义）；UI 侧暂无搜索入口，检索面向对接与导出脚本 |
| 学员端场景热更新 | **P8 已补 60s 轻轮询**：页面开着（且可见）就会同步新发布场景与新下发任务，不必刷新；仅页面不可见时暂停（后台标签页不耗流量）。轮询间隔为编译期常量，需调优时改学员端 `setInterval` 处 |

---

## 十、备份与恢复

全部数据在一个 SQLite 文件里，**这是本方案最大的运维风险点**，所以给了现成手段：

```bash
# 生成一份一致性快照（VACUUM INTO，无需停服，WAL 下也安全）
node server/tools/backup.js                 # 或 npm run backup
node server/tools/backup.js pre-release     # 带备注

# 管理后台 →「服务端 / AI」→「数据备份」→「立即备份」也可
```

- 快照落在 `server/store/backup/`，默认**保留最近 20 份**（`BACKUP_KEEP` 可调），自动清理旧份
- 每次备份写入审计日志（`db.backup`）

**恢复步骤**：

1. 停掉服务（Windows：先用端口查出 PID，再 `taskkill /F /PID <pid>`）
2. 用备份文件覆盖 `server/store/training.db`
3. **同时删除** `training.db-wal` 与 `training.db-shm`（否则 WAL 里的旧内容会被回放）
4. 重启服务

**恢复出厂**：

```bash
node server/tools/reset.js            # 只提示，不执行
node server/tools/reset.js --yes      # 真删（含 -wal / -shm），下次启动重新播种
```


---

## 十一、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 角标显示「离线模式」 | 后端未启动 / 端口被占 | `node server/index.js`；检查 8848 是否被占用 |
| 角标显示「服务已连接（降级模式）」 | 未配置 `LLM_API_KEY` | 按第三节配置 Key |
| 后台点「保存」提示「服务端拒绝：角色…无场景编辑权限」 | 当前登录账号无编辑权（如教练） | 换 `wangqian` / `limeng` / `admin` 登录 |
| 后台点「审核通过」提示「提交人不能审核自己提交的场景」 | 角色分离规则（设计如此） | 用**另一个**账号审批：`zhangtao` |
| 登录提示「登录状态已失效」 | token 过期（默认 12h） | 重新登录；或调大 `AUTH_TTL_HOURS` |
| 登录提示「登录失败次数过多」 | 同一账号 5 次错口令，锁 5 分钟 | 等 5 分钟，或重启服务清空节流计数 |
| 忘记口令 | 服务端只存哈希，无法找回 | 删除该用户的 `salt`/`password_hash` 后重启服务会重新生成并打印：<br>`UPDATE users SET salt=NULL, password_hash=NULL WHERE account='xxx';` |
| 浏览器直连接口报 CORS / 403 | 来源不在白名单 | 加 `CORS_ORIGINS=http://来源` 重启；推荐直接从服务地址打开页面（同源） |
| 内网其他机器访问不到 | 服务只监听 127.0.0.1 | 用 `HOST=0.0.0.0` 重启 |
| 校准 `n=0` | 金标集为空 | 重新导入，或 `node server/tools/reset.js --yes` 后重启 |
| 删库后数据还在 | 只删了 `.db`，WAL 里的内容被回放 | 三个文件一起删，或用 `node server/tools/reset.js --yes` |
| 改了代码不生效 | Windows 下旧 node 进程未退出 | **只用 PID**：`netstat -ano \| findstr :8848` 拿到 PID 后 `taskkill /F /PID <pid>`。⚠️ **不要用 `taskkill /F /IM node.exe`** —— 它会把本机**所有** Node 进程一起杀掉，包括你正在用的工具自己的后台进程 |
| 登录后看到的学员/任务比别人少 | 账号的数据范围不是 `all` | 正常：`dept` 只看本部门、`mentor` 只看名下带教；要放开改 `users.data_scope='all'` |
| 首次启动报 `UNIQUE constraint failed: users.id` | 老版本在同一新库上把演示账号插了两次 | 已修；若在旧版本遇到，删库三件套重启即可 |
| 输出大量 `ExperimentalWarning` | `node:sqlite` 仍是实验特性 | 正常现象，可用 `2>/dev/null` 过滤 |
| 运营发布了场景，学员端还是看不到 | 先分清是**没发布**还是**没刷新** | `curl http://127.0.0.1:8848/api/v1/scenes/published` 看它在不在池里：不在 → 审批流没走完（见第五节的场景池说明）；在 → 学员页刷新一次即可（前端只在启动时拉一次池） |
| 教练台「逐轮复盘」看不到学员说了什么 | 三种情况，页面已分别标注 | ① 顶部提示"未连接服务端 / 未取到逐轮明细" → 服务没起、没登录或**该学员不在你的数据范围**；② 提示"这条成绩没有保存逐轮对话" → P7 之前的练习没留存，让学员重练一次；③ 只看得到"剧本参考" → 同 ①。可先 `curl -H "Authorization: Bearer <token>" http://127.0.0.1:8848/api/v1/records/R001/turns` 定位 |
| 逐轮均分与成绩单总分对不上 | 逐轮数据不是按"均值精确等于总分"生成的 | 只会在手工构造/导入 `evidence` 时出现。播种用 `db.js` 的 `spreadExact()` 保证 `sum === 目标分 × 轮数`；自测里有两条断言分别看住总分与五个维度 |
| **一起练的人一多，每轮都卡好几秒**（功能全对，只是慢） | 十有八九是 `synchronous` 被改回了 SQLite 出厂默认 `FULL`，每次提交都在 fsync，且 fsync 阻塞单线程事件循环 | 看 `/status` 的 `dbSync.synchronousName`：是 `FULL` 就去掉 `DB_SYNC=FULL` 重启（默认 `NORMAL`）。对照数据：单轮落库 FULL 155ms / NORMAL 3ms，写吞吐 6 → 470 req/s，写入并发时读接口 1.5s → 9ms |
| 迁移到新机器后写入突然变慢 | 磁盘 fsync 性能差（虚拟机 / 网络盘）会被放大 | 同样先查 `dbSync`。WAL + `NORMAL` 下写放大主要来自 fsync，磁盘越慢差距越大（本机 FULL 43.96ms / NORMAL 0.06ms） |
| 想一次性验证全部改动 | — | 先起服务，再 `node data/__selftest.js`（35 项）+ `node server/tools/selftest.js`（152 项）+ `node server/tools/frontend-test.js`（185 项） |
