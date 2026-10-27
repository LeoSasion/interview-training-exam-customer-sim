'use strict';
/**
 * 公共基础层（P22 技术债拆分）
 *
 * 从 service.js 抽出的「用户 / 权限 / 数据可见范围」——
 * 这一层不依赖任何业务模块（只依赖 db），是任务、场景、记录、辅导的共同底座。
 *
 * 为什么先拆这一层：service.js 1563 行里，权限判断散落在各业务函数开头，
 * 改一条权限规则要通读全文。集中后规则只有一处，业务模块只管业务。
 */

const dbm = require('../db');
const { db } = dbm;

/* ---------------- 分页 ----------------
 * 铁律 7：items 之外的四个字段只在这一处定义（页面/任务/审计共用同一形状）。 */
function pageOf(query) {
  const raw = query || {};
  if (raw.limit === undefined && raw.offset === undefined) return null;
  const limit = Number(raw.limit);
  const offset = Number(raw.offset === undefined ? 0 : raw.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw Object.assign(new Error('分页参数校验未通过：limit 须为 1~500 的整数'), { status: 400 });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw Object.assign(new Error('分页参数校验未通过：offset 须为 >= 0 的整数'), { status: 400 });
  }
  return { limit, offset };
}

function pageMeta(total, page) {
  if (!page) return { total, limit: total, offset: 0, hasMore: false };
  return { total, limit: page.limit, offset: page.offset, hasMore: page.offset + page.limit < total };
}

/* ---------------- 用户 ---------------- */
function getUser(userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

/**
 * 取操作人。
 * ⚠️ 这里**不回落管理员**——身份由路由层（server/auth.js）解析后写入
 *    body.userId / query.userId 传入。解析不到就是 401，避免"漏传 userId
 *    即获得超管权限"的越权口子。
 */
function requireUser(userId) {
  const u = getUser(userId);
  if (!u) throw Object.assign(new Error('未登录或登录状态已失效'), { status: 401 });
  return u;
}

/* ---------------- 权限 ---------------- */
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

/* ---------------- 数据可见范围 ----------------
 * users.data_scope: all 全量 / dept 仅本部门 / mentor 仅本人带教
 * users.scope_ref : scope=mentor 时匹配 learners.coach 的值
 * 统一出口 scopedLearnerIds(user)：返回 null 表示不限制
 */
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

/* ---------------- 记录/学员级范围校验 ----------------
 * 两个都要用：做质检看的是记录、下发/导入看的是学员。集中在这里，
 * 免得每个业务模块自己写一遍 inScope 判断（写漏就是越权）。 */
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

module.exports = {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope,
  pageOf, pageMeta, assertLearnerInScope, assertRecordScope
};
