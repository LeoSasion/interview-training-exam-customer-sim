# 文档与目录地图

> 一次看清「哪个文件是什么、哪个是当前有效的」。**改代码前先看 `.workbuddy/memory/CONVENTIONS.md`**。

## 一、入口与页面（根目录，纯静态零依赖，`file://` 可双击）

| 文件 | 是什么 |
|---|---|
| `index.html` | **总入口**：四页导航 + 迭代记录（P13 起的记录见 `server/CHANGELOG.md`） |
| `仿真培训原型-微信风格.html` | **学员端**（已验收交付物，改动须回归对照：文字 70 / 语音 54） |
| `管理后台-仿真培训.html` | 运营端：看板 / 任务 / 学员报告 / 场景库与编辑器 |
| `教练工作台-带教主管.html` | 教练端：总览 / 我的学员 / 辅导 / 对话质检 |
| `产品规划-新员工培训系统.html` | PRD（定位 / 角色 / 数据模型 / 评分机制 / 路线 / 风险） |

⚠️ 这五页的相互跳转是**相对路径**，`index.html` 里也链到 `refs/`。移动文件必须同步改链接，否则死链。

## 二、代码

| 路径 | 是什么 |
|---|---|
| `data/app-data.js` | **唯一真相源**：场景 / 学员 / 任务 / 成绩 / 维度 / 风险 + `TRAIN.helpers` |
| `data/scoring-engine.js` | **唯一评分闸门**（纯函数）；改后必跑 `node data/__selftest.js` |
| `assets/shell.css` | 四页共享外观底座（双主题令牌） |
| `assets/ai-bridge.js` | 学员端适配层（可选加载，失败静默降级） |
| `assets/admin-server-sync.js` | 管理端 + 教练台同步层 |
| `server/` | 零 npm 依赖 Node 22 服务层 → **用法见 `server/README.md`，演进见 `server/CHANGELOG.md`** |
| `tools/` | 软著材料生成器：`gen-copyright-source.js`（源代码文档）、`gen-copyright-manual.js`（用户手册） |

## 三、文档

| 路径 | 是什么 |
|---|---|
| `server/README.md` | **服务端主线文档**：启动 / 账号 / 接口表 / 权限 / 校准 / 部署 / 故障排查 |
| `server/CHANGELOG.md` | 各轮交付的过程、实测数据与踩坑（P12 起） |
| `docs/软著/` | 软著申请材料：源代码文档（60 页）、用户手册（14 页）、`申请材料清单.md`、`shots/` 9 张截图 |
| `docs/archive/` | **过期留档**：`新员工培训系统-源码-20261006.zip`（10-06 快照，勿当最新交付物） |
| `docs/会话记录/` | 历史会话正文归档（从本地 jsonl 恢复，非摘要）；`00-索引.md` 是入口 |

## 四、参考资料与运行时产物（不入库）

| 路径 | 是什么 |
|---|---|
| `refs/` | 选型期抓的开源陪练系统参考图库（被 `index.html` 引用，**不要删**） |
| `voice/` | 本地 ASR 服务 `asr-server.py` + 两个自测语音样本；日志已清 |
| `server/store/` | SQLite 库、`backup/` 快照、`goldset-seed.json`——均 gitignore |
| `.workbuddy/memory/` | 项目记忆：`MEMORY.md`（必读铁律）、`CONVENTIONS.md`（细则）、日期日志（现场） |

## 五、启动

`start-all.bat`（一次起全链）｜ `start-server.bat` / `.sh` ｜ `start-mock-demo.bat`（无 Key 演示）｜ `start-asr.bat`（语音）。

## 六、一句话记住

**真相源只有一个**：数据看 `data/app-data.js`，评分看 `data/scoring-engine.js`，接口看 `server/`。
文档若与代码冲突，**以代码为准**，并回头改文档。
