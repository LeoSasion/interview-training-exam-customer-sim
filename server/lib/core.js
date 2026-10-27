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

module.exports = {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope
};
