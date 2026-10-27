'use strict';
/**
 * 场景模块（P22 技术债拆分）
 *
 * 从 service.js 抽出的「场景库 CRUD / 版本 / 审批 / 校验 / 审计」。
 * 这一块是原来最大的单块（~300 行）：内容治理的闸门都在这儿——
 *   canAssign（只有已发布能下发）、提交审核、审批人不能审自己提交的、
 *   已发布被改自动回 review。
 *
 * 依赖：lib/core（权限）+ db。不依赖任务/记录模块。
 */

const dbm = require('../db');
const { db, log, sceneRow, nowStamp, today, J, P } = dbm;
const { requireUser, assertCanEdit, assertCanReview } = require('./core');

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

/**
 * 复制场景为草稿（P14）
 *
 * 运营最常做的事是「基于现有场景改一版」。重新建空场景再逐字段填太折磨，
 * 所以给一键复制：复制体不传 id/code（由 saveScene 生成），强制 draft 并走正常审核流程——
 * 复制品绝不能绕过「提交审核 → 审批发布」的闸门。
 */
function duplicateScene(id, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);
  const src = getScene(id);
  if (!src) throw Object.assign(new Error('场景不存在'), { status: 404 });
  const clone = {
    name: String(src.name || '场景') + '（副本）',
    subtitle: src.subtitle || '',
    avatarText: src.avatarText || '',
    color: src.color || '#5B8FF9',
    taskName: src.taskName || '',
    channel: src.channel || '',
    category: src.category || '',
    difficulty: src.difficulty || '',
    passLine: src.passLine || 60,
    duration: src.duration || 0,
    status: 'active',
    brief: src.brief || '',
    script: src.script || [],
    objectives: src.objectives || [],
    voicePool: src.voicePool || [],
    tips: src.tips || []
  };
  const saved = saveScene(clone, userId);   // 不传 id → 新建 + 强制 draft
  log(user.id, 'scene.duplicate', saved.id, `复制场景：${src.name} → ${saved.name}`);
  return saved;
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

module.exports = {
  listScenes, sceneForLearner, listPublishedScenes, auditOf, countVersions, getScene,
  canAssign, validateScene, nextSceneSeq, saveScene, duplicateScene, deleteScene,
  listVersions, rollback, submitReview, approveScene, rejectScene, offlineScene
};
