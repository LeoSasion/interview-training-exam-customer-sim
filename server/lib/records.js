'use strict';
/**
 * 会话与成绩模块（P23 技术债拆分）
 *
 * 从 service.js 抽出的「会话创建 / 逐轮 / 交卷评分 / 成绩查询 / 逐轮回读 / 删除」。
 * 这是全系统最关键的一段：学员每说一句都走 turn，交卷走 finish，
 * 而 finish 的分数口径必须与前端 scoring-engine 完全一致（铁律 9）。
 *
 * 依赖：lib/core（权限/范围/分页）+ db + ai（评分）+ scenes（达标线/目标，延迟 require）。
 */

const dbm = require('../db');
const { db, log, nowStamp, today, J, P } = dbm;
const ai = require('../ai');
const config = require('../config');
const {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope, pageOf, pageMeta,
  assertLearnerInScope, assertRecordScope
} = require('./core');

/** 延迟取场景（finish 要用目标与达标线，但场景模块不该互相 require） */
function sceneOf(id) {
  // eslint-disable-next-line global-require
  return require('./scenes').getScene(id);
}

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
  const scene = sceneOf(sceneId || sess.scene_id);
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
  const scene = sceneOf(sess.scene_id);
  /* 场景可能已被删除/下线（学员正练着，运营把场景下架了）。
   * 以前这里直接读 scene.objectives → 抛 TypeError，学员练完拿不到成绩（白练）。
   * 现在降级出分：目标置空、达标线用兜底 60，并在返回里标 sceneMissing 让前端说明。 */
  const sceneMissing = !scene;
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
  const objectives = ((scene && scene.objectives) || []).map((o, i) => {
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
  const passLine = (scene && scene.passLine) || 60;
  const passed = total >= passLine;

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
    score: total, passLine, passed, sceneMissing,
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
 * ================================================================== *
 * 列表分页统一口径（P9）—— 五个列表接口（records/learners/tasks/coach-notes/audit）共用：
 *   - 不带 limit/offset：返回全量（三端水合与离线兜底都依赖全量，刻意保持向后兼容）。
 *     唯一例外是 audit：不带参数默认只回最近 100 条（审计只增不减，全量会越滚越大）。
 *   - 带：limit ∈ [1,500]、offset >= 0，非法一律 400（宁拒不猜，防误拉全库）。
 *   - 返回统一为 { items, total, limit, offset, hasMore }：
 *     total 是「筛选后」的总数（不是全库总数）；hasMore 告诉调用方还有没有下一页。
 *   - data.items 的形状与旧版逐字段一致，只多不删 → 同步层 data.items 解包零改动。
 * ⚠️ 翻页必须配「稳定排序」（次级键 id），否则同一页在两次请求间可能重/漏行。 */
function listRecords(query, user) {
  query = query || {};
  let sql = 'SELECT * FROM records';
  const where = [], args = [];
  if (query.learnerId) { where.push('learner_id = ?'); args.push(String(query.learnerId)); }
  if (query.sceneId) { where.push('scene_id = ?'); args.push(String(query.sceneId)); }
  if (query.taskId) { where.push('task_id = ?'); args.push(String(query.taskId)); }
  // 来源筛选（P8）：free = 自主练习（无任务归属），task = 任务考核。
  // task_id 理论上恒为非 NULL（startTurn 写库前已归一为 ''），但筛选仍按防 NULL 写法，
  // 避免手工导入的历史行漏网。
  if (query.mode === 'free') {
    where.push("(task_id IS NULL OR task_id = '')");
  } else if (query.mode === 'task') {
    where.push("task_id IS NOT NULL AND task_id != ''");
  }

  // 数据范围：非全量账号只看得到自己范围内的学员记录
  const scopeIds = user ? scopedLearnerIds(user) : null;
  if (scopeIds !== null) {
    if (!scopeIds.length) return [];
    where.push(`learner_id IN (${scopeIds.map(() => '?').join(',')})`);
    args.push(...scopeIds);
  }

  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  // 稳定排序：at 相同的行按 id 定序，翻页才不重不漏（SQLite 对同键顺序无保证）
  sql += ' ORDER BY at DESC, id';

  // 附带质检结论（P5）：教练台要按「已通过 / 待统一话术」直接渲染状态列
  const qcMap = {};
  db.prepare('SELECT record_id, state FROM record_qc').all().forEach((q) => { qcMap[q.record_id] = q.state; });

  // 分页（P9）：total 用同 WHERE 复查（含 scope / 筛选 / mode），不带分页时全量
  const page = pageOf(query);
  let total = null;
  if (page) {
    const cntSql = 'SELECT COUNT(*) AS n FROM records' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    total = db.prepare(cntSql).get(...args).n;
    sql += ' LIMIT ? OFFSET ?';
    args.push(page.limit, page.offset);
  }

  const items = db.prepare(sql).all(...args).map((r) => {
    const pl = P(r.payload, {}) || {};
    return {
      id: r.id, learnerId: r.learner_id, taskId: r.task_id, sceneId: r.scene_id,
      // 来源标记（P8）：task = 任务考核（成绩归因到某条下发任务）；
      // free = 自主练习（学员从场景池自己挑的，不占任务进度）。
      // 推导而非落库列：task_id 就是唯一事实，加列只会多一处可能漂移的口径。
      mode: (r.task_id || '') !== '' ? 'task' : 'free',
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
      source: r.source,
      // 人工修正分（P12）：带教主管推翻 AI 判断时写在这里，与 AI 分并存（不删原分）
      manualScore: pl.manualScore || null
    };
  });

  // pageOf 之外（不带分页）total 用实际行数，形状统一：调用方永远能读 total/hasMore
  return Object.assign({ items }, pageMeta(total === null ? items.length : total, page));
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


module.exports = {
  getOrCreateSession, turnRow, turn, evidenceTurn, finish,
  listRecords, listTurns, deleteRecord
};
