'use strict';
/**
 * 学员模块（P23 技术债拆分）
 *
 * 从 service.js 抽出的「学员批量导入 / 删除 / 列表」。
 * 导入是规模化第一道卡口，几个约束都在这里：
 *   - 四项必填、带教人必须是现存用户（教练台按 coach 名匹配可见范围）
 *   - 同名同部门跳过不覆盖
 *   - 逐行真实行号报错、单次上限 500
 *   - 删除学员时有成绩一律拒绝（避免无主记录）
 *
 * 依赖：lib/core（权限/可见范围/分页）+ db。不依赖任务、记录模块。
 */

const dbm = require('../db');
const { db, log, nowStamp, today, J, P } = dbm;
const {
  getUser, requireUser, assertCanEdit, assertCanReview,
  scopeOf, scopedLearnerIds, inScope, pageOf, pageMeta,
  assertLearnerInScope, assertRecordScope
} = require('./core');

const AVATAR_COLORS = ['#5B8FF9', '#F2994A', '#27AE60', '#EB5757', '#9B51E0', '#2D9CDB', '#F2C94C', '#56CCF2'];
const IMPORT_HEADER_ALIAS = {
  name: ['姓名', '名字', 'name'],
  dept: ['部门', '事业部', 'dept', 'department'],
  title: ['岗位', '职位', 'position', 'title'],
  coach: ['带教人', '带教主管', '导师', 'coach', 'mentor'],
  onboardAt: ['入职日期', '入职时间', 'onboard', 'joindate']
};

/** 极简 CSV 解析：支持双引号包裹与内嵌逗号/换行、"" 转义、BOM */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * 批量导入学员。
 *
 * 判重口径：同名 + 同部门视为同一人（跳过并报告），不覆盖已有数据。
 * 带教人**必须**是现存用户姓名——教练台的可见范围按 coach 名匹配，
 * 导进来的学员若带教人写错，就没有任何教练能看到他。
 */
function importLearners(payload, userId) {
  const user = requireUser(userId);
  if (!user.can_edit && user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无学员导入权限`), { status: 403 });
  }
  const rows = parseCsv(payload && payload.csv);
  if (!rows.length) throw Object.assign(new Error('CSV 为空'), { status: 400 });
  if (rows.length > 500) throw Object.assign(new Error('单次最多导入 500 人（分批更可控）'), { status: 400 });

  const norm = (x) => String(x || '').trim().toLowerCase();
  const first = rows[0].map(norm);
  const pick = (key) => {
    const aliases = IMPORT_HEADER_ALIAS[key].map(norm);
    for (let i = 0; i < first.length; i++) if (aliases.indexOf(first[i]) !== -1) return i;
    return -1;
  };
  const hasHeader = pick('name') !== -1 && pick('dept') !== -1;
  const idx = hasHeader
    ? { name: pick('name'), dept: pick('dept'), title: pick('title'), coach: pick('coach'), onboardAt: pick('onboardAt') }
    : { name: 0, dept: 1, title: 2, coach: 3, onboardAt: 4 };
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) throw Object.assign(new Error('只有表头、没有数据行'), { status: 400 });

  const coachNames = new Set(db.prepare('SELECT name, staff_name FROM users').all()
    .map((u) => String(u.staff_name || u.name || '').trim()).filter(Boolean));
  const existing = new Set(db.prepare('SELECT name, dept FROM learners').all()
    .map((l) => norm(l.name) + '|' + norm(l.dept)));
  let maxNum = 0;
  db.prepare('SELECT id FROM learners').all().forEach((r) => {
    const m = /^L(\d+)$/.exec(String(r.id || ''));
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  });

  const created = [], skipped = [], errors = [];
  const stamp = nowStamp();
  const ins = db.prepare(`INSERT INTO learners
    (id,name,avatar_text,color,dept,title,onboard_at,coach,payload)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  db.exec('BEGIN');
  try {
    body.forEach((r, i) => {
      const line = i + (hasHeader ? 2 : 1);
      const get = (k) => (idx[k] >= 0 && r[idx[k]] != null ? String(r[idx[k]]).trim() : '');
      const name = get('name'), dept = get('dept'), title = get('title'), coach = get('coach');
      const onboardAt = get('onboardAt') || stamp.slice(0, 10);
      if (!name || !dept || !title || !coach) {
        errors.push({ line, reason: '姓名/部门/岗位/带教人 四项都要填', row: r.join(',') });
        return;
      }
      if (!coachNames.has(coach)) {
        errors.push({ line, reason: `带教人「${coach}」不是系统里的用户（教练台按姓名匹配可见范围）`, row: r.join(',') });
        return;
      }
      const k = norm(name) + '|' + norm(dept);
      if (existing.has(k)) { skipped.push({ line, name, dept, reason: '已存在（同名同部门）' }); return; }
      existing.add(k);
      maxNum++;
      const id = 'L' + String(maxNum).padStart(2, '0');
      const color = AVATAR_COLORS[(maxNum - 1) % AVATAR_COLORS.length];
      const pl = {
        id, name, avatarText: name.slice(0, 1), color, dept,
        position: title, mentor: coach, joinDate: onboardAt
      };
      ins.run(id, name, name.slice(0, 1), color, dept, title, onboardAt, coach, JSON.stringify(pl));
      created.push({ id, name, dept, title, coach });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (created.length) {
    log(user.id, 'learners.import', '', `批量导入学员 ${created.length} 人（跳过 ${skipped.length}，错误 ${errors.length}）`);
  }
  return { created, skipped, errors, total: body.length };
}

/**
 * 删除学员（P13）：导入录错、员工离职时用。
 * 有成绩的**一律拒绝**——删了学员，成绩就变成无主记录（教练台会显示「未知学员」），
 * 正确顺序是先删成绩再删人（与 deleteRecord 的 404 语义配套）。
 */
function deleteLearner(id, userId) {
  const user = requireUser(userId);
  if (!user.can_edit && user.role !== 'admin') {
    throw Object.assign(new Error(`角色「${user.role}」无删除学员权限`), { status: 403 });
  }
  const lid = String(id || '');
  const row = db.prepare('SELECT * FROM learners WHERE id = ?').get(lid);
  if (!row) throw Object.assign(new Error('学员不存在'), { status: 404 });
  const recs = db.prepare('SELECT COUNT(*) AS n FROM records WHERE learner_id = ?').get(lid).n;
  if (recs > 0) {
    throw Object.assign(new Error(`该学员有 ${recs} 条成绩，先删除成绩再删人（避免出现无主记录）`), { status: 400 });
  }
  db.prepare('DELETE FROM learners WHERE id = ?').run(lid);
  log(user.id, 'learner.delete', lid, `删除学员 ${row.name}（${row.dept}）`);
  return { id: lid, deleted: true };
}

function listLearners(query, user) {
  const page = pageOf(query);
  const scopeIds = user ? scopedLearnerIds(user) : null;
  let rows = db.prepare('SELECT * FROM learners ORDER BY id').all();
  if (scopeIds !== null) rows = rows.filter((r) => scopeIds.indexOf(r.id) !== -1);
  const items = rows.map((r) => ({
    id: r.id, name: r.name, avatarText: r.avatar_text, color: r.color,
    dept: r.dept, title: r.title, onboardAt: r.onboard_at,
    coach: r.coach, mentor: r.coach      // app-data.js 用 mentor 命名，两边都给出
  }));
  const sliced = page ? items.slice(page.offset, page.offset + page.limit) : items;
  return Object.assign({ items: sliced }, pageMeta(items.length, page));
}


module.exports = { listLearners, importLearners, deleteLearner };
