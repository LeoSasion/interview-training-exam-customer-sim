'use strict';
/**
 * 辅导与质检模块（P23 技术债拆分）
 *
 * 从 service.js 抽出的「带教留言 / 对话质检 / 手工改分 / 会话清理」。
 * 这几块都围绕同一个问题：**学员练完之后，人怎么看、怎么纠正**。
 *   - 带教留言：教练写的辅导，学员端要能读到（P21 补的闭环）
 *   - 对话质检：ok / flag 标记待建场景池
 *   - 手工改分：AI 判偏了要能人工修正，且保留原分可撤销
 *   - 会话清理：只删「无成绩关联」的过程记录，绝不碰已完成的练习
 *
 * 依赖：lib/core（权限/范围）+ db。
 */

const dbm = require('../db');
const { db, log, nowStamp, J, P } = dbm;
const {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope, pageOf, pageMeta,
  assertLearnerInScope, assertRecordScope
} = require('./core');

function noteRow(r) {
  if (!r) return null;
  return {
    id: r.id, learnerId: r.learner_id, recordId: r.record_id || '',
    type: r.type || '一对一辅导', text: r.text || '',
    by: r.by_name || '', byId: r.by_id || '', at: r.at || '',
    replyTo: r.reply_to || ''
  };
}

function qcRow(r) {
  if (!r) return null;
  return { recordId: r.record_id, state: r.state, note: r.note || '', by: r.by_name || '', at: r.at || '' };
}

/** 辅导记录：按数据范围过滤，可按学员收窄 */
function listCoachNotes(query, user) {
  query = query || {};
  const where = [], args = [];
  /* 学员（practice）：只能看「自己」的带教留言——教练写了辅导，学员必须能读到，
   * 否则辅导的价值断在中间（学员只知道扣了几分，不知道为什么）。
   * ⚠️ 当前学员身份是前端 ?as= 模拟的（users 表没有 learner_id 绑定），
   * 所以这里只能"信任前端传的 learnerId 并只返回这一人"；
   * 生产环境应给 users 加 learner_id 字段，登录后强制用自己的，忽略传参。 */
  const isLearner = !!(user && user.role === 'practice');
  if (isLearner && !query.learnerId) {
    throw Object.assign(new Error('学员查询带教留言需指定 learnerId'), { status: 400 });
  }
  if (query.learnerId) { where.push('learner_id = ?'); args.push(String(query.learnerId)); }
  // 全文包含检索（P9）：LIKE 通配符（% _ \）先转义，用户输入的 % 不会变成"匹配任意串"
  const q = String(query.q || '').trim();
  if (q) {
    where.push("text LIKE ? ESCAPE '\\'");
    args.push('%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
  }
  // 学员按上面的 learnerId 精确过滤，不再走「教练可见范围」那套
  const scopeIds = (user && !isLearner) ? scopedLearnerIds(user) : null;
  if (scopeIds !== null) {
    if (!scopeIds.length) return { items: [], total: 0, limit: 0, offset: 0, hasMore: false };
    where.push(`learner_id IN (${scopeIds.map(() => '?').join(',')})`);
    args.push(...scopeIds);
  }
  let sql = 'SELECT * FROM coach_notes';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY at DESC, id DESC';

  const page = pageOf(query);
  let total = null;
  if (page) {
    const cntSql = 'SELECT COUNT(*) AS n FROM coach_notes' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    total = db.prepare(cntSql).get(...args).n;
    sql += ' LIMIT ? OFFSET ?';
    args.push(page.limit, page.offset);
  }
  const items = db.prepare(sql).all(...args).map(noteRow);
  return Object.assign({ items }, pageMeta(total === null ? items.length : total, page));
}

/** 新增 / 更新一条辅导记录 */
/** 插入一条留言（教练留言 / 学员回复共用，避免两处 SQL 各写一遍） */
function insertNote(f) {
  const id = String(f.id || ((f.replyTo ? 'NR-' : 'N-') + Date.now()));
  db.prepare(`INSERT INTO coach_notes (id,learner_id,record_id,type,text,by_name,by_id,at,reply_to)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET text=excluded.text, record_id=excluded.record_id, type=excluded.type`)
    .run(id, f.learnerId, f.recordId || '', f.type, f.text, f.by, f.byId || '', nowStamp(), f.replyTo || '');
  return noteRow(db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(id));
}

function saveCoachNote(input, userId) {
  const user = requireUser(userId);
  const learnerId = String((input && input.learnerId) || '');
  assertLearnerInScope(user, learnerId);

  const text = String((input && input.text) || '').trim();
  if (!text) throw Object.assign(new Error('辅导记录内容不能为空'), { status: 400 });
  if (text.length > 1000) throw Object.assign(new Error('辅导记录过长（上限 1000 字）'), { status: 400 });

  const row = insertNote({
    id: input && input.id, learnerId, recordId: String((input && input.recordId) || ''),
    type: String((input && input.type) || '一对一辅导'), text,
    by: user.staff_name || user.name, byId: user.id
  });
  log(user.id, 'coach.note', learnerId, text.slice(0, 60));
  return row;
}

/**
 * 学员回复带教留言（P29）——辅导闭环的最后一步
 *
 * 之前辅导是单向的（教练写 → 学员看）。学员想说"我试了，但客户直接打断我"
 * 却无处可发，而这句话恰恰能告诉教练「场景设计可能有问题」。
 *
 * ⚠️ 身份模型与 listCoachNotes 一致：学员端用 ?as= 模拟身份、走匿名 practice 档，
 * 所以这里只能信任前端传的 learnerId。为此加三条硬校验把风险收窄：
 *   1. learnerId 必须真实存在（防写垃圾数据）
 *   2. replyTo 指向的留言必须属于这个学员（防跨人回复 / 伪造归属）
 *   3. 只允许一层（不给"回复的回复"开口子，否则变成聊天室，且没有已读/未读模型）
 */
function replyCoachNote(input) {
  const learnerId = String((input && input.learnerId) || '');
  const replyTo = String((input && input.replyTo) || '');
  if (!learnerId) throw Object.assign(new Error('缺少学员 id'), { status: 400 });
  if (!replyTo) throw Object.assign(new Error('缺少所回复的留言 id（replyTo）'), { status: 400 });

  const learner = db.prepare('SELECT id,name FROM learners WHERE id = ?').get(learnerId);
  if (!learner) throw Object.assign(new Error('学员不存在'), { status: 400 });

  const parent = db.prepare('SELECT * FROM coach_notes WHERE id = ?').get(replyTo);
  if (!parent || parent.learner_id !== learnerId) {
    throw Object.assign(new Error('该留言不存在或不属于你'), { status: 403 });
  }
  if (parent.reply_to) {
    throw Object.assign(new Error('只能回复带教主管的留言（不支持多级回复）'), { status: 400 });
  }

  const text = String((input && input.text) || '').trim();
  if (!text) throw Object.assign(new Error('回复内容不能为空'), { status: 400 });
  if (text.length > 500) throw Object.assign(new Error('回复过长（上限 500 字）'), { status: 400 });

  const row = insertNote({
    learnerId, recordId: String(parent.record_id || ''), type: '学员回复', text,
    by: learner.name || '学员', byId: '', replyTo
  });
  log('learner:' + learnerId, 'coach.note.reply', learnerId, text.slice(0, 60));
  return row;
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

/**
 * 清理「无成绩关联」的历史会话（P11 巡检补齐的运维能力）
 *
 * 由来：`/session/:id/turn` 每次开练都会建一条 session + 逐轮 session_turns；
 * 学员中途退出/刷新、自测与探针调用都会留下**永远没有 record 关联**的会话
 * （实测演示库攒到 268 条会话 vs 30 条成绩）。这些是过程记录，留着只脏不损，
 * 但演示前/长期运行后需要能一键清干净。**只删无成绩关联的**——已完成的练习
 * （有 record）无论多老都保留。
 *
 * @param {number} maxAgeHours 只清「开始时间早于 N 小时前」的（默认 24；传 0 = 全清无关联的）
 */
function cleanupSessions(maxAgeHours, userId) {
  const user = requireUser(userId);
  // 清库是运维动作：只允许管理员（运营/教练都不该有删数据的口子）
  if (user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无清理会话权限`), { status: 403 });
  }
  const r = sweepStaleSessions(maxAgeHours);
  log(user.id, 'session.cleanup', '',
    `清理无成绩关联会话 ${r.removedSessions} 个（逐轮 ${r.removedTurns} 条，保留 ${r.keptSessions} 个）`);
  return r;
}

/**
 * 内部：扫掉「无成绩关联」且早于 N 小时的会话（**无权限检查**）。
 * 手动清理（cleanupSessions）与服务启动自清（sweepStaleSessions）共用这一套逻辑，
 * 保证两条入口的挑选口径完全一致（不能一个删 A、另一个删 B）。
 */
function sweepStaleSessions(maxAgeHours) {
  const hours = maxAgeHours == null ? 24 : Number(maxAgeHours);
  if (!isFinite(hours) || hours < 0) {
    throw Object.assign(new Error('maxAgeHours 须为 >= 0 的数字'), { status: 400 });
  }

  // 有关联成绩的会话 id（payload.sessionId）
  const linked = new Set();
  db.prepare('SELECT payload FROM records').all().forEach((r) => {
    const sid = (P(r.payload, {}) || {}).sessionId;
    if (sid) linked.add(String(sid));
  });

  const cutoff = hours > 0 ? new Date(Date.now() - hours * 3600 * 1000) : null;
  const stamp = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const cutoffStr = cutoff ? stamp(cutoff) : '';

  const victims = db.prepare('SELECT id, started_at FROM sessions').all()
    .filter((s) => !linked.has(String(s.id)))
    .filter((s) => !cutoff || String(s.started_at || '') < cutoffStr)
    .map((s) => s.id);

  let turns = 0;
  const delTurn = db.prepare('DELETE FROM session_turns WHERE session_id = ?');
  const delSess = db.prepare('DELETE FROM sessions WHERE id = ?');
  // node:sqlite 没有 better-sqlite3 的 db.transaction()，用显式事务（多表删除要原子）
  db.exec('BEGIN');
  try {
    victims.forEach((id) => { turns += delTurn.run(id).changes; delSess.run(id); });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const kept = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  return { removedSessions: victims.length, removedTurns: turns, keptSessions: kept, maxAgeHours: hours };
}

/**
 * 人工修正分数（P12）
 *
 * AI 分是模型判断，带教主管有权推翻——但**不改原分**：修正值写在
 * payload.manualScore（分数/原因/操作人/时间），AI 分原样保留。
 * 为什么不直接 UPDATE score：P7 契约是「逐轮均分 ≡ 成绩单总分」，
 * 直接改总分会让教练台并排显示时自相矛盾，也让「AI 判得准不准」无从追溯。
 */
function setManualScore(id, score, reason, userId, revoke) {
  const user = requireUser(userId);
  const rid = String(id == null ? '' : id);
  const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(rid);
  if (!rec) throw Object.assign(new Error('成绩不存在'), { status: 404 });
  assertRecordScope(user, rec);
  if (!user.can_edit && user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无修正成绩权限`), { status: 403 });
  }

  // 撤销修正（P12）：改错了能退回去——删掉人工分，AI 原分自动生效
  if (revoke) {
    const pl0 = P(rec.payload, {}) || {};
    const prev = pl0.manualScore;
    if (!prev) throw Object.assign(new Error('这条成绩没有人工修正，无需撤销'), { status: 400 });
    delete pl0.manualScore;
    db.prepare('UPDATE records SET payload = ? WHERE id = ?').run(JSON.stringify(pl0), rid);
    log(user.id, 'record.manual-score.revoke', rid, `撤销人工修正（原 ${prev.score} 分 → 恢复 AI ${rec.score} 分）`);
    return { id: rid, aiScore: rec.score, manualScore: null, revoked: true };
  }

  const n = Math.round(Number(score));
  if (!isFinite(n) || n < 0 || n > 100) {
    throw Object.assign(new Error('修正分数须为 0–100 的整数'), { status: 400 });
  }
  const rsn = String(reason == null ? '' : reason).trim().slice(0, 200);
  if (!rsn) throw Object.assign(new Error('请填写修正原因（留痕用）'), { status: 400 });

  const pl = P(rec.payload, {}) || {};
  pl.manualScore = { score: n, reason: rsn, by: user.name, byId: user.id, at: nowStamp() };
  db.prepare('UPDATE records SET payload = ? WHERE id = ?').run(JSON.stringify(pl), rid);
  log(user.id, 'record.manual-score', rid, `人工修正 ${rec.score} → ${n}：${rsn.slice(0, 60)}`);
  return { id: rid, aiScore: rec.score, manualScore: pl.manualScore };
}


module.exports = {
  noteRow, qcRow, listCoachNotes, saveCoachNote, replyCoachNote, deleteCoachNote,
  QC_STATE, listQc, setQc, clearQc,
  cleanupSessions, sweepStaleSessions, setManualScore
};
