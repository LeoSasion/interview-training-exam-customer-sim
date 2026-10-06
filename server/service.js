'use strict';
/**
 * 业务服务层
 *  - 会话（session / turn / finish）：一轮对话 → 评分 → 落库 Records
 *  - 场景库（CRUD / 版本 / 审批 / 权限校验 / 审计）
 *  - 金标集（导入 / 校准跑批 / 一致性报告）
 *
 * 所有写操作都会写 audit_log。
 */

const dbm = require('./db');
const { db, log, sceneRow, nowStamp, today, J, P } = dbm;
const ai = require('./ai');
const config = require('./config');

/* ================================================================== *
 * 用户与权限
 * ================================================================== */
function getUser(userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

/**
 * 取操作人。
 * ⚠️ 这里**不再回落到管理员**——身份由路由层（server/auth.js）解析后写入
 *    body.userId / query.userId 传入。解析不到就是 401，避免"漏传 userId
 *    即获得超管权限"的越权口子。
 */
function requireUser(userId) {
  const u = getUser(userId);
  if (!u) throw Object.assign(new Error('未登录或登录状态已失效'), { status: 401 });
  return u;
}

function assertCanEdit(user) {
  if (!user.can_edit && user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无场景编辑权限`), { status: 403 });
  }
}

function assertCanReview(user, sceneId) {
  if (!user.can_review && user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无审核权限`), { status: 403 });
  }
  // 审核角色分离：提交人不能审自己提交的内容
  const au = db.prepare('SELECT * FROM scene_audit WHERE scene_id = ?').get(sceneId);
  if (au && au.submit_by && au.submit_by === user.name) {
    throw Object.assign(new Error('审核角色分离：提交人不能审核自己提交的场景'), { status: 403 });
  }
}

/* ================================================================== *
 * 数据可见范围（P4）
 *   users.data_scope: all 全量 / dept 仅本部门 / mentor 仅本人带教
 *   users.scope_ref : scope=mentor 时匹配 learners.coach 的值
 *   —— 统一出口 scopedLearnerIds(user)：返回 null 表示不限制
 * ================================================================== */
function scopeOf(user) {
  const kind = (user && user.data_scope) || 'all';
  return {
    kind,
    dept: (user && user.dept) || '',
    ref: (user && user.scope_ref) || '',
    label: kind === 'all' ? '全部数据'
      : kind === 'dept' ? `本部数据 · ${(user && user.dept) || '未设部门'}`
        : kind === 'mentor' ? `本人带教 · ${(user && user.scope_ref) || '未绑定导师名'}`
          : '全部数据'
  };
}

// 学员集合变动不频繁，做 5 秒进程内缓存，避免每次查询都打库
const _scopeCache = new Map();
function scopedLearnerIds(user) {
  const sc = scopeOf(user);
  if (sc.kind === 'all') return null;
  const key = `${sc.kind}|${sc.dept}|${sc.ref}`;
  const hit = _scopeCache.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.ids;

  let ids = [];
  if (sc.kind === 'dept') {
    if (sc.dept) ids = db.prepare('SELECT id FROM learners WHERE dept = ?').all(sc.dept).map((r) => r.id);
  } else if (sc.kind === 'mentor') {
    if (sc.ref) ids = db.prepare('SELECT id FROM learners WHERE coach = ?').all(sc.ref).map((r) => r.id);
  } else {
    // 未知范围类型按最保守处理：什么都看不到（而不是误放行）
    ids = [];
  }
  _scopeCache.set(key, { at: Date.now(), ids });
  return ids;
}

function inScope(user, learnerId) {
  const ids = scopedLearnerIds(user);
  return ids === null || ids.indexOf(String(learnerId)) !== -1;
}

/* ================================================================== *
 * 任务（P4）：下发 / 改期 / 改线 / 结束 / 删除
 *   指派关系落在 task_assignees，才能按学员反查「我的任务」。
 * ================================================================== */
function assertCanAssignTask(user) {
  // 任务下发属于内容运营动作，与场景编辑同权限
  if (!user.can_edit && user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无任务下发权限`), { status: 403 });
  }
}

function nextTaskCode() {
  const todayKey = nowStamp().slice(0, 10).replace(/-/g, '');
  const prefix = 'RW-' + todayKey + '-';
  const r = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE code LIKE ?').get(prefix + '%');
  return prefix + String((r ? r.n : 0) + 1).padStart(2, '0');
}

function assigneesOf(taskId) {
  if (taskId == null || taskId === '') return [];
  return db.prepare('SELECT learner_id FROM task_assignees WHERE task_id = ? ORDER BY learner_id')
    .all(String(taskId)).map((r) => r.learner_id);
}

function taskRow(r) {
  if (!r) return null;
  const base = P(r.payload, {}) || {};
  return Object.assign({}, base, {
    id: r.id, code: r.code, title: r.title, sceneId: r.scene_id,
    passLine: r.pass_line, dueAt: r.due_at, status: r.status,
    createdAt: r.created_at || base.createdAt || '',
    startAt: r.start_at || base.startAt || '',
    createdBy: r.created_by || base.createdBy || '',
    requireAll: r.require_all == null ? base.requireAll !== false : !!r.require_all,
    note: r.note != null ? r.note : (base.note || '')
  });
}

function getTask(id) {
  if (id === undefined || id === null || id === '') return null;
  const t = taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id)));
  if (!t) return null;
  t.assignees = assigneesOf(id);
  // 与 listTasks 保持同一形状：单条任务也要带 progress，
  // 否则「下发后立刻读回单个任务」拿不到进度（自测就是这样抓到的）
  t.progress = taskProgressOf(id, t.assignees, t.dueAt);
  return t;
}

/** 任务进度：以服务端记录为准（与前端 helpers.taskProgress 口径一致） */
function taskProgressOf(taskId, assignees, dueAt) {
  const list = assignees || assigneesOf(taskId);
  const rows = db.prepare('SELECT learner_id, score, passed, at FROM records WHERE task_id = ? ORDER BY at').all(String(taskId));
  const latest = {};
  rows.forEach((r) => { latest[r.learner_id] = r; });
  const done = list.filter((lid) => latest[lid]);
  const passed = done.filter((lid) => latest[lid].passed);
  const scores = done.map((lid) => latest[lid].score || 0);
  const due = dueAt !== undefined ? dueAt : dueOf(taskId);
  const dueMs = due ? Date.parse(String(due).replace(/-/g, '/')) : 0;
  return {
    total: list.length,
    finishedCount: done.length,
    passedCount: passed.length,
    overdueCount: list.filter((lid) => !latest[lid] && dueMs && Date.now() > dueMs).length,
    avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    rate: list.length ? Math.round(done.length / list.length * 100) : 0,
    passRate: done.length ? Math.round(passed.length / done.length * 100) : 0,
    doneIds: done
  };
}

function dueOf(taskId) {
  const t = db.prepare('SELECT due_at FROM tasks WHERE id = ?').get(String(taskId));
  return t ? t.due_at : '';
}

/**
 * 查询任务
 * @param {object} query  支持 learnerId（学员端「我的任务」）、status、sceneId
 * @param {object} user   操作人；非 all 范围只返回指派给其可见学员的任务
 * @param {boolean} mineOnly  learnerId 传入时是否只返回指派给该学员的任务
 */
function listTasks(query, user, mineOnly) {
  query = query || {};
  let rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC').all().map(taskRow);

  if (query.status) rows = rows.filter((t) => t.status === query.status);
  if (query.sceneId) rows = rows.filter((t) => t.sceneId === query.sceneId);

  // 学员端：只看得到派给自己的、且已下发的任务
  if (mineOnly && query.learnerId) {
    const lid = String(query.learnerId);
    rows = rows.filter((t) => t.status !== 'draft' && assigneesOf(t.id).indexOf(lid) !== -1);
  }

  const scopeIds = user ? scopedLearnerIds(user) : null;
  return rows.map((t) => {
    let assignees = assigneesOf(t.id);
    if (scopeIds !== null) assignees = assignees.filter((x) => scopeIds.indexOf(x) !== -1);
    return Object.assign(t, {
      assignees,
      progress: taskProgressOf(t.id, assignees, t.dueAt),
      visibleAssignees: assignees.length,
      totalAssignees: assigneesOf(t.id).length
    });
  }).filter((t) => scopeIds === null || t.assignees.length > 0 || t.totalAssignees === 0);
}

/** 新建 / 更新任务（下发） */
function saveTask(input, userId) {
  const user = requireUser(userId);
  assertCanAssignTask(user);

  const cur = getTask(input.id);
  const isNew = !cur;
  const title = String(input.title || (cur && cur.title) || '').trim();
  const sceneId = String(input.sceneId || (cur && cur.sceneId) || '');
  const assignees = (input.assignees || (cur && cur.assignees) || []).map(String).filter(Boolean);

  // 校验：与前端同一套规则，服务端必须再验一遍
  const bad = [];
  if (!title) bad.push('任务名称不能为空');
  if (!sceneId) bad.push('必须选择训练场景');
  const scene = getScene(sceneId);
  if (sceneId && !scene) bad.push('训练场景不存在');
  if (scene && !isNew && scene.publish !== 'published' && cur.sceneId !== sceneId) bad.push('只能下发已发布场景');
  if (isNew && scene && scene.publish !== 'published') bad.push('只能下发已发布场景（当前场景尚未审核通过）');
  if (!assignees.length) bad.push('至少选择 1 名学员');
  const unknown = assignees.filter((lid) => !db.prepare('SELECT 1 FROM learners WHERE id = ?').get(lid));
  if (unknown.length) bad.push(`学员不存在：${unknown.join('、')}`);
  if (bad.length) throw Object.assign(new Error('校验未通过：' + bad.join('；')), { status: 400 });

  const passLine = Number(input.passLine != null ? input.passLine : (cur ? cur.passLine : scene.passLine)) || 0;
  if (!(passLine >= 0 && passLine <= 100)) {
    throw Object.assign(new Error('校验未通过：达标线需在 0–100 之间'), { status: 400 });
  }

  const id = input.id || ('TN' + Date.now());
  const at = nowStamp();
  const rec = {
    id, code: input.code || (cur && cur.code) || nextTaskCode(),
    title, sceneId,
    passLine,
    dueAt: input.dueAt || (cur && cur.dueAt) || '',
    startAt: input.startAt || (cur && cur.startAt) || at,
    createdAt: (cur && cur.createdAt) || at,
    createdBy: (cur && cur.createdBy) || user.name,
    requireAll: input.requireAll != null ? !!input.requireAll : (cur ? cur.requireAll : true),
    status: input.status || (cur && cur.status) || 'running',
    note: input.note != null ? String(input.note) : ((cur && cur.note) || ''),
    assignees
  };

  db.prepare(`INSERT INTO tasks
    (id,code,title,scene_id,pass_line,due_at,status,created_at,payload,
     start_at,created_by,require_all,note,channel)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      code=excluded.code, title=excluded.title, scene_id=excluded.scene_id,
      pass_line=excluded.pass_line, due_at=excluded.due_at, status=excluded.status,
      payload=excluded.payload, start_at=excluded.start_at, created_by=excluded.created_by,
      require_all=excluded.require_all, note=excluded.note, channel=excluded.channel`)
    .run(rec.id, rec.code, rec.title, rec.sceneId, rec.passLine, rec.dueAt, rec.status,
      rec.createdAt, J(rec), rec.startAt, rec.createdBy, rec.requireAll ? 1 : 0, rec.note, scene ? scene.channel : '');

  // 指派关系：整表替换（简单、可预期；任务指派规模很小）
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(rec.id);
  const insTA = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, learner_id) VALUES (?,?)');
  rec.assignees.forEach((lid) => insTA.run(rec.id, lid));

  log(user.id, isNew ? 'task.assign' : 'task.update', rec.id,
    `${rec.title} → ${rec.assignees.length} 人${isNew ? '（新下发）' : ''}`);
  return getTask(rec.id);
}

/** 改任务状态：running / finished / draft（draft = 收回未下发） */
const TASK_STATUS = ['running', 'finished', 'draft'];

function setTaskStatus(id, status, userId) {
  const user = requireUser(userId);
  assertCanAssignTask(user);
  const t = getTask(id);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (TASK_STATUS.indexOf(status) === -1) {
    throw Object.assign(new Error(`状态只能是 ${TASK_STATUS.join(' / ')}`), { status: 400 });
  }
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, String(id));
  const label = { running: '进行中', finished: '已结束', draft: '已收回' }[status];
  log(user.id, 'task.status', String(id), `${t.title} → ${label}`);
  return getTask(id);
}

function deleteTask(id, userId) {
  const user = requireUser(userId);
  assertCanAssignTask(user);
  const t = getTask(id);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(String(id));
  db.prepare('DELETE FROM tasks WHERE id = ?').run(String(id));
  log(user.id, 'task.delete', String(id), t.title);
  return { ok: true };
}

/* ================================================================== *
 * 场景库
 * ================================================================== */
function listScenes(query) {
  let rows = db.prepare('SELECT * FROM scenes ORDER BY id').all().map(sceneRow);
  if (query && query.publish) rows = rows.filter((s) => s.publish === query.publish);
  if (query && query.assignable === '1') rows = rows.filter((s) => s.publish === 'published');
  return rows.map((s) => Object.assign(s, {
    audit: auditOf(s.id),
    versions: countVersions(s.id)
  }));
}

/* ------------------------------------------------------------------ *
 * 学员端场景池（P6）：练习通道可匿名读取，但**只给已发布**场景。
 *
 * 为什么需要它：学员端原先只读页面加载时的 window.SCENES（静态 app-data.js），
 * 所以运营在剧本编辑器里新建/改动的场景，学员**刷新也拿不到**——
 * 「下发 → 学员练」这条 P4 闭环对新场景是断的。
 *
 * 两个刻意的收口：
 *   1. 只返回 publish==='published'。下线会把 publish 置为 'offline'，
 *      所以草稿 / 待审 / 已下线都天然拿不到。
 *   2. 只返回学员真的要用的字段，**不带 audit / versions / owner / publish**——
 *      这是匿名接口，不该把审阅人、版本数、发布状态这些运营信息漏出去。
 * ------------------------------------------------------------------ */
function sceneForLearner(s) {
  return {
    id: s.id, code: s.code, name: s.name, subtitle: s.subtitle || '',
    avatarText: s.avatarText || (s.name || '?').slice(0, 1),
    color: s.color || '#5B8FF9',
    taskName: s.taskName || '', channel: s.channel || '',
    category: s.category || '', difficulty: s.difficulty || '',
    passLine: s.passLine || 0, duration: s.duration || 0,
    // 会话列表的展示字段（学员端沿用旧形状）
    last: s.last || '', time: s.time || '', unread: s.unread || 0,
    // 训练内容：没有这些的场景是不可训练的
    script: s.script || [], tips: s.tips || [],
    objectives: s.objectives || [], voicePool: s.voicePool || []
  };
}

function listPublishedScenes() {
  return db.prepare("SELECT * FROM scenes WHERE publish = 'published' ORDER BY id").all()
    .map(sceneRow).map(sceneForLearner);
}

function auditOf(sceneId) {
  if (sceneId == null || sceneId === '') {
    return { status: 'draft', submitBy: '', submitAt: '', reviewBy: '', reviewAt: '', rejectReason: '' };
  }
  const a = db.prepare('SELECT * FROM scene_audit WHERE scene_id = ?').get(String(sceneId));
  if (!a) return { status: 'draft', submitBy: '', submitAt: '', reviewBy: '', reviewAt: '', rejectReason: '' };
  return {
    status: a.status,
    submitBy: a.submit_by || '', submitAt: a.submit_at || '',
    reviewBy: a.review_by || '', reviewAt: a.review_at || '',
    rejectReason: a.reject_reason || ''
  };
}

function countVersions(sceneId) {
  if (sceneId == null || sceneId === '') return 0;
  const r = db.prepare('SELECT COUNT(*) AS n FROM scene_versions WHERE scene_id = ?').get(String(sceneId));
  return r ? r.n : 0;
}

function getScene(id) {
  // ⚠️ node:sqlite 不接受 undefined 作为绑定值（与 better-sqlite3 行为不同），
  // 新建场景时 input.id 为空会走到这里，必须显式判空。
  if (id === undefined || id === null || id === '') return null;
  const s = sceneRow(db.prepare('SELECT * FROM scenes WHERE id = ?').get(String(id)));
  if (!s) return null;
  s.audit = auditOf(id);
  s.versions = countVersions(id);
  return s;
}

function canAssign(sceneId) {
  if (sceneId == null || sceneId === '') return false;
  const s = db.prepare('SELECT publish FROM scenes WHERE id = ?').get(String(sceneId));
  return !!s && s.publish === 'published';
}

/** 校验场景（与前端编辑器同一套规则，服务端必须再验一遍） */
function validateScene(s) {
  const out = [];
  const push = (lv, msg) => out.push({ lv, msg });
  if (!s.name || !String(s.name).trim()) push('bad', '场景名称不能为空');
  if (!s.brief || String(s.brief).trim().length < 10) push('warn', '场景简介过短（建议 ≥ 10 字）');
  if (!(s.passLine >= 0 && s.passLine <= 100)) push('bad', '达标线需在 0–100 之间');
  if (!s.objectives || !s.objectives.length) push('bad', '至少需要 1 条训练目标');
  else {
    const empty = s.objectives.filter((o) => !o.text || !String(o.text).trim()).length;
    if (empty) push('bad', `有 ${empty} 条训练目标内容为空`);
  }
  if (!s.script || !s.script.length) push('bad', '至少需要 1 轮客户台词');
  else {
    const e = s.script.filter((x) => !x.t || !String(x.t).trim()).length;
    if (e) push('bad', `有 ${e} 轮客户台词为空`);
  }
  if (s.objectives && s.script && s.objectives.length !== s.script.length) {
    push('warn', `训练目标 ${s.objectives.length} 条 vs 剧本 ${s.script.length} 轮，两者不等时多出的目标不会被考察`);
  }
  if (!s.voicePool || !s.voicePool.length) push('warn', '未配置语音脚本池');
  return out;
}

function nextSceneSeq() {
  const r = db.prepare("SELECT v FROM meta WHERE k = 'scene_seq'").get();
  let n = r ? parseInt(r.v, 10) : 4;
  for (;;) {
    const id = 'SC' + String(n).padStart(2, '0');
    if (!db.prepare('SELECT 1 FROM scenes WHERE id = ?').get(id)) {
      db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('scene_seq', String(n + 1));
      return id;
    }
    n++;
  }
}

/**
 * 保存场景：写主表 + 归档版本 + 已发布场景自动回待审
 * @returns {object} 保存后的场景
 */
function saveScene(input, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);

  const cur = getScene(input.id);
  const isNew = !cur;

  const v = validateScene(input);
  const bad = v.filter((x) => x.lv === 'bad');
  if (bad.length) {
    throw Object.assign(new Error('校验未通过：' + bad.map((b) => b.msg).join('；')), { status: 400, validate: v });
  }

  const at = nowStamp();
  const id = input.id || nextSceneSeq();
  const code = input.code || ('SC-' + id);

  let publish = input.publish || (cur ? cur.publish : 'draft');
  let note = '保存修改';
  if (isNew) { publish = 'draft'; note = '新建场景'; }
  else if (publish === 'published') { publish = 'review'; note = '变更已发布场景'; }

  const payload = {
    script: input.script || [], objectives: input.objectives || [],
    voicePool: input.voicePool || [], tips: input.tips || []
  };

  const rec = Object.assign({}, cur || {}, input, {
    id, code, publish, updatedAt: today(),
    owner: input.owner || (cur && cur.owner) || user.name
  });

  db.prepare(`INSERT INTO scenes
    (id,code,name,subtitle,avatar_text,color,task_name,channel,category,difficulty,
     pass_line,duration,status,publish,owner,updated_at,brief,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      code=excluded.code, name=excluded.name, subtitle=excluded.subtitle,
      avatar_text=excluded.avatar_text, color=excluded.color, task_name=excluded.task_name,
      channel=excluded.channel, category=excluded.category, difficulty=excluded.difficulty,
      pass_line=excluded.pass_line, duration=excluded.duration, status=excluded.status,
      publish=excluded.publish, owner=excluded.owner, updated_at=excluded.updated_at,
      brief=excluded.brief, payload=excluded.payload`)
    .run(rec.id, rec.code, rec.name, rec.subtitle || '', rec.avatarText || '', rec.color || '#5B8FF9',
      rec.taskName || '', rec.channel || '', rec.category || '', rec.difficulty || '',
      rec.passLine || 0, rec.duration || 0, rec.status || 'active', publish,
      rec.owner, rec.updatedAt, rec.brief || '', J(Object.assign({}, rec, payload)));

  // 归档版本
  const n = countVersions(rec.id) + 1;
  db.prepare('INSERT INTO scene_versions (scene_id,v,at,by_user,note,snapshot) VALUES (?,?,?,?,?,?)')
    .run(rec.id, n, at, user.name, note, J(Object.assign({}, rec, payload)));

  // 审计记录
  const au = auditOf(rec.id);
  const nextStatus = publish === 'published' ? 'published' : (publish === 'review' ? 'review' : (au.status === 'published' ? 'review' : (au.status || 'draft')));
  db.prepare(`INSERT INTO scene_audit (scene_id,status,submit_by,submit_at,review_by,review_at,reject_reason)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(scene_id) DO UPDATE SET status=excluded.status,
      submit_by=excluded.submit_by, submit_at=excluded.submit_at,
      review_by=excluded.review_by, review_at=excluded.review_at, reject_reason=excluded.reject_reason`)
    .run(rec.id, nextStatus, au.submitBy || '', au.submitAt || '', au.reviewBy || '', au.reviewAt || '', au.rejectReason || '');

  log(user.id, isNew ? 'scene.create' : 'scene.save', rec.id, `${rec.name} → v${n}（${note}）`);
  return getScene(rec.id);
}

function deleteScene(id, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);
  const s = getScene(id);
  if (!s) throw Object.assign(new Error('场景不存在'), { status: 404 });
  db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
  db.prepare('DELETE FROM scene_audit WHERE scene_id = ?').run(id);
  log(user.id, 'scene.delete', id, s.name);
  return { ok: true };
}

function listVersions(sceneId) {
  return db.prepare('SELECT v,at,by_user AS byUser,note,snapshot FROM scene_versions WHERE scene_id = ? ORDER BY v DESC')
    .all(sceneId)
    .map((r) => ({ v: r.v, at: r.at, by: r.byUser, note: r.note, snapshot: P(r.snapshot, {}) }));
}

function rollback(sceneId, v, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);
  const row = db.prepare('SELECT * FROM scene_versions WHERE scene_id = ? AND v = ?').get(sceneId, v);
  if (!row) throw Object.assign(new Error('版本不存在'), { status: 404 });
  const snap = P(row.snapshot, {});
  snap.id = sceneId;
  snap.publish = 'draft';
  const saved = saveScene(snap, userId);
  // saveScene 已归档一次；补一条明确语义的版本
  const n = countVersions(sceneId) + 1;
  db.prepare('INSERT INTO scene_versions (scene_id,v,at,by_user,note,snapshot) VALUES (?,?,?,?,?,?)')
    .run(sceneId, n, nowStamp(), user.name, `回滚到 v${v}`, J(saved));
  db.prepare('UPDATE scene_audit SET status=?, submit_by=?, submit_at=?, reject_reason=? WHERE scene_id=?')
    .run('draft', '', '', '', sceneId);
  log(user.id, 'scene.rollback', sceneId, `回滚到 v${v}`);
  return getScene(sceneId);
}

/* ---- 审批流 ---- */
function submitReview(sceneId, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);
  const s = getScene(sceneId);
  if (!s) throw Object.assign(new Error('场景不存在'), { status: 404 });
  const bad = validateScene(s).filter((x) => x.lv === 'bad');
  if (bad.length) throw Object.assign(new Error('存在阻断问题，无法提交：' + bad.map((b) => b.msg).join('；')), { status: 400 });

  db.prepare(`INSERT INTO scene_audit (scene_id,status,submit_by,submit_at,review_by,review_at,reject_reason)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(scene_id) DO UPDATE SET status='review', submit_by=excluded.submit_by,
      submit_at=excluded.submit_at, reject_reason=''`)
    .run(sceneId, 'review', user.name, nowStamp(), '', '');
  db.prepare('UPDATE scenes SET publish = ? WHERE id = ?').run('review', sceneId);
  log(user.id, 'scene.submit', sceneId, s.name);
  return getScene(sceneId);
}

function approveScene(sceneId, userId) {
  const user = requireUser(userId);
  assertCanReview(user, sceneId);
  db.prepare(`UPDATE scene_audit SET status='published', review_by=?, review_at=?, reject_reason='' WHERE scene_id=?`)
    .run(user.name, nowStamp(), sceneId);
  db.prepare('UPDATE scenes SET publish = ? WHERE id = ?').run('published', sceneId);
  log(user.id, 'scene.approve', sceneId, '');
  return getScene(sceneId);
}

function rejectScene(sceneId, reason, userId) {
  const user = requireUser(userId);
  assertCanReview(user, sceneId);
  db.prepare(`UPDATE scene_audit SET status='draft', reject_reason=? WHERE scene_id=?`)
    .run((reason || '').trim() || '未填写原因', sceneId);
  db.prepare('UPDATE scenes SET publish = ? WHERE id = ?').run('draft', sceneId);
  log(user.id, 'scene.reject', sceneId, reason || '');
  return getScene(sceneId);
}

function offlineScene(sceneId, userId) {
  const user = requireUser(userId);
  assertCanReview(user, sceneId);
  db.prepare(`UPDATE scene_audit SET status='offline' WHERE scene_id=?`).run(sceneId);
  db.prepare('UPDATE scenes SET publish = ? WHERE id = ?').run('offline', sceneId);
  log(user.id, 'scene.offline', sceneId, '');
  return getScene(sceneId);
}

/* ================================================================== *
 * 会话：一轮对话
 * ================================================================== */
function getOrCreateSession(payload) {
  const { sessionId, taskId, sceneId, learnerId, channel } = payload;
  let s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!s) {
    db.prepare('INSERT INTO sessions (id,task_id,scene_id,learner_id,channel,turn,state,started_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(sessionId, taskId || '', sceneId || '', learnerId || '', channel || 'text', 0, J({}), nowStamp());
    s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  }
  return Object.assign({}, s, { stateObj: P(s.state, {}) });
}

/**
 * session_turns 行 → 对外「一轮对话」对象（**逐轮形状的唯一来源**）
 *
 * 铁律 8：同一份数据在多处流转时，字段集必须只有一处定义。
 * P7 之前这里有两份形状，而且是**同一份逐轮对话**的两种叫法：
 *   ① finish() 返回：{ idx, learnerText, customerReply, emotion, score, dimScores, confidence, source }
 *   ② records.evidence 落库：{ turn, learner, customer, score }
 * 结果：任何按 ① 写的前端，拿到 ② 都会**静默**读出 undefined（不报错、不抛异常，
 * 只显示空白），正是铁律 8 描述的失败模式。现在三处全部走这一个函数：
 *   ① finish() 的返回值 ② records.evidence 落库内容 ③ GET /records/:id/turns
 */
function turnRow(r) {
  if (!r) return null;
  return {
    idx: r.idx,
    learnerText: r.learner_text || '',
    customerReply: r.customer_reply || '',
    emotion: r.emotion || '',
    score: typeof r.score === 'number' ? r.score : 0,
    dimScores: P(r.dim_scores, {}),
    confidence: typeof r.confidence === 'number' ? r.confidence : 1,
    source: r.source || '',
    at: r.at || ''
  };
}

/**
 * 读 evidence 时把历史形状归一化到 turnRow 的形状。
 *
 * 为什么需要它：用户手上已有的库可能存着 P7 之前落库的 4 字段 evidence
 * （{turn,learner,customer,score}），或压根没有 evidence（空数组）。
 * 逐轮接口不能因此要求用户「恢复出厂重播种」——那是把内部演进成本转嫁给用户。
 * 这里的降级是**有损但明确**的：旧记录没有逐轮维度分，dimScores 返回 {}，
 * 页面应显示「本轮无维度明细」而不是伪造一个分数。
 */
function evidenceTurn(t) {
  if (!t) return null;
  if (t.idx !== undefined) return t;                 // 已是新形状
  return {
    idx: t.turn,
    learnerText: t.learner || '',
    customerReply: t.customer || '',
    emotion: '',
    score: typeof t.score === 'number' ? t.score : 0,
    dimScores: {},
    confidence: 1,
    source: '',
    at: ''
  };
}

/**
 * 一轮对话：评分 + NPC 回复 + 落 session_turns
 */
async function turn(payload) {
  const { sessionId, sceneId, learnerText, channel } = payload;
  const sess = getOrCreateSession(payload);
  const scene = getScene(sceneId || sess.scene_id);
  if (!scene) throw Object.assign(new Error('场景不存在'), { status: 404 });

  const turnIdx = (sess.turn || 0) + 1;
  const objectives = scene.objectives || [];
  const objIdx = Math.min(turnIdx - 1, Math.max(0, objectives.length - 1));
  const objectiveDim = objectives[objIdx] ? objectives[objIdx].dim : null;

  // 历史：库里已有的轮次 + 本轮的客户发言
  const past = db.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY idx').all(sessionId);
  const history = [];
  past.forEach((t) => {
    history.push({ role: 'customer', text: t.customer_reply });
    history.push({ role: 'learner', text: t.learner_text });
  });
  const customerText = payload.customerText || (scene.script[objIdx] ? scene.script[objIdx].t : '');

  const T = dbm.loadAppData();
  const result = await ai.runTurn({
    scene, objectives, objectiveDim,
    learnerText: learnerText || '',
    customerText,
    history, turn: turnIdx,
    isCall: channel === 'call',
    state: sess.stateObj || {},
    kw: T.kw
  });

  // 落 session_turns
  db.prepare(`INSERT INTO session_turns
    (session_id,idx,learner_text,customer_reply,emotion,dim_scores,score,confidence,source,at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sessionId, turnIdx, learnerText || '', result.customerReply.text,
      result.customerReply.emotion, J(result.dimScores), result.score,
      result.confidence, result.source, nowStamp());

  // 更新会话状态
  db.prepare('UPDATE sessions SET turn = ?, state = ? WHERE id = ?')
    .run(turnIdx, J(result.nextState), sessionId);

  return Object.assign({
    sessionId, turn: turnIdx, channel: channel || sess.channel,
    passLine: scene.passLine, rubricVersion: config.rubricVersion,
    lowConfidence: result.confidence < config.llm.lowConfidence
  }, result);
}

/**
 * 结束会话：汇总各轮 → 综合分 → 写一条 Record（其余全部派生）
 */
function finish(payload) {
  const { sessionId } = payload;
  const sess = getOrCreateSession(payload);
  const scene = getScene(sess.scene_id);
  const rows = db.prepare('SELECT * FROM session_turns WHERE session_id = ? ORDER BY idx').all(sessionId);

  // 逐轮平均出各维终值
  const dimScores = {};
  const dimIds = ['d1', 'd2', 'd3', 'd4', 'd5'];
  dimIds.forEach((id) => {
    const vals = rows.map((r) => P(r.dim_scores, {})[id]).filter((v) => typeof v === 'number');
    dimScores[id] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  });
  const total = rows.length
    ? Math.round(rows.reduce((a, r) => a + (r.score || 0), 0) / rows.length)
    : 0;

  // 目标达成：任一轮达成即算达成
  const objectives = (scene.objectives || []).map((o, i) => {
    const hit = rows.filter((r) => {
      const arr = P(r.dim_scores, {});
      return typeof arr[o.dim] === 'number';
    })[0];
    return { dim: o.dim, text: o.text, achieved: !!hit && i < rows.length };
  });

  const lowConf = rows.filter((r) => (r.confidence || 1) < config.llm.lowConfidence).length;
  const sources = Array.from(new Set(rows.map((r) => r.source)));
  const avgConf = rows.length ? rows.reduce((a, r) => a + (r.confidence || 0), 0) / rows.length : 0;

  const id = payload.recordId || ('R-' + sessionId);
  const passed = total >= (scene.passLine || 60);

  db.prepare(`INSERT INTO records
    (id,learner_id,task_id,scene_id,score,passed,at,channel,rubric_version,confidence,
     dim_scores,objectives,evidence,source,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET score=excluded.score, passed=excluded.passed,
      dim_scores=excluded.dim_scores, objectives=excluded.objectives, payload=excluded.payload`)
    .run(id, sess.learner_id, sess.task_id, sess.scene_id, total, passed ? 1 : 0,
      nowStamp(), sess.channel, config.rubricVersion, avgConf,
      J(dimScores), J(objectives),
      // ⚠️ 与下面返回的 turns 用**同一个** turnRow：这两处曾经是两种形状
      J(rows.map(turnRow)),
      sources.join('+') || 'llm', J({ sessionId, turns: rows.length }));

  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(nowStamp(), sessionId);

  return {
    recordId: id, sessionId, learnerId: sess.learner_id, sceneId: sess.scene_id,
    score: total, passLine: scene.passLine || 60, passed,
    dimScores, objectives,
    turns: rows.map(turnRow),
    rubricVersion: config.rubricVersion,
    confidence: Math.round(avgConf * 100) / 100,
    lowConfidenceTurns: lowConf,
    needHumanReview: lowConf > 0,
    source: sources.join('+') || 'llm'
  };
}

/* ================================================================== *
 * 查询
 * ================================================================== */
function listRecords(query, user) {
  query = query || {};
  let sql = 'SELECT * FROM records';
  const where = [], args = [];
  if (query.learnerId) { where.push('learner_id = ?'); args.push(String(query.learnerId)); }
  if (query.sceneId) { where.push('scene_id = ?'); args.push(String(query.sceneId)); }
  if (query.taskId) { where.push('task_id = ?'); args.push(String(query.taskId)); }

  // 数据范围：非全量账号只看得到自己范围内的学员记录
  const scopeIds = user ? scopedLearnerIds(user) : null;
  if (scopeIds !== null) {
    if (!scopeIds.length) return [];
    where.push(`learner_id IN (${scopeIds.map(() => '?').join(',')})`);
    args.push(...scopeIds);
  }

  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY at DESC';

  // 附带质检结论（P5）：教练台要按「已通过 / 待统一话术」直接渲染状态列
  const qcMap = {};
  db.prepare('SELECT record_id, state FROM record_qc').all().forEach((q) => { qcMap[q.record_id] = q.state; });

  return db.prepare(sql).all(...args).map((r) => {
    const pl = P(r.payload, {}) || {};
    return {
      id: r.id, learnerId: r.learner_id, taskId: r.task_id, sceneId: r.scene_id,
      score: r.score, passed: !!r.passed, at: r.at, channel: r.channel,
      rubricVersion: r.rubric_version, confidence: r.confidence,
      // 用时/轮次：播种记录写在 payload 里；练习产生的记录 payload 只带 turns
      minutes: pl.minutes || 0,
      turns: pl.turns || 0,
      qc: qcMap[r.id] || '',
      dimScores: P(r.dim_scores, {}), objectives: P(r.objectives, []),
      // 逐轮对话**正文刻意不在这里返回**：一次列表 = 全部学员的记录，
      // 每条 5~6 轮，实测演示库 28 条就近 150 段文本，而列表页一个字都不渲染
      // （三端 grep evidence 均为 0 处引用，所以撤掉不影响任何现有页面）。
      // turnCount 只告诉页面「这条记录有没有对话可看」，正文按需打下面那个接口。
      turnCount: (P(r.evidence, []) || []).length,
      source: r.source
    };
  });
}

/**
 * 单条成绩的逐轮对话（P7）。
 *
 * 权限：与质检同一套——只卡**数据可见范围**，不卡 can_edit / can_review。
 * 带教主管看自己名下学员的对话是本职，不是编辑动作。
 * 无主成绩（练习未带 learnerId）一律 403，理由见 assertRecordScope 注释。
 */
function listTurns(id, userId) {
  const user = requireUser(userId);
  const rid = String(id == null ? '' : id);
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(rid);
  if (!rec) throw Object.assign(new Error('成绩记录不存在'), { status: 404 });
  assertRecordScope(user, rec, '查看逐轮对话');
  return {
    recordId: rid,
    learnerId: rec.learner_id || '',
    sceneId: rec.scene_id || '',
    score: rec.score,
    dimScores: P(rec.dim_scores, {}),
    // 老库的 4 字段 evidence 在这里被归一化；空数组表示这条记录没有逐轮数据
    turns: (P(rec.evidence, []) || []).map(evidenceTurn).filter(Boolean)
  };
}

/** 删除一条成绩记录（连带它的质检结论）。成绩清理是运营的正当需求，
 *  同时也让自测能把自己造的数据删干净，不必留一堆 R-selfcheck-* 残渣。 */
function deleteRecord(id, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);
  const rid = String(id == null ? '' : id);
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(rid);
  if (!rec) throw Object.assign(new Error('成绩记录不存在'), { status: 404 });
  // record_qc 没建外键，必须自己收尾，否则留下指向空气的质检结论
  db.prepare('DELETE FROM record_qc WHERE record_id = ?').run(rid);
  db.prepare('DELETE FROM records WHERE id = ?').run(rid);
  log(user.id, 'record.delete', rid, rec.learner_id || '(无归属)');
  return { ok: true, id: rid };
}

function listLearners(user) {
  const scopeIds = user ? scopedLearnerIds(user) : null;
  let rows = db.prepare('SELECT * FROM learners ORDER BY id').all();
  if (scopeIds !== null) rows = rows.filter((r) => scopeIds.indexOf(r.id) !== -1);
  return rows.map((r) => ({
    id: r.id, name: r.name, avatarText: r.avatar_text, color: r.color,
    dept: r.dept, title: r.title, onboardAt: r.onboard_at,
    coach: r.coach, mentor: r.coach      // app-data.js 用 mentor 命名，两边都给出
  }));
}

function listUsers() {
  // 注意：绝不外泄 salt / password_hash
  return db.prepare('SELECT id,name,staff_name,account,role,dept,can_edit,can_review,data_scope,scope_ref FROM users ORDER BY id').all()
    .map((r) => ({
      id: r.id, name: r.name, staffName: r.staff_name || '', account: r.account || '', role: r.role, dept: r.dept,
      canEdit: !!r.can_edit, canReview: !!r.can_review,
      scope: scopeOf(r).kind, scopeRef: r.scope_ref || '', scopeLabel: scopeOf(r).label
    }));
}

function listAuditLog(limit, user) {
  let rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit || 100);
  const scopeIds = user ? scopedLearnerIds(user) : null;
  if (scopeIds !== null) {
    // 审计日志按「同范围内的人」过滤：部门范围看本部门账号的操作，带教范围只看自己
    const sc = scopeOf(user);
    const allowed = new Set([user.id]);
    if (sc.kind === 'dept' && sc.dept) {
      db.prepare('SELECT id FROM users WHERE dept = ?').all(sc.dept).forEach((u) => allowed.add(u.id));
    }
    rows = rows.filter((r) => allowed.has(r.user_id));
  }
  return rows.map((r) => ({
    id: r.id, at: r.at, userId: r.user_id,
    action: r.action, target: r.target, detail: r.detail
  }));
}

/* ================================================================== *
 * 教练动作（P5）：辅导记录 + 对话质检
 *
 * 权限模型与场景/任务**刻意不同**：
 *   - 场景编辑、任务下发是「内容运营」动作 → 卡 can_edit
 *   - 写辅导记录、做质检是**带教主管的本职** → 不卡 can_edit（教练没有这个权限位）
 *   这里只卡一件事：**数据可见范围**（只能读/写自己看得到的学员）。
 * ================================================================== */
function assertLearnerInScope(user, learnerId) {
  const lid = String(learnerId == null ? '' : learnerId);
  if (!lid) throw Object.assign(new Error('缺少学员 id'), { status: 400 });
  if (!db.prepare('SELECT 1 FROM learners WHERE id = ?').get(lid)) {
    throw Object.assign(new Error(`学员不存在：${lid}`), { status: 400 });
  }
  if (!inScope(user, lid)) {
    throw Object.assign(new Error('该学员不在你的数据可见范围内'), { status: 403 });
  }
}

/**
 * 成绩记录级范围校验。与 assertLearnerInScope 的区别：
 * 这里的一致性「主语」是那条成绩，learner_id 由**服务端**从库里读出来，
 * 所以不能把"没归属学员"报成"缺少学员 id"（那是调用方的错，很误导）。
 *
 * 无归属成绩确实会出现：练习通道允许请求体不带 learnerId
 * （学员端页面总是带，但脚本接入 / 压测 / 匿名试用不会），finish() 会照常落库。
 * 这是刻意保留的产品行为，不是脏数据 → 对谁都不可质检，一律 403。
 * 注意：inScope(user,'') 在 scope=all 时会因 ids===null 而返回 true，
 * 若不在前面拦掉，管理员就能给一条无主成绩打质检结论（曾漏掉这个口子）。
 */
function assertRecordScope(user, rec, what) {
  const lid = String((rec && rec.learner_id) == null ? '' : (rec && rec.learner_id));
  if (!lid) {
    // what 由调用方给出（做质检 / 查看逐轮对话），否则报错文案会把
    // 「看对话」说成「做质检」——错误信息误导排查方向比没信息更坏
    throw Object.assign(new Error(`该成绩未归属学员（练习未带 learnerId），无法${what || '做质检'}`), { status: 403 });
  }
  if (!inScope(user, lid)) {
    throw Object.assign(new Error('该成绩不在你的数据可见范围内'), { status: 403 });
  }
}

function noteRow(r) {
  if (!r) return null;
  return {
    id: r.id, learnerId: r.learner_id, recordId: r.record_id || '',
    type: r.type || '一对一辅导', text: r.text || '',
    by: r.by_name || '', byId: r.by_id || '', at: r.at || ''
  };
}

function qcRow(r) {
  if (!r) return null;
  return { recordId: r.record_id, state: r.state, note: r.note || '', by: r.by_name || '', at: r.at || '' };
}

/** 辅导记录：按数据范围过滤，可按学员收窄 */
function listCoachNotes(learnerId, user) {
  const where = [], args = [];
  if (learnerId) { where.push('learner_id = ?'); args.push(String(learnerId)); }
  const scopeIds = user ? scopedLearnerIds(user) : null;
  if (scopeIds !== null) {
    if (!scopeIds.length) return [];
    where.push(`learner_id IN (${scopeIds.map(() => '?').join(',')})`);
    args.push(...scopeIds);
  }
  let sql = 'SELECT * FROM coach_notes';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY at DESC, id DESC';
  return db.prepare(sql).all(...args).map(noteRow);
}

/** 新增 / 更新一条辅导记录 */
function saveCoachNote(input, userId) {
  const user = requireUser(userId);
  const learnerId = String((input && input.learnerId) || '');
  assertLearnerInScope(user, learnerId);

  const text = String((input && input.text) || '').trim();
  if (!text) throw Object.assign(new Error('辅导记录内容不能为空'), { status: 400 });
  if (text.length > 1000) throw Object.assign(new Error('辅导记录过长（上限 1000 字）'), { status: 400 });

  const id = String((input && input.id) || ('N-' + Date.now()));
  const by = user.staff_name || user.name;
  db.prepare(`INSERT INTO coach_notes (id,learner_id,record_id,type,text,by_name,by_id,at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET text=excluded.text, record_id=excluded.record_id, type=excluded.type`)
    .run(id, learnerId, String((input && input.recordId) || ''),
      String((input && input.type) || '一对一辅导'), text, by, user.id, nowStamp());

  log(user.id, 'coach.note', learnerId, text.slice(0, 60));
  return noteRow(db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(id));
}

/** 删除辅导记录：只能删自己写的（管理员例外），且必须在可见范围内 */
function deleteCoachNote(id, userId) {
  const user = requireUser(userId);
  const nid = String(id == null ? '' : id);
  const row = db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(nid);
  if (!row) throw Object.assign(new Error('辅导记录不存在'), { status: 404 });
  assertLearnerInScope(user, row.learner_id);
  if (row.by_id && row.by_id !== user.id && user.role !== 'admin') {
    throw Object.assign(new Error('只能删除自己写的辅导记录'), { status: 403 });
  }
  db.prepare('DELETE FROM coach_notes WHERE id = ?').run(nid);
  log(user.id, 'coach.note.del', row.learner_id, String(row.text || '').slice(0, 60));
  return { ok: true, id: nid };
}

/** 质检结论：一条成绩记录一个结论（ok 通过 / flag 待统一话术） */
const QC_STATE = ['ok', 'flag'];

function listQc(user) {
  const scopeIds = user ? scopedLearnerIds(user) : null;
  const owner = {};
  db.prepare('SELECT id, learner_id FROM records').all().forEach((r) => { owner[r.id] = r.learner_id; });
  return db.prepare('SELECT * FROM record_qc ORDER BY at DESC').all()
    .filter((r) => scopeIds === null || scopeIds.indexOf(owner[r.record_id]) !== -1)
    .map(qcRow);
}

function setQc(recordId, state, note, userId) {
  const user = requireUser(userId);
  // node:sqlite 不接受 undefined，先做字符串化
  const rid = String(recordId == null ? '' : recordId);
  if (!rid) throw Object.assign(new Error('缺少成绩记录 id'), { status: 400 });
  if (QC_STATE.indexOf(String(state)) === -1) {
    throw Object.assign(new Error(`质检结论只能是 ${QC_STATE.join(' / ')}`), { status: 400 });
  }
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(rid);
  if (!rec) throw Object.assign(new Error('成绩记录不存在'), { status: 404 });
  // 只能对自己范围内的学员记录做质检（无归属成绩对谁都不可质检）
  assertRecordScope(user, rec);

  const at = nowStamp();
  const by = user.staff_name || user.name;
  const noteText = String(note == null ? '' : note);
  db.prepare(`INSERT INTO record_qc (record_id,state,note,by_name,by_id,at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(record_id) DO UPDATE SET state=excluded.state, note=excluded.note,
      by_name=excluded.by_name, by_id=excluded.by_id, at=excluded.at`)
    .run(rid, String(state), noteText, by, user.id, at);

  log(user.id, 'qc.mark', rid, String(state));
  return { recordId: rid, state: String(state), note: noteText, by, at };
}

/** 撤销质检结论（标错了要能改回来） */
function clearQc(recordId, userId) {
  const user = requireUser(userId);
  const rid = String(recordId == null ? '' : recordId);
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(rid);
  if (!rec) throw Object.assign(new Error('成绩记录不存在'), { status: 404 });
  assertRecordScope(user, rec);
  db.prepare('DELETE FROM record_qc WHERE record_id = ?').run(rid);
  log(user.id, 'qc.clear', rid, '撤销质检结论');
  return { recordId: rid, state: '' };
}

function stats() {
  const one = (sql) => { const r = db.prepare(sql).get(); return r ? Object.values(r)[0] : 0; };
  return {
    scenes: one('SELECT COUNT(*) AS n FROM scenes'),
    published: one("SELECT COUNT(*) AS n FROM scenes WHERE publish='published'"),
    learners: one('SELECT COUNT(*) AS n FROM learners'),
    tasks: one('SELECT COUNT(*) AS n FROM tasks'),
    records: one('SELECT COUNT(*) AS n FROM records'),
    recordsFromLLM: one("SELECT COUNT(*) AS n FROM records WHERE source LIKE '%llm%'"),
    sessions: one('SELECT COUNT(*) AS n FROM sessions'),
    goldSet: one('SELECT COUNT(*) AS n FROM gold_set'),
    auditLog: one('SELECT COUNT(*) AS n FROM audit_log')
  };
}

module.exports = {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope,
  listScenes, listPublishedScenes, getScene, saveScene, deleteScene, validateScene,
  listVersions, rollback, canAssign,
  submitReview, approveScene, rejectScene, offlineScene,
  getTask, saveTask, setTaskStatus, deleteTask, taskProgressOf, TASK_STATUS,
  assertLearnerInScope, assertRecordScope, listCoachNotes, saveCoachNote, deleteCoachNote, listQc, setQc, clearQc, QC_STATE,
  // turnRow 一并导出：自测要断言「返回的 turns / 落库的 evidence / 逐轮接口」
  // 三处字段集完全一致，必须能拿到同一个映射函数来比对（铁律 8）
  turnRow, turn, finish, listRecords, listTurns, deleteRecord,
  listLearners, listTasks, listUsers, listAuditLog, stats
};
