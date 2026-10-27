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
/* 用户/权限/可见范围已下沉到 lib/core.js（P22）。
 * 这里解构出来继续用，外部调用方式完全不变。 */
const {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope,
  pageOf, pageMeta, assertLearnerInScope, assertRecordScope
} = require('./lib/core');

/* ================================================================== *
 * 用户 / 权限 / 可见范围 —— 已移至 lib/core.js（P22）
 * ================================================================== */
/* 任务模块已下沉到 lib/tasks.js（P22） */
const {
  assertCanAssignTask, nextTaskCode, assigneesOf, taskRow, getTask,
  taskProgressOf, dueOf, listTasks, saveTask, TASK_STATUS, setTaskStatus, deleteTask
} = require('./lib/tasks');

/* 场景模块已下沉到 lib/scenes.js（P22） */
const {
  listScenes, sceneForLearner, listPublishedScenes, auditOf, countVersions, getScene,
  canAssign, validateScene, nextSceneSeq, saveScene, duplicateScene, deleteScene,
  listVersions, rollback, submitReview, approveScene, rejectScene, offlineScene
} = require('./lib/scenes');

/* ================================================================== *
 * 会话：一轮对话
 * ================================================================== */
/* 学员模块已下沉到 lib/learners.js（P23） */
const { listLearners, importLearners, deleteLearner } = require('./lib/learners');

/* 会话与成绩模块已下沉到 lib/records.js（P23） */
const {
  getOrCreateSession, turnRow, turn, evidenceTurn, finish,
  listRecords, listTurns, deleteRecord
} = require('./lib/records');

function listUsers() {
  // 注意：绝不外泄 salt / password_hash
  return db.prepare('SELECT id,name,staff_name,account,role,dept,can_edit,can_review,data_scope,scope_ref FROM users ORDER BY id').all()
    .map((r) => ({
      id: r.id, name: r.name, staffName: r.staff_name || '', account: r.account || '', role: r.role, dept: r.dept,
      canEdit: !!r.can_edit, canReview: !!r.can_review,
      scope: scopeOf(r).kind, scopeRef: r.scope_ref || '', scopeLabel: scopeOf(r).label
    }));
}

function listAuditLog(query, user) {
  query = query || {};
  // 审计日志刻意与其它列表不同：不带 limit/offset 时默认只回最近 100 条
  //（audit_log 只增不减，无参全量会随时间越滚越大）。只带 limit 的老调用
  //（如 /audit?limit=200）按「第一页」处理，行为不变、只是多了 total/hasMore。
  if (query.limit === undefined && query.offset === undefined) {
    query = Object.assign({}, query, { limit: 100, offset: 0 });
  }
  const page = pageOf(query);

  const where = [], args = [];
  // 审计日志按「同范围内的人」过滤：部门范围看本部门账号的操作，带教范围只看自己。
  // scope=all（管理员）不过滤 —— 与旧版语义一致。
  const scopeIds = user ? scopedLearnerIds(user) : null;
  if (scopeIds !== null) {
    const sc = scopeOf(user);
    const allowed = [user.id];
    if (sc.kind === 'dept' && sc.dept) {
      db.prepare('SELECT id FROM users WHERE dept = ?').all(sc.dept).forEach((u) => allowed.push(u.id));
    }
    where.push(`user_id IN (${allowed.map(() => '?').join(',')})`);
    args.push(...allowed);
  }

  // 旧实现是「先 LIMIT 再 JS 过滤」，带范围的账号会看到**少于 limit** 的行且翻不了页 —— 顺手修正
  let sql = 'SELECT * FROM audit_log';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC';

  let total = null;
  if (page) {
    const cntSql = 'SELECT COUNT(*) AS n FROM audit_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    total = db.prepare(cntSql).get(...args).n;
    sql += ' LIMIT ? OFFSET ?';
    args.push(page.limit, page.offset);
  }
  const items = db.prepare(sql).all(...args).map((r) => ({
    id: r.id, at: r.at, userId: r.user_id,
    action: r.action, target: r.target, detail: r.detail
  }));
  return Object.assign({ items }, pageMeta(total === null ? items.length : total, page));
}

/* ================================================================== *
 * 教练动作（P5）：辅导记录 + 对话质检
 *
 * 权限模型与场景/任务**刻意不同**：
 *   - 场景编辑、任务下发是「内容运营」动作 → 卡 can_edit
 *   - 写辅导记录、做质检是**带教主管的本职** → 不卡 can_edit（教练没有这个权限位）
 *   这里只卡一件事：**数据可见范围**（只能读/写自己看得到的学员）。
 * ================================================================== */
/* 辅导与质检模块已下沉到 lib/coach.js（P23） */
const {
  noteRow, qcRow, listCoachNotes, saveCoachNote, deleteCoachNote,
  QC_STATE, listQc, setQc, clearQc,
  cleanupSessions, sweepStaleSessions, setManualScore
} = require('./lib/coach');

/* ================================================================== *
 * 待建场景池（P12）：内容供给闭环
 *   教练在质检里标「这类问题话术没覆盖」→ 进池 → 运营认领 → 起草新场景。
 *   为什么不做成「自动生成场景」：场景是训练资产，草稿必须人确认；
 *   系统只负责把「实战暴露的问题」结构化地带到运营面前。
 * ================================================================== */
function ideaRow(r) {
  return {
    id: r.id, title: r.title, problem: r.problem, quote: r.quote || '',
    recordId: r.record_id || '', learnerId: r.learner_id || '', sceneId: r.scene_id || '',
    status: r.status, by: r.by_name || '', at: r.at || '',
    claimedBy: r.claimed_by || '', claimedAt: r.claimed_at || ''
  };
}

function listIdeas(query) {
  const q = query || {};
  let sql = 'SELECT * FROM scene_ideas';
  const args = [];
  if (q.status && q.status !== 'all') { sql += ' WHERE status = ?'; args.push(String(q.status)); }
  sql += ' ORDER BY at DESC, id DESC';
  const items = db.prepare(sql).all(...args).map(ideaRow);
  return { items, total: items.length, open: db.prepare("SELECT COUNT(*) AS n FROM scene_ideas WHERE status='open'").get().n };
}

/** 教练把一条成绩暴露的问题标记为「待建场景」 */
function createIdea(payload, userId) {
  const user = requireUser(userId);
  const title = String((payload && payload.title) || '').trim();
  const problem = String((payload && payload.problem) || '').trim();
  if (!title || !problem) {
    throw Object.assign(new Error('请填写标题与问题描述'), { status: 400 });
  }
  const rid = String((payload && payload.recordId) || '');
  let rec = null;
  if (rid) {
    rec = db.prepare('SELECT * FROM records WHERE id = ?').get(rid);
    if (!rec) throw Object.assign(new Error('成绩不存在'), { status: 404 });
    assertRecordScope(user, rec);   // 只能为自己的可见范围提问题
  }
  const id = 'SI-' + nowStamp().replace(/[-: ]/g, '').slice(2, 14) + '-' + Math.random().toString(36).slice(2, 5);
  db.prepare(`INSERT INTO scene_ideas
    (id,title,problem,quote,record_id,learner_id,scene_id,status,by_name,by_id,at)
    VALUES (?,?,?,?,?,?,?,'open',?,?,?)`).run(
    id, title.slice(0, 120), problem.slice(0, 600), String((payload && payload.quote) || '').slice(0, 300),
    rid, rec ? rec.learner_id : String((payload && payload.learnerId) || ''),
    rec ? rec.scene_id : String((payload && payload.sceneId) || ''),
    user.name, user.id, nowStamp()
  );
  log(user.id, 'scene-idea.create', id, `待建场景：${title.slice(0, 40)}`);
  return { idea: ideaRow(db.prepare('SELECT * FROM scene_ideas WHERE id = ?').get(id)) };
}

/** 运营认领 / 关闭（内容治理动作，与场景编辑同权限） */
function setIdeaStatus(id, status, userId) {
  const user = requireUser(userId);
  assertCanAssignTask(user);   // 与任务下发/场景编辑同一权限档
  const row = db.prepare('SELECT * FROM scene_ideas WHERE id = ?').get(String(id || ''));
  if (!row) throw Object.assign(new Error('待建场景不存在'), { status: 404 });
  const st = String(status || '');
  if (st !== 'claimed' && st !== 'closed' && st !== 'open') {
    throw Object.assign(new Error('状态须为 claimed / closed / open'), { status: 400 });
  }
  const claimed = st === 'claimed';
  db.prepare('UPDATE scene_ideas SET status = ?, claimed_by = ?, claimed_at = ? WHERE id = ?').run(
    st, claimed ? user.name : (st === 'open' ? '' : row.claimed_by || ''), claimed ? nowStamp() : row.claimed_at || '', row.id
  );
  log(user.id, 'scene-idea.' + st, row.id, `待建场景状态 ${row.status} → ${st}`);
  return { idea: ideaRow(db.prepare('SELECT * FROM scene_ideas WHERE id = ?').get(row.id)) };
}

/** 删除待建场景（误标/测试数据清理；与认领同权限） */
function deleteIdea(id, userId) {
  const user = requireUser(userId);
  assertCanAssignTask(user);
  const row = db.prepare('SELECT * FROM scene_ideas WHERE id = ?').get(String(id || ''));
  if (!row) throw Object.assign(new Error('待建场景不存在'), { status: 404 });
  db.prepare('DELETE FROM scene_ideas WHERE id = ?').run(row.id);
  log(user.id, 'scene-idea.delete', row.id, `删除待建场景：${row.title.slice(0, 40)}`);
  return { id: row.id, deleted: true };
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
  listLearners, listTasks, listUsers, listAuditLog, stats, cleanupSessions, sweepStaleSessions, setManualScore,
  listIdeas, createIdea, setIdeaStatus, deleteIdea, importLearners, deleteLearner, duplicateScene
};
