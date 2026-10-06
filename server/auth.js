'use strict';
/**
 * 鉴权：账号口令 → 无状态 token（HMAC-SHA256 签名，零依赖）
 *
 * 设计取舍
 *  - **无状态**：token 自带 uid/role/exp，服务端不落 session 表；
 *    密钥存在 SQLite meta 表（首次启动生成），因此重启服务不会踢掉在线用户。
 *  - **不让鉴权挡住「没后端也能用」**：前端页面在服务端不可用时照常离线运行，
 *    见 assets/ai-bridge.js 与 assets/admin-server-sync.js。
 *  - **两种模式**：
 *      AUTH_MODE=open    （默认）带 token 时按 token 身份严格校验；不带 token
 *                        时回落到演示身份（便于本地演示，改 URL 即可切角色）。
 *      AUTH_MODE=enforce （生产）所有管理类接口必须带有效 token，否则 401。
 *    模式对前端完全透明，服务端在 /status 里回报，后台界面会显示出来。
 *
 * token 格式： base64url(JSON payload) + '.' + base64url(HMAC)
 */

const crypto = require('crypto');
const dbm = require('./db');
const config = require('./config');
const pw = require('./password');

const { db, log } = dbm;

/* ------------------------------------------------------------------ *
 * 签名密钥
 * ------------------------------------------------------------------ */
let _secret = null;
function secret() {
  if (_secret) return _secret;
  if (config.auth.secret) { _secret = config.auth.secret; return _secret; }
  const row = db.prepare("SELECT v FROM meta WHERE k = 'auth_secret'").get();
  if (row && row.v) { _secret = row.v; return _secret; }
  _secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('auth_secret', ?)").run(_secret);
  return _secret;
}

const b64u = (s) => Buffer.from(s).toString('base64url');

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + sig;
}

/** 校验 token → payload | null */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || !payload.uid) return null;
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

/* ------------------------------------------------------------------ *
 * 用户形状
 * ------------------------------------------------------------------ */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, account: u.account || '',
    // 干净姓名（无「区域教练 · 」前缀）：教练台按它匹配 learners.coach
    staffName: u.staff_name || '',
    role: u.role, dept: u.dept,
    canEdit: !!u.can_edit, canReview: !!u.can_review,
    scope: u.data_scope || 'all',
    scopeRef: u.scope_ref || '',
    scopeLabel: dbm.scopeLabel(u)
  };
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
function getUserByAccount(account) {
  if (!account) return null;
  return db.prepare('SELECT * FROM users WHERE lower(account) = lower(?)').get(String(account)) || null;
}

/* ------------------------------------------------------------------ *
 * 登录失败节流（进程内，够用；多实例部署时应换 Redis 之类）
 * ------------------------------------------------------------------ */
const FAILS = new Map();           // account -> { n, until }
const MAX_FAIL = 5;
const LOCK_MS = 5 * 60 * 1000;

function failState(account) {
  const k = String(account || '').toLowerCase();
  let f = FAILS.get(k);
  if (f && f.until && Date.now() > f.until) { FAILS.delete(k); f = null; }
  return { k: k, f: f };
}
function noteFail(k) {
  const f = FAILS.get(k) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= MAX_FAIL) f.until = Date.now() + LOCK_MS;
  FAILS.set(k, f);
}
function clearFail(k) { FAILS.delete(k); }

/* ------------------------------------------------------------------ *
 * 登录 / 改密
 * ------------------------------------------------------------------ */
function login(account, password, meta) {
  const st = failState(account);
  if (st.f && st.f.until && Date.now() < st.f.until) {
    const mins = Math.ceil((st.f.until - Date.now()) / 60000);
    throw Object.assign(new Error(`登录失败次数过多，请 ${mins} 分钟后再试`), { status: 429 });
  }
  const u = getUserByAccount(account);
  if (!u || !pw.verifyPassword(password, u.salt, u.password_hash)) {
    noteFail(st.k);
    log('anonymous', 'auth.login.fail', String(account || ''), (meta && meta.ip) || '');
    throw Object.assign(new Error('账号或口令不正确'), { status: 401 });
  }
  clearFail(st.k);
  const ttl = config.auth.ttlHours * 3600 * 1000;
  const token = sign({
    uid: u.id, name: u.name, role: u.role,
    iat: Date.now(), exp: Date.now() + ttl
  });
  log(u.id, 'auth.login', u.id, '登录成功');
  return {
    token,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    ttlHours: config.auth.ttlHours,
    user: publicUser(u)
  };
}

function changePassword(uid, oldPwd, newPwd) {
  const u = getUserById(uid);
  if (!u) throw Object.assign(new Error('用户不存在'), { status: 401 });
  if (!pw.verifyPassword(oldPwd, u.salt, u.password_hash)) {
    throw Object.assign(new Error('原口令不正确'), { status: 400 });
  }
  if (!newPwd || String(newPwd).length < 6) {
    throw Object.assign(new Error('新口令至少 6 位'), { status: 400 });
  }
  const h = pw.hashPassword(newPwd);
  db.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?').run(h.salt, h.hash, uid);
  log(uid, 'auth.password', uid, '修改口令');
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 请求身份解析
 * ------------------------------------------------------------------ */
function bearer(req) {
  const h = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : null;
}

/**
 * 解析请求身份
 * @returns {{user:object|null, source:string, error:object|null, token:string|null}}
 *   source ∈ {token, header, fallback, none}
 */
function resolve(req, body, query) {
  const t = bearer(req);
  if (t) {
    const p = verifyToken(t);
    if (!p) {
      return { user: null, source: 'token-invalid', token: t,
        error: Object.assign(new Error('登录状态已失效，请重新登录'), { status: 401 }) };
    }
    const u = getUserById(p.uid);
    if (!u) {
      return { user: null, source: 'token-invalid', token: t,
        error: Object.assign(new Error('账号已被移除，请重新登录'), { status: 401 }) };
    }
    return { user: u, source: 'token', error: null, token: t };
  }
  // 兼容：显式声明操作人（演示 / 内部脚本用），仅在 open 模式下生效
  if (config.auth.mode !== 'enforce') {
    const claimed = (body && body.userId) || (query && query.userId) ||
      (req && req.headers && req.headers['x-user-id']);
    if (claimed) {
      const u = getUserById(String(claimed));
      if (u) return { user: u, source: 'header', error: null, token: null };
    }
    const admin = getUserById('U-ADMIN');
    return { user: admin, source: 'fallback', error: null, token: null };
  }
  return { user: null, source: 'none', error: null, token: null };
}

/* ------------------------------------------------------------------ *
 * 账号初始化：给没有账号的用户分配账号与初始口令
 * ------------------------------------------------------------------ */
const DEFAULT_ACCOUNTS = {
  'U-ADMIN': { account: 'admin', password: 'admin123' },
  'U-OP01': { account: 'wangqian', password: 'op123456' },
  'U-OP02': { account: 'limeng', password: 'op123456' },
  'U-REV01': { account: 'zhangtao', password: 'rev123456' },
  'U-COACH1': { account: 'chenxi', password: 'coach123' },
  'U-COACH2': { account: 'zhoumin', password: 'coach123' },
  'U-COACH3': { account: 'zhaolei', password: 'coach123' }
};

/**
 * 保证每个用户都有账号与口令。
 * @param {boolean} reset true = 强制重置为默认口令（恢复出厂时用）
 * @returns {Array} 新建/重置的账号清单（含明文口令，仅用于启动日志）
 */
function ensureAccounts(reset) {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const created = [];
  const upd = db.prepare('UPDATE users SET account = ?, salt = ?, password_hash = ? WHERE id = ?');
  const updAcc = db.prepare('UPDATE users SET account = ? WHERE id = ?');
  const taken = new Set(users.map((u) => (u.account || '').toLowerCase()).filter(Boolean));

  users.forEach((u, i) => {
    const def = DEFAULT_ACCOUNTS[u.id];
    let account = u.account || (def && def.account) || ('user' + (i + 1));
    // 保证账号唯一（老库可能已手工填过）
    let n = 1;
    while (taken.has(account.toLowerCase()) && account.toLowerCase() !== (u.account || '').toLowerCase()) {
      account = ((def && def.account) || 'user' + (i + 1)) + (++n);
    }
    taken.add(account.toLowerCase());
    if (!u.account) updAcc.run(account, u.id);
    if (!u.password_hash || !u.salt || reset) {
      const plain = (def && def.password) || pw.randomPassphrase();
      const h = pw.hashPassword(plain);
      upd.run(account, h.salt, h.hash, u.id);
      created.push({ id: u.id, account: account, password: plain, role: u.role, name: u.name });
    }
  });
  return created;
}

/** 列出账号（不含口令），供后台展示 */
function listAccounts() {
  return db.prepare(`SELECT id,name,staff_name,account,role,dept,can_edit AS canEdit,can_review AS canReview,
      data_scope AS scope, scope_ref AS scopeRef FROM users ORDER BY id`)
    .all().map((r) => ({
      id: r.id, name: r.name, staffName: r.staff_name || '', account: r.account, role: r.role, dept: r.dept,
      canEdit: !!r.canEdit, canReview: !!r.canReview,
      scope: r.scope || 'all', scopeRef: r.scopeRef || '', scopeLabel: dbm.scopeLabel(r),
      hasPassword: !!db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND password_hash IS NOT NULL').get(r.id)
    }));
}

/** 当前鉴权模式信息（给 /status 用） */
function modeInfo() {
  return {
    mode: config.auth.mode,
    enforced: config.auth.mode === 'enforce',
    ttlHours: config.auth.ttlHours,
    note: config.auth.mode === 'enforce'
      ? '所有管理类接口必须携带有效 token'
      : '未带 token 时回落为演示身份（本地演示便利）；设为 AUTH_MODE=enforce 可强制登录'
  };
}

module.exports = {
  secret, sign, verifyToken, publicUser,
  getUserById, getUserByAccount,
  login, changePassword, resolve, ensureAccounts, listAccounts, modeInfo
};
