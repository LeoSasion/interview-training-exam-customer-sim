'use strict';
/**
 * 任务模块（P22 技术债拆分）
 *
 * 从 service.js 抽出的「下发 / 改期 / 改线 / 结束 / 删除」——
 * 指派关系落在 task_assignees，才能按学员反查「我的任务」。
 *
 * 依赖：lib/core（权限）+ db。校验场景存在时**延迟 require** scenes，
 * 避免与场景模块形成循环引用。
 */

const dbm = require('../db');
const { db, log, nowStamp, J, P } = dbm;
const { requireUser, assertCanEdit, scopedLearnerIds, inScope, pageOf, pageMeta } = require('./core');

/** 延迟取场景（任务校验要用「场景必须已发布」，但场景模块不该互相 require） */
function sceneOf(id) {
  // eslint-disable-next-line global-require
  return require('./scenes').getScene(id);
}

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
  const page = pageOf(query);
  let rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC').all().map(taskRow);

  if (query.status) rows = rows.filter((t) => t.status === query.status);
  if (query.sceneId) rows = rows.filter((t) => t.sceneId === query.sceneId);

  // 学员端：只看得到派给自己的、且已下发的任务
  if (mineOnly && query.learnerId) {
    const lid = String(query.learnerId);
    rows = rows.filter((t) => t.status !== 'draft' && assigneesOf(t.id).indexOf(lid) !== -1);
  }

  const scopeIds = user ? scopedLearnerIds(user) : null;
  const items = rows.map((t) => {
    let assignees = assigneesOf(t.id);
    if (scopeIds !== null) assignees = assignees.filter((x) => scopeIds.indexOf(x) !== -1);
    return Object.assign(t, {
      assignees,
      progress: taskProgressOf(t.id, assignees, t.dueAt),
      visibleAssignees: assignees.length,
      totalAssignees: assigneesOf(t.id).length
    });
  }).filter((t) => scopeIds === null || t.assignees.length > 0 || t.totalAssignees === 0);
  const sliced = page ? items.slice(page.offset, page.offset + page.limit) : items;
  return Object.assign({ items: sliced }, pageMeta(items.length, page));
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
  const scene = sceneOf(sceneId);
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

module.exports = {
  assertCanAssignTask, nextTaskCode, assigneesOf, taskRow, getTask,
  taskProgressOf, dueOf, listTasks, saveTask, TASK_STATUS, setTaskStatus, deleteTask
};
