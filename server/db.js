'use strict';
/**
 * SQLite 数据层（node:sqlite，零依赖）
 *
 * 表设计对齐 PRD「核心实体字段表」：
 *   scenes / scene_versions / scene_audit      ← 场景与内容治理（替代前端 localStorage）
 *   learners / tasks / task_assignees          ← 学员 / 任务 / 任务指派（按学员反查"我的任务"）
 *   records                                    ← 练习记录
 *   users                                      ← 用户与角色（权限基础 + data_scope 数据范围）
 *   audit_log                                  ← 操作审计日志
 *   rubric_versions                            ← Rubric 版本（评分口径可追溯）
 *   gold_set / gold_runs                       ← 金标集与校准跑批结果
 *   sessions / session_turns                   ← 会话状态（一轮对话的落库）
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL;');
/**
 * ⚠️ 必须显式设 synchronous —— SQLite 出厂默认是 FULL，WAL 模式下**每次提交都 fsync**。
 * 本机实测单条写入提交：FULL 43.96ms / NORMAL 0.06ms（约 700 倍）。
 * FULL 下「一轮练习」落库要 ~77ms，且 fsync 会**阻塞事件循环**——
 * 写入并发时读接口从 2ms 劣化到 1.5s（实测），因为 Node 单进程下所有请求排在 fsync 后面。
 * NORMAL 是 WAL 的官方推荐值：进程崩溃不损坏库，只可能丢最后几个已提交事务。
 * 需要「断电也不丢」的部署设 DB_SYNC=FULL（见 config.js）。
 */
db.exec(`PRAGMA synchronous = ${config.dbSync};`);
db.exec('PRAGMA foreign_keys = ON;');

const SYNC_NAME = { 0: 'OFF', 1: 'NORMAL', 2: 'FULL', 3: 'EXTRA' };

/**
 * 读回**实际生效**的落盘级别（真值，不是配置值）。
 *
 * 为什么要读回：`synchronous` 一旦被别人改回默认 FULL，功能全部正常、只有性能塌掉，
 * 属于「不照做也不报错」的约束 —— 必须能被 /status 看到、被自测断言看住。
 * 返回 synchronous 的**数字**（0 OFF / 1 NORMAL / 2 FULL / 3 EXTRA）与可读名。
 */
function pragmas() {
  let journalMode = '';
  let synchronous = null;
  try { journalMode = String((db.prepare('PRAGMA journal_mode').get() || {}).journal_mode || ''); } catch (e) { /* 忽略 */ }
  try { synchronous = Number((db.prepare('PRAGMA synchronous').get() || {}).synchronous); } catch (e) { /* 忽略 */ }
  return {
    journalMode,
    synchronous,
    synchronousName: SYNC_NAME[synchronous] || String(synchronous),
    configured: config.dbSync,
    foreignKeys: (() => { try { return Number((db.prepare('PRAGMA foreign_keys').get() || {}).foreign_keys) === 1; } catch (e) { return null; } })()
  };
}

/* ------------------------------------------------------------------ *
 * 建表
 * ------------------------------------------------------------------ */
db.exec(`
CREATE TABLE IF NOT EXISTS scenes (
  id          TEXT PRIMARY KEY,
  code        TEXT,
  name        TEXT NOT NULL,
  subtitle    TEXT,
  avatar_text TEXT,
  color       TEXT,
  task_name   TEXT,
  channel     TEXT,
  category    TEXT,
  difficulty  TEXT,
  pass_line   INTEGER,
  duration    INTEGER,
  status      TEXT DEFAULT 'active',
  publish     TEXT DEFAULT 'draft',      -- draft | review | published | offline
  owner       TEXT,
  updated_at  TEXT,
  brief       TEXT,
  payload     TEXT NOT NULL              -- 完整场景 JSON（script/objectives/voicePool/tips）
);

CREATE TABLE IF NOT EXISTS scene_versions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id  TEXT NOT NULL,
  v         INTEGER NOT NULL,
  at        TEXT,
  by_user   TEXT,
  note      TEXT,
  snapshot  TEXT NOT NULL,               -- 该版本完整场景 JSON
  FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ver_scene ON scene_versions(scene_id);

CREATE TABLE IF NOT EXISTS scene_audit (
  scene_id      TEXT PRIMARY KEY,
  status        TEXT DEFAULT 'draft',
  submit_by     TEXT, submit_at TEXT,
  review_by     TEXT, review_at TEXT,
  reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS learners (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar_text TEXT,
  color       TEXT,
  dept        TEXT,
  title       TEXT,
  onboard_at  TEXT,
  coach       TEXT,
  payload     TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id        TEXT PRIMARY KEY,
  code      TEXT,
  title     TEXT,
  scene_id  TEXT,
  pass_line INTEGER,
  due_at    TEXT,
  status    TEXT,
  created_at TEXT,
  payload   TEXT
);

/* 任务指派人（P4）：单列成表，才能按学员反查「我的任务」 */
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id    TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  PRIMARY KEY (task_id, learner_id)
);
CREATE INDEX IF NOT EXISTS idx_ta_learner ON task_assignees(learner_id);
CREATE INDEX IF NOT EXISTS idx_ta_task ON task_assignees(task_id);

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  task_id    TEXT,
  scene_id   TEXT,
  score      INTEGER,
  passed     INTEGER,
  at         TEXT,
  channel    TEXT,
  rubric_version TEXT,
  confidence REAL,
  dim_scores TEXT,                        -- JSON
  objectives TEXT,                        -- JSON
  evidence   TEXT,                        -- JSON：逐轮证据原话
  source     TEXT,                        -- llm | keyword-fallback
  payload    TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_learner ON records(learner_id);
CREATE INDEX IF NOT EXISTS idx_rec_scene ON records(scene_id);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL,               -- admin | operator | reviewer | coach | learner
  dept       TEXT,
  can_edit   INTEGER DEFAULT 0,           -- 是否可编辑场景
  can_review INTEGER DEFAULT 0            -- 是否可审核场景
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS rubric_versions (
  version    TEXT PRIMARY KEY,
  at         TEXT,
  by_user    TEXT,
  note       TEXT,
  payload    TEXT NOT NULL                -- 5 维锚点 + 权重 + prompt 片段
);

CREATE TABLE IF NOT EXISTS gold_set (
  id           TEXT PRIMARY KEY,
  scene_id     TEXT,
  turn_index   INTEGER,
  customer_text TEXT,
  learner_text TEXT,
  human_scores TEXT NOT NULL,             -- JSON：人工标注的 5 维分
  human_total  REAL,
  annotator    TEXT,
  note         TEXT
);

CREATE TABLE IF NOT EXISTS gold_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT,
  rubric_version TEXT,
  model       TEXT,
  n           INTEGER,
  pearson     REAL,
  mae         REAL,
  detail      TEXT                        -- JSON：逐条对比
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  task_id    TEXT,
  scene_id   TEXT,
  learner_id TEXT,
  channel    TEXT,
  turn       INTEGER DEFAULT 0,
  state      TEXT,                        -- JSON：五维累计分 / 目标达成
  started_at TEXT,
  ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS session_turns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  learner_text   TEXT,
  customer_reply TEXT,
  emotion        TEXT,
  dim_scores     TEXT,
  score          REAL,
  confidence     REAL,
  source         TEXT,
  at             TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_turn_sess ON session_turns(session_id);

-- P5：教练辅导记录（带教主管的核心动作，必须落库才算"留存"）
CREATE TABLE IF NOT EXISTS coach_notes (
  id         TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  record_id  TEXT,                        -- 针对哪一次练习（可空 = 泛泛记录）
  type       TEXT,                        -- 一对一辅导 / 电话回访 …
  text       TEXT NOT NULL,
  by_name    TEXT,                        -- 记录人展示名
  by_id      TEXT,
  at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_note_learner ON coach_notes(learner_id);

-- P5：对话质检结论（一条成绩记录一个结论）
CREATE TABLE IF NOT EXISTS record_qc (
  record_id  TEXT PRIMARY KEY,
  state      TEXT NOT NULL,               -- ok 通过 / flag 待统一话术
  note       TEXT,
  by_name    TEXT,
  by_id      TEXT,
  at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_qc_state ON record_qc(state);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`)

/* ------------------------------------------------------------------ *
 * 轻量迁移：老库补列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，先查后加）
 * ------------------------------------------------------------------ */
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn('users', 'account', 'TEXT');
ensureColumn('users', 'salt', 'TEXT');
ensureColumn('users', 'password_hash', 'TEXT');
ensureColumn('users', 'created_at', 'TEXT');
// P4：数据可见范围（all 全部 / dept 本部门 / mentor 本人带教）
ensureColumn('users', 'data_scope', "TEXT DEFAULT 'all'");
// P4：scope=mentor 时用于匹配 learners.coach 的值
ensureColumn('users', 'scope_ref', 'TEXT');
// P5：可匹配的「本人姓名」（如「周敏」）。
//   users.name 是带前缀的展示名（「区域教练 · 周敏」），拿它去匹配 learners.coach 永远匹配不上；
//   教练台要按姓名筛「我带的学员」，所以需要一个独立的、干净的姓名列。
ensureColumn('users', 'staff_name', 'TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account ON users(lower(account));');

// P4：任务业务列（老库补列，seed 时只写了主表字段）
ensureColumn('tasks', 'start_at', 'TEXT');
ensureColumn('tasks', 'created_by', 'TEXT');
ensureColumn('tasks', 'require_all', 'INTEGER DEFAULT 1');
ensureColumn('tasks', 'note', 'TEXT');
ensureColumn('tasks', 'channel', 'TEXT');

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function today() { return nowStamp().slice(0, 10); }
const J = (o) => JSON.stringify(o === undefined ? null : o);
const P = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } };

/* ------------------------------------------------------------------ *
 * 演示用户（播种与迁移共用一份定义）
 *   scope    : all 全量 / dept 仅本人部门 / mentor 仅本人带教学员
 *   scopeRef : scope=mentor 时用于匹配 learners.coach 的值（如「周敏」）
 *              因为 users.name 是带前缀的展示名（「区域教练 · 周敏」），
 *              直接用 name 匹配永远匹配不上，必须有独立的匹配值。
 * ------------------------------------------------------------------ */
const DEMO_USERS = [
  { id: 'U-ADMIN', name: '系统管理员', staff: '系统管理员', role: 'admin', dept: '培训运营组', canEdit: 1, canReview: 1, scope: 'all', scopeRef: '' },
  { id: 'U-OP01', name: '培训运营 · 王倩', staff: '王倩', role: 'operator', dept: '培训运营组', canEdit: 1, canReview: 0, scope: 'all', scopeRef: '' },
  { id: 'U-OP02', name: '培训运营 · 李萌', staff: '李萌', role: 'operator', dept: '连锁渠道事业部', canEdit: 1, canReview: 0, scope: 'dept', scopeRef: '' },
  { id: 'U-REV01', name: '带教主管 · 张涛', staff: '张涛', role: 'reviewer', dept: '连锁渠道事业部', canEdit: 0, canReview: 1, scope: 'all', scopeRef: '' },
  // 华东大区的两位教练：一个只能看本部门（陈曦），一个只能看自己名下带教（赵磊）
  // —— 刻意做成两种范围，用来演示 dept 与 mentor 的真实差别
  { id: 'U-COACH1', name: '区域教练 · 陈曦', staff: '陈曦', role: 'coach', dept: '华东大区', canEdit: 0, canReview: 0, scope: 'dept', scopeRef: '' },
  { id: 'U-COACH2', name: '区域教练 · 周敏', staff: '周敏', role: 'coach', dept: '连锁渠道事业部', canEdit: 0, canReview: 0, scope: 'mentor', scopeRef: '周敏' },
  { id: 'U-COACH3', name: '区域教练 · 赵磊', staff: '赵磊', role: 'coach', dept: '华东大区', canEdit: 0, canReview: 0, scope: 'mentor', scopeRef: '赵磊' }
];

function insertDemoUsers() {
  const ins = db.prepare(`INSERT OR IGNORE INTO users
    (id,name,staff_name,role,dept,can_edit,can_review,data_scope,scope_ref) VALUES (?,?,?,?,?,?,?,?,?)`);
  DEMO_USERS.forEach((u) => ins.run(u.id, u.name, u.staff || u.name, u.role, u.dept, u.canEdit, u.canReview, u.scope, u.scopeRef));
}

/* ------------------------------------------------------------------ *
 * P4 迁移：把老库补齐成「任务可查询 + 范围可判定」的形状
 *   1. tasks 业务列从 payload 回填
 *   2. task_assignees 为空时从 tasks.payload.assignees 反填
 *      —— 否则老库升级后所有任务的指派人数都是 0
 *   3. learners.coach 从 payload.mentor 回填
 *      —— 历史 bug：播种时读的是 l.coach，而 app-data.js 字段叫 mentor
 *   4. 补齐演示用户，并对齐 data_scope / scope_ref（用 meta 打标只跑一次，
 *      避免每次启动覆盖运维的手动调整）
 * ------------------------------------------------------------------ */
function migrateTasksP4() {
  let filled = 0; let assigned = 0; let mentors = 0;

  const rows = db.prepare('SELECT * FROM tasks').all();
  const upd = db.prepare(`UPDATE tasks SET start_at=?, created_by=?, require_all=?, note=?, channel=? WHERE id=?`);
  const insTA = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, learner_id) VALUES (?,?)');
  const taEmpty = db.prepare('SELECT COUNT(*) AS n FROM task_assignees').get().n === 0;

  rows.forEach((r) => {
    const p = P(r.payload, {}) || {};
    if (r.start_at == null && r.created_by == null && r.note == null) {
      upd.run(p.startAt || '', p.createdBy || '', p.requireAll === false ? 0 : 1, p.note || '', p.channel || '', r.id);
      filled++;
    }
    if (taEmpty) {
      (p.assignees || []).forEach((lid) => { if (lid) { insTA.run(r.id, String(lid)); assigned++; } });
    }
  });

  // learners.coach 回填（历史字段名不一致）
  const upLearner = db.prepare('UPDATE learners SET coach = ? WHERE id = ?');
  db.prepare('SELECT id, coach, payload FROM learners').all().forEach((l) => {
    const p = P(l.payload, {}) || {};
    const m = p.mentor || p.coach || '';
    if (!l.coach && m) { upLearner.run(String(m), l.id); mentors++; }
  });

  // 补齐演示账号 + 对齐数据范围：只在首次迁移时执行一次
  //   用 meta 打标，避免每次启动都写一遍（否则运维删掉的演示账号会被"复活"）
  let scoped = 0;
  const done = db.prepare("SELECT v FROM meta WHERE k = 'p4_scopes'").get();
  if (!done) {
    insertDemoUsers();
    const upScope = db.prepare('UPDATE users SET data_scope = ?, scope_ref = ? WHERE id = ?');
    DEMO_USERS.forEach((u) => {
      if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(u.id)) { upScope.run(u.scope, u.scopeRef, u.id); scoped++; }
    });
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('p4_scopes', nowStamp());
  }

  return { filled, assigned, mentors, scoped, tasks: rows.length };
}

const MIGRATED = migrateTasksP4();

/* ------------------------------------------------------------------ *
 * 演示用的辅导记录 / 质检结论（P5）
 *
 * 为什么单独抽一个函数：这两张表的内容原本只写在 seedIfEmpty() 里，
 * 而 seedIfEmpty() 对老库直接 return「已有数据」→ 老库升到 p5-v1 后
 * 教练台开箱是空白的。抽出来给 migrateP5() 也调一次。
 *
 * 幂等策略：**只要任一张表已有数据就整体跳过**。宁可少补，不能覆盖 ——
 * 运维删空过就说明他不想要演示内容，别"复活"它。
 *
 * 学员/成绩一律从**库里现查**（而不是读 app-data.js）：
 * 老库的 records 是历史播种+真实练习的混合，app-data.js 里的 id 未必都在。
 * 直接查库还能天然保证 record_qc.record_id 一定有对应成绩，不留孤儿结论。
 * ------------------------------------------------------------------ */
function seedDemoCoachContent() {
  const n0 = db.prepare('SELECT COUNT(*) AS n FROM coach_notes').get().n;
  const q0 = db.prepare('SELECT COUNT(*) AS n FROM record_qc').get().n;
  if (n0 > 0 || q0 > 0) return { coachNotes: 0, qcMarks: 0, contentSkipped: true };

  // 演示主角是「周敏」（U-COACH2 · mentor 范围）名下学员
  const ids = db.prepare('SELECT id FROM learners WHERE coach = ? ORDER BY id').all('周敏').map((r) => r.id);
  if (!ids.length) return { coachNotes: 0, qcMarks: 0, contentSkipped: true };

  // 每个学员只取最近一条成绩：若按「全局最近 3 条」取，会全落在同一个学员头上，
  // 演示时辅导记录/质检都挤在一个人身上，看不出"分层辅导"的意思
  const recs = [];
  ids.forEach((lid) => {
    const r = db.prepare('SELECT id FROM records WHERE learner_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(lid);
    if (r) recs.push({ id: r.id, learnerId: lid });
  });
  if (!recs.length) return { coachNotes: 0, qcMarks: 0, contentSkipped: true };

  const at = nowStamp();
  const insNote = db.prepare(`INSERT OR IGNORE INTO coach_notes
    (id,learner_id,record_id,type,text,by_name,by_id,at) VALUES (?,?,?,?,?,?,?,?)`);
  const insQc = db.prepare(`INSERT OR IGNORE INTO record_qc
    (record_id,state,note,by_name,by_id,at) VALUES (?,?,?,?,?,?)`);

  let coachNotes = 0;
  [
    '价格异议这一轮，学员直接报了个折扣价，没有先问清客户用量。下次重点练「先问后答」：先确认月度用量与配送频次，再给阶梯价。',
    '开场缺了自我介绍与来意说明，客户第一反应是防备。要求：开场三句内交代身份、来意、能给客户什么。'
  ].forEach((text, i) => {
    const r = recs[i];
    if (!r) return;
    insNote.run('N-SEED-0' + (i + 1), r.learnerId, r.id, '一对一辅导', text, '周敏', 'U-COACH2', at);
    coachNotes++;
  });

  let qcMarks = 0;
  [
    { state: 'flag', note: '客服承诺「48 小时必达」超出实际时效，需培训运营统一口径后重发。' },
    { state: 'ok', note: '' },
    { state: 'ok', note: '' }
  ].forEach((q, i) => {
    const r = recs[i];
    if (!r) return;
    insQc.run(r.id, q.state, q.note, '周敏', 'U-COACH2', at);
    qcMarks++;
  });

  return { coachNotes, qcMarks, contentSkipped: false };
}

/* ------------------------------------------------------------------ *
 * P5 迁移：让教练台真正可用（身份可匹配 + 辅导/质检可落库）
 *   1. users.staff_name 回填 —— 老库没有这一列，而教练台要按「干净姓名」
 *      筛「我带的学员」（users.name 带「区域教练 · 」前缀，匹配不上）
 *   2. 补齐演示账号（新增 U-COACH3 赵磊，华东大区 · mentor 范围）
 *   3. 补齐演示用的辅导记录 / 质检结论 —— 否则老库升到 P5 后教练台一片空白
 *      ⚠️ 一开始漏了这条：建表语句只建空表，而 seedIfEmpty() 对老库直接
 *      返回「已有数据」，于是 schema 升到 p5-v1 但教练台没内容。
 *      自测里表现为「带教账号可读辅导记录（0 条）」，很容易被当成正常。
 *   与 P4 同样的思路：用 meta 打标只跑一次，避免复活运维已删除的账号。
 * ------------------------------------------------------------------ */
function migrateP5() {
  let named = 0;
  const updStaff = db.prepare('UPDATE users SET staff_name = ? WHERE id = ?');
  db.prepare('SELECT id, name, staff_name FROM users').all().forEach((u) => {
    if (u.staff_name) return;
    const def = DEMO_USERS.filter((d) => d.id === u.id)[0];
    // 兜底：按「 · 」取后缀，与 DEMO_USERS 的命名约定一致
    const plain = (def && def.staff) || String(u.name || '').split(' · ').pop() || u.name || '';
    updStaff.run(plain, u.id);
    named++;
  });

  let added = 0;
  const done = db.prepare("SELECT v FROM meta WHERE k = 'p5_coach'").get();
  if (!done) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    insertDemoUsers();   // INSERT OR IGNORE：老库只会补进缺失的 U-COACH3
    added = db.prepare('SELECT COUNT(*) AS n FROM users').get().n - before;
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('p5_coach', nowStamp());
  }

  // 演示内容：全新库此刻还没有学员（seedIfEmpty 晚于本函数），会安全跳过并留待播种阶段写入
  const content = seedDemoCoachContent();
  return { named, added, ...content };
}

const MIGRATED_P5 = migrateP5();

/* ================================================================== *
 * P7：逐轮对话（演示数据的构造规则）
 *
 * 为什么需要「造」对话：演示库的 28 条成绩全部来自 app-data.js 播种，
 * 而播种只写成绩单（分数/维度）——**一条逐轮对话都没有**（实测 0/28）。
 * 于是教练台的「逐轮复盘」只能拿场景剧本来凑，看到的是"客户说了什么"，
 * 看不到"学员答了什么"，而对话质检本身就叫「对话质检」。
 *
 * ⚠️ 口径必须**精确**一致，这是本函数最容易做错的地方：
 *   finish() 的聚合方式是「逐轮求算术平均再四舍五入」。
 *   如果逐轮分随手给一组"看起来差不多"的数，就会出现
 *   「逐轮均分 72，但这条成绩写着 58」——而教练台会把两者并排显示。
 *   所以这里用「余数分摊」把每一维的逐轮分**强行凑到 sum === 目标分 × 轮数**，
 *   使得 round(mean(逐轮)) 恒等于成绩单上的数（含 5 个维度）。
 * ================================================================== */

/** 确定性伪随机 [0,1)：同一 id 每次跑出同一组数据，保证播种幂等可复现 */
function rnd01(seed) {
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * 把总分 target 摊成 n 个整数，**保证 sum 精确等于 target*n**（即均值恰为 target）。
 * 先围绕均值抖动出"有起伏"的一组，再用 ±1 逐次把差值平回去。
 * 一定能收敛：sum < target*n 时必有元素 < 100，反之必有元素 > 0。
 */
function spreadExact(target, n, seed) {
  const mean = Math.max(0, Math.min(100, Math.round(target || 0)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const jitter = (rnd01(seed + ':' + i) * 2 - 1) * 9;   // ±9 的起伏
    out.push(Math.max(0, Math.min(100, Math.round(mean + jitter))));
  }
  let diff = mean * n - out.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard++ < 10000) {
    const step = diff > 0 ? 1 : -1;
    for (let i = 0; i < n && diff !== 0; i++) {
      const cand = out[i] + step;
      if (cand < 0 || cand > 100) continue;
      out[i] = cand;
      diff -= step;
    }
  }
  return out;
}

/** 客户情绪：由**本轮得分**反推。演示数据必须无随机分支，否则每次开页面都在变 */
function emotionOf(score) {
  if (score >= 75) return '认可';
  if (score >= 65) return '缓和';
  if (score >= 55) return '中性';
  if (score >= 45) return '疑虑';
  return '不满';
}

/** '2026-09-27 10:12' + m 分钟（演示轮次时间要一条条往后走，不能全同一秒） */
function shiftMinutes(stamp, m) {
  const s = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!s) return stamp || '';
  const d = new Date(Date.UTC(+s[1], +s[2] - 1, +s[3], +s[4], +s[5]));
  d.setUTCMinutes(d.getUTCMinutes() + m);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 低分轮次的学员台词池。
 * 刻意**不取自场景 voicePool**（那是"参考表达"），且必须一眼看出问题，
 * 教练才能在逐轮复盘里直接指着说「这一轮你等于没接话」。
 */
const WEAK_LINES = [
  '好的好的，我知道了。',
  '行，那我再跟您联系。',
  '这个……我回去问一下再答复您。',
  '嗯嗯，您说得对。',
  '好的，那我先这样，不打扰您了。',
  '不好意思，这个我也不太清楚。',
  '我先记下来吧。'
];

/**
 * 逐轮对话播种（幂等）
 *
 * 只填 `source='seed'` 且 evidence 为空的成绩——这是**精确闸门**：
 * 真实练习产生的成绩 source 是 'llm' / 'local'，一行都不会被改写。
 * 否则就会拿"编造的对话"去覆盖学员真实作答，那是数据事故不是演示数据。
 */
function seedDemoDialogues() {
  const rows = db.prepare(`SELECT id,scene_id,score,dim_scores,at,source,payload FROM records
    WHERE source = 'seed' AND (evidence IS NULL OR evidence = '' OR evidence = '[]')`).all();
  if (!rows.length) return { dialogues: 0, dialogueSkipped: true };

  const upd = db.prepare('UPDATE records SET evidence = ? WHERE id = ?');
  let filled = 0;
  let skipped = 0;

  rows.forEach((rec) => {
    const scene = db.prepare('SELECT payload FROM scenes WHERE id = ?').get(rec.scene_id);
    const sc = P(scene && scene.payload, null);
    if (!sc || !Array.isArray(sc.script) || !sc.script.length) { skipped++; return; }

    // 轮数以成绩单自己的 payload.turns 为准（5 或 6），**不是** script.length：
    // 场景剧本 6 轮而目标 5 条，两者本来就不相等（见 MEMORY 的「轮次≠目标数」）。
    const pl = P(rec.payload, {}) || {};
    const n = Math.max(1, Math.min(Number(pl.turns) || sc.script.length, 20));

    const total = spreadExact(rec.score, n, rec.id + ':total');
    const dims = P(rec.dim_scores, {}) || {};
    const dimIds = ['d1', 'd2', 'd3', 'd4', 'd5'];
    // 每一维单独分摊：保证该维逐轮均值也精确等于成绩单上的维度分
    const perDim = {};
    dimIds.forEach((d) => { perDim[d] = spreadExact(dims[d], n, rec.id + ':' + d); });

    const base = rec.at || nowStamp();
    const turns = [];
    for (let i = 0; i < n; i++) {
      const s = sc.script[Math.min(i, sc.script.length - 1)] || {};
      const pool = (sc.voicePool && sc.voicePool[Math.min(i, sc.voicePool.length - 1)]) || [];
      // 低于本条的均分 → 用"敷衍话术"演示弱轮次；否则用场景给的参考表达
      const weak = total[i] < rec.score;
      let learnerText;
      if (weak || !pool.length) {
        learnerText = WEAK_LINES[Math.floor(rnd01(rec.id + ':weak:' + i) * WEAK_LINES.length)];
      } else {
        learnerText = pool[Math.floor(rnd01(rec.id + ':good:' + i) * pool.length)];
      }
      const ds = {};
      dimIds.forEach((d) => { ds[d] = perDim[d][i]; });
      turns.push({
        idx: i + 1,
        learnerText: learnerText,
        customerReply: s.t || '',
        emotion: emotionOf(total[i]),
        score: total[i],
        dimScores: ds,
        confidence: 1,
        source: 'seed',
        at: shiftMinutes(base, i * 2)
      });
    }
    upd.run(J(turns), rec.id);
    filled++;
  });

  return { dialogues: filled, dialogueSkipped: skipped > 0 && filled === 0 };
}

/* ------------------------------------------------------------------ *
 * P7 迁移
 *   老库升级：把演示成绩补上逐轮对话（否则教练台/质检点开是一片空白，
 *   而这两个界面的价值恰恰全在对话本身）。
 *   与 P5 完全同构的坑：建表 ≠ 迁数据，seedIfEmpty() 对老库直接返回，
 *   所以必须在这里单独补一次；全新库则由 seedIfEmpty() 自己调用。
 * ------------------------------------------------------------------ */
function migrateP7() {
  return seedDemoDialogues();
}

const MIGRATED_P7 = migrateP7();
db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('schema', 'p7-v1');

/* ------------------------------------------------------------------ *
 * 种子数据：从 data/app-data.js 导入（仅当表为空时执行一次）
 * ------------------------------------------------------------------ */
function loadAppData() {
  // app-data.js 是浏览器脚本，挂 window；用 sandbox 取出 TRAIN
  const code = fs.readFileSync(path.join(config.root, 'data', 'app-data.js'), 'utf8');
  const sandbox = { window: {}, console: { log() {} } };
  const fn = new Function('window', 'console', code + '\nreturn window.TRAIN;');
  return fn(sandbox.window, sandbox.console);
}

function seedIfEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM scenes').get();
  if (row && row.n > 0) return { seeded: false, reason: '已有数据' };

  const T = loadAppData();
  const byUser = (T.meta && T.meta.owner) || '培训运营组';
  const at = nowStamp();

  const insScene = db.prepare(`INSERT INTO scenes
    (id,code,name,subtitle,avatar_text,color,task_name,channel,category,difficulty,
     pass_line,duration,status,publish,owner,updated_at,brief,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insVer = db.prepare(`INSERT INTO scene_versions (scene_id,v,at,by_user,note,snapshot) VALUES (?,?,?,?,?,?)`);
  const insAudit = db.prepare(`INSERT INTO scene_audit (scene_id,status,submit_by,submit_at,review_by,review_at,reject_reason) VALUES (?,?,?,?,?,?,?)`);

  (T.scenes || []).forEach((s) => {
    insScene.run(
      s.id, s.code || '', s.name, s.subtitle || '', s.avatarText || '', s.color || '#5B8FF9',
      s.taskName || '', s.channel || '', s.category || '', s.difficulty || '',
      s.passLine || 0, s.duration || 0, s.status || 'active', 'published',
      s.owner || byUser, s.updatedAt || today(), s.brief || '', J(s)
    );
    // 初始版本：v1 = 场景初始内容
    insVer.run(s.id, 1, at, byUser, '初始导入', J(s));
    insAudit.run(s.id, 'published', byUser, at, byUser, at, '');
  });

  const insLearner = db.prepare(`INSERT INTO learners
    (id,name,avatar_text,color,dept,title,onboard_at,coach,payload) VALUES (?,?,?,?,?,?,?,?,?)`);
  (T.learners || []).forEach((l) => {
    // ⚠️ app-data.js 里字段叫 mentor（导师），不是 coach —— 早期这里读 l.coach 导致
    //    该列一直为空，按带教关系做数据范围判定时会永远匹配不到人。
    insLearner.run(l.id, l.name, l.avatarText || '', l.color || '', l.dept || '',
      l.title || l.position || '', l.onboardAt || l.joinDate || '', l.mentor || l.coach || '', J(l));
  });

  const insTask = db.prepare(`INSERT INTO tasks
    (id,code,title,scene_id,pass_line,due_at,status,created_at,payload,
     start_at,created_by,require_all,note,channel) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insTA = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id,learner_id) VALUES (?,?)');
  (T.tasks || []).forEach((t) => {
    insTask.run(t.id, t.code || '', t.title || '', t.sceneId || '', t.passLine || 0,
      t.dueAt || '', t.status || '', t.createdAt || today(), J(t),
      t.startAt || '', t.createdBy || byUser, t.requireAll === false ? 0 : 1, t.note || '', t.channel || '');
    (t.assignees || []).forEach((lid) => { if (lid) insTA.run(t.id, String(lid)); });
  });

  const insRec = db.prepare(`INSERT INTO records
    (id,learner_id,task_id,scene_id,score,passed,at,channel,rubric_version,confidence,
     dim_scores,objectives,evidence,source,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  (T.records || []).forEach((r) => {
    insRec.run(r.id, r.learnerId, r.taskId || '', r.sceneId || '', r.score || 0,
      r.passed ? 1 : 0, r.at || '', r.channel || 'text', config.rubricVersion, 1,
      J(r.dimScores || {}), J(r.objectives || []), J([]), 'seed', J(r));
  });

  // 用户：覆盖四种角色 + 三种数据范围，演示权限与可见范围差异
  // ⚠️ 必须用 OR IGNORE：migrateTasksP4() 在模块加载时已经插过一遍演示账号
  //    （它是为了给老库补 U-COACH2），全新库首启时这里不能再撞 UNIQUE 约束。
  insertDemoUsers();

  // P5：示范辅导记录与质检结论 —— 让教练台开箱就有内容（而不是一进去全是空白）
  // 与老库升级共用同一份实现，见 seedDemoCoachContent()
  const coachContent = seedDemoCoachContent();

  // P7：给刚播下去的成绩补逐轮对话。**必须在这里调一次**：
  // migrateP7() 在模块加载时跑，那会儿全新库还没有成绩（seedIfEmpty 晚于它），
  // 只能安全跳过 —— 与 P5 的坑逐字相同。
  const dialogues = seedDemoDialogues();

  // Rubric v1：5 维锚点
  const rubric = {
    version: config.rubricVersion,
    dims: (T.dims || []).map((d) => ({
      id: d.id, name: d.name, weight: d.weight, desc: d.desc || '',
      anchorHigh: '',   // 运行时由 rubric.js 补全
      anchorLow: ''
    }))
  };
  db.prepare('INSERT OR REPLACE INTO rubric_versions (version,at,by_user,note,payload) VALUES (?,?,?,?,?)')
    .run(config.rubricVersion, at, byUser, '初始 Rubric（5 维权重取自 TRAIN.dims）', J(rubric));

  db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('seeded_at', at);
  db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('schema', 'p7-v1');

  // 金标集：从 store/goldset-seed.json 导入人工标注样本（供校准开箱可用）
  let goldCount = 0;
  try {
    const p = path.join(__dirname, 'store', 'goldset-seed.json');
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const items = raw.items || raw || [];
      const insGold = db.prepare(`INSERT INTO gold_set
        (id,scene_id,turn_index,customer_text,learner_text,human_scores,human_total,annotator,note)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      items.forEach((g) => {
        const hs = g.humanScores || {};
        const total = g.humanTotal != null ? g.humanTotal
          : Math.round((hs.d1 || 0) * 0.15 + (hs.d2 || 0) * 0.25 + (hs.d3 || 0) * 0.25 + (hs.d4 || 0) * 0.2 + (hs.d5 || 0) * 0.15);
        insGold.run(g.id, g.sceneId || '', g.turnIndex || 1, g.customerText || '', g.learnerText || '',
          J(hs), total, g.annotator || '双盲均值', g.note || '');
        goldCount++;
      });
    }
  } catch (e) {
    console.warn('[db] 金标集播种失败：' + e.message);
  }

  return {
    seeded: true,
    scenes: (T.scenes || []).length,
    learners: (T.learners || []).length,
    tasks: (T.tasks || []).length,
    records: (T.records || []).length,
    goldSet: goldCount,
    coachNotes: coachContent.coachNotes,
    qcMarks: coachContent.qcMarks,
    dialogues: dialogues.dialogues
  };
}

/* ------------------------------------------------------------------ *
 * 审计日志
 * ------------------------------------------------------------------ */
function log(userId, action, target, detail) {
  db.prepare('INSERT INTO audit_log (at,user_id,action,target,detail) VALUES (?,?,?,?,?)')
    .run(nowStamp(), userId || 'system', action, target || '', detail ? String(detail) : '');
}

/**
 * 数据范围的用户可读说明（纯函数，无依赖；auth / service 共用同一份文案）
 * 入参可以是数据库行（data_scope/dept/scope_ref）或已转换对象（scope/dept/scopeRef）
 */
function scopeLabel(u) {
  if (!u) return '—';
  const kind = u.data_scope || u.scope || 'all';
  const dept = u.dept || '';
  const ref = u.scope_ref || u.scopeRef || '';
  if (kind === 'dept') return '本部数据 · ' + (dept || '未设部门');
  if (kind === 'mentor') return '本人带教 · ' + (ref || '未绑定导师名');
  return '全部数据';
}

/* ------------------------------------------------------------------ *
 * 行 → 对象（把 payload JSON 摊平回领域对象）
 * ------------------------------------------------------------------ */
function sceneRow(r) {
  if (!r) return null;
  const base = P(r.payload, {}) || {};
  return Object.assign({}, base, {
    id: r.id, code: r.code, name: r.name, subtitle: r.subtitle,
    avatarText: r.avatar_text, color: r.color, taskName: r.task_name,
    channel: r.channel, category: r.category, difficulty: r.difficulty,
    passLine: r.pass_line, duration: r.duration, status: r.status,
    publish: r.publish, owner: r.owner, updatedAt: r.updated_at, brief: r.brief
  });
}

module.exports = { db, pragmas, seedIfEmpty, loadAppData, log, sceneRow, scopeLabel, nowStamp, today, J, P, migrateTasksP4, MIGRATED, migrateP5, MIGRATED_P5, seedDemoCoachContent,
  // spreadExact 导出给自测：分摊算法的「精度」是 P7 的验收核心，
  // 必须能脱离数据库单独断言（sum === target*n 对任意 target/n 都成立）
  migrateP7, MIGRATED_P7, seedDemoDialogues, spreadExact };
