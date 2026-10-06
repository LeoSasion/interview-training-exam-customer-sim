'use strict';
/**
 * HTTP 服务（原生 http，零依赖）
 *  - 静态：把项目根目录当静态根，原型页面直接可访问（推荐直接从本服务打开页面 → 同源，无跨域）
 *  - API ：/api/** 走 JSON 路由，按「公开 / 练习 / 管理」三档校验身份
 *  - CORS：默认只放行同源 + 本机来源 + file://，不再使用通配 *
 *  - 鉴权：见 server/auth.js（AUTH_MODE=open|enforce）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const config = require('./config');
const dbm = require('./db');
const svc = require('./service');

/**
 * baseUrl 是否指向本机 —— 即"用的是内置 Mock 模型"而不是真实大模型。
 *
 * 抽成函数是因为 `/status` 的 note 与启动横幅两处都要判断；
 * 两处各写一遍迟早会不一致（而"到底在用哪个模型"恰恰是最不能含糊的一件事）。
 */
function isLocalLlm() {
  let host = '';
  try { host = new URL(config.llm.baseUrl).hostname; } catch (e) { host = ''; }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
const gold = require('./goldset');
const ai = require('./ai');
const rubric = require('./rubric');
const auth = require('./auth');
const backup = require('./backup');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4'
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const target = path.normalize(path.join(config.root, rel));
  if (!target.startsWith(config.root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------------------------------------------ *
 * CORS：来源白名单（不再通配）
 *   放行条件（任一）：
 *     - 无 Origin（curl / 服务端调用 / 同源简单请求）
 *     - Origin === 'null' 且允许 file:// 页面
 *     - 在 CORS_ORIGINS 显式清单里
 *     - 本机来源（127.0.0.1 / localhost / [::1]，任意端口）且 CORS_ALLOW_LOCAL 打开
 *     - 与请求 Host 同源
 * ------------------------------------------------------------------ */
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  if (o === 'null') return config.cors.allowFile;
  if (config.cors.origins.indexOf(o) !== -1) return true;
  try {
    const u = new URL(o);
    if (config.cors.allowLocal &&
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1')) return true;
    const host = req.headers.host || '';
    if (host && u.host === host) return true;
  } catch (e) { /* ignore */ }
  return false;
}

function applyCors(req, res) {
  const o = req.headers.origin;
  if (!o) return true;
  if (!originAllowed(req)) return false;
  res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

/* ------------------------------------------------------------------ *
 * 路由表：method + path 正则 → handler(ctx)
 *   ctx = { req, res, params, query, body, user, authSource }
 *   权限档位 level：
 *     public   —— 无需身份（探活 / 登录 / Rubric）
 *     practice —— 练习通道，允许匿名（学员端必须「没登录也能练」）
 *     staff    —— 管理类接口，必须可解析出身份（enforce 模式下必须带 token）
 * ------------------------------------------------------------------ */
const routes = [];
function on(method, pattern, handler, level) {
  routes.push({ method, pattern, handler, level: level || 'staff' });
}

/* ---- 鉴权 ---- */
on('POST', /^\/api\/v1\/auth\/login$/, async (c) => {
  expectFields(c.body, ['account', 'password']);
  return auth.login(c.body.account, c.body.password, { ip: clientIp(c.req) });
}, 'public');

on('GET', /^\/api\/v1\/auth\/me$/, async (c) => ({
  user: auth.publicUser(c.user), source: c.authSource, auth: auth.modeInfo()
}));

on('POST', /^\/api\/v1\/auth\/password$/, async (c) => {
  expectFields(c.body, ['oldPassword', 'newPassword']);
  return auth.changePassword(c.user.id, c.body.oldPassword, c.body.newPassword);
});

on('GET', /^\/api\/v1\/auth\/accounts$/, async () => ({
  items: auth.listAccounts(), auth: auth.modeInfo()
}));

/* ---- 状态 ---- */
on('GET', /^\/api\/v1\/status$/, async () => {
  const aiStat = await ai.aiStatus();
  return {
    ok: true,
    service: '新员工培训系统 · AI 服务层',
    version: 'p7',
    db: path.basename(config.dbFile),
    dbSync: dbm.pragmas(),
    host: config.host,
    llm: {
      configured: config.llm.enabled,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      note: (() => {
        if (!config.llm.enabled) return '未配置 LLM_API_KEY，自动降级为关键词引擎 + 剧本';
        // ⚠️ 别把「配了 Key」直接说成「走真实模型」：本机 mock 也满足"已配置"，
        // 这样写会让人（包括自己）误以为已在用真实大模型。界面上不许在这种事上说谎。
        return isLocalLlm()
          ? '已配置 Key，但 baseUrl 指向本机 —— 当前是内置 Mock 模型，不是真实大模型（仅用于验证全链路）'
          : '已配置 Key，走真实模型';
      })()
    },
    live: aiStat && aiStat.live ? aiStat.live : { ok: !!config.llm.enabled, mode: config.llm.enabled ? 'unchecked' : 'keyword' },
    auth: auth.modeInfo(),
    cors: { origins: config.cors.origins, allowLocal: config.cors.allowLocal, allowFile: config.cors.allowFile },
    rubricVersion: config.rubricVersion,
    stats: svc.stats()
  };
}, 'public');

on('GET', /^\/api\/v1\/ai\/status$/, async () => ai.aiStatus(), 'public');
on('GET', /^\/api\/v1\/rubric$/, async () => rubric.currentRubric(), 'public');

/* ---- 场景库 ---- */
on('GET', /^\/api\/v1\/scenes$/, async (c) => ({ items: svc.listScenes(c.query) }));
// ⚠️ 必须排在 /scenes/:id 之前：路由按**注册顺序**首个匹配，
//    否则 'published' 会被当成场景 id 走进详情分支。
//    练习档（匿名可读）：学员必须没登录也能取到场景库，且只拿得到已发布场景。
on('GET', /^\/api\/v1\/scenes\/published$/, async () => ({
  items: svc.listPublishedScenes(), version: 'published'
}), 'practice');
on('GET', /^\/api\/v1\/scenes\/([^/]+)$/, async (c) => {
  const s = svc.getScene(c.params[0]);
  if (!s) throw Object.assign(new Error('场景不存在'), { status: 404 });
  return s;
});
on('POST', /^\/api\/v1\/scenes$/, async (c) => svc.saveScene(c.body, c.user.id));
on('PUT', /^\/api\/v1\/scenes\/([^/]+)$/, async (c) =>
  svc.saveScene(Object.assign({}, c.body, { id: c.params[0] }), c.user.id));
on('DELETE', /^\/api\/v1\/scenes\/([^/]+)$/, async (c) => svc.deleteScene(c.params[0], c.user.id));

on('GET', /^\/api\/v1\/scenes\/([^/]+)\/versions$/, async (c) => ({ items: svc.listVersions(c.params[0]) }));
on('POST', /^\/api\/v1\/scenes\/([^/]+)\/rollback$/, async (c) => {
  expectFields(c.body, ['v']);
  return svc.rollback(c.params[0], c.body.v, c.user.id);
});

/* ---- 审批流 ---- */
on('POST', /^\/api\/v1\/scenes\/([^/]+)\/submit$/, async (c) => svc.submitReview(c.params[0], c.user.id));
on('POST', /^\/api\/v1\/scenes\/([^/]+)\/approve$/, async (c) => svc.approveScene(c.params[0], c.user.id));
on('POST', /^\/api\/v1\/scenes\/([^/]+)\/reject$/, async (c) => svc.rejectScene(c.params[0], c.body.reason, c.user.id));
on('POST', /^\/api\/v1\/scenes\/([^/]+)\/offline$/, async (c) => svc.offlineScene(c.params[0], c.user.id));

/* ---- 对话（练习通道：允许匿名，学员端必须没登录也能练） ---- */
on('POST', /^\/api\/v1\/session\/([^/]+)\/turn$/, async (c) =>
  svc.turn(Object.assign({}, c.body, { sessionId: c.params[0] })), 'practice');
on('POST', /^\/api\/v1\/session\/([^/]+)\/finish$/, async (c) =>
  svc.finish(Object.assign({}, c.body, { sessionId: c.params[0] })), 'practice');

/* ---- 任务（P4）：学员端只读自己的；下发/改期/结束/删除需 staff 身份 ---- */
on('GET', /^\/api\/v1\/tasks$/, async (c) => {
  const learnerId = c.query.learnerId;
  // 学员端：允许匿名读自己的任务清单（不登录也要能练）
  if (learnerId) return { items: svc.listTasks({ learnerId, status: c.query.status }, null, true) };
  if (!c.user) throw Object.assign(new Error('未登录或登录状态已失效'), { status: 401 });
  return { items: svc.listTasks(c.query, c.user) };
}, 'practice');

on('GET', /^\/api\/v1\/tasks\/([^/]+)$/, async (c) => {
  const t = svc.getTask(c.params[0]);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  return t;
});
on('POST', /^\/api\/v1\/tasks$/, async (c) => svc.saveTask(c.body, c.user.id));
on('PUT', /^\/api\/v1\/tasks\/([^/]+)$/, async (c) =>
  svc.saveTask(Object.assign({}, c.body, { id: c.params[0] }), c.user.id));
on('POST', /^\/api\/v1\/tasks\/([^/]+)\/status$/, async (c) => {
  expectFields(c.body, ['status']);
  return svc.setTaskStatus(c.params[0], c.body.status, c.user.id);
});
on('DELETE', /^\/api\/v1\/tasks\/([^/]+)$/, async (c) => svc.deleteTask(c.params[0], c.user.id));

/* ---- 教练动作（P5）：辅导记录 / 对话质检 ----
 * 这两件事是**带教主管的本职**，所以不卡 can_edit / can_review，
 * 只要求可解析出身份（staff），范围校验在 service 层按数据可见范围做。 */
on('GET', /^\/api\/v1\/coach-notes$/, async (c) => ({ items: svc.listCoachNotes(c.query.learnerId, c.user) }));
on('POST', /^\/api\/v1\/coach-notes$/, async (c) => svc.saveCoachNote(c.body, c.user.id));
on('DELETE', /^\/api\/v1\/coach-notes\/([^/]+)$/, async (c) => svc.deleteCoachNote(c.params[0], c.user.id));
on('GET', /^\/api\/v1\/qc$/, async (c) => ({ items: svc.listQc(c.user) }));
on('POST', /^\/api\/v1\/records\/([^/]+)\/qc$/, async (c) => {
  expectFields(c.body, ['state']);
  return svc.setQc(c.params[0], c.body.state, c.body.note, c.user.id);
});
on('DELETE', /^\/api\/v1\/records\/([^/]+)\/qc$/, async (c) => svc.clearQc(c.params[0], c.user.id));
// 逐轮对话（P7）：列表接口刻意不带正文，页面按需取这一条
on('GET', /^\/api\/v1\/records\/([^/]+)\/turns$/, async (c) => svc.listTurns(c.params[0], c.user.id));
// 必须排在 /records/:id/qc 之后：前者带子路径，先匹配更具体的
on('DELETE', /^\/api\/v1\/records\/([^/]+)$/, async (c) => svc.deleteRecord(c.params[0], c.user.id));

/* ---- 数据查询（全部按登录身份的数据范围过滤） ---- */
on('GET', /^\/api\/v1\/records$/, async (c) => ({ items: svc.listRecords(c.query, c.user) }));
on('GET', /^\/api\/v1\/learners$/, async (c) => ({ items: svc.listLearners(c.user) }));
on('GET', /^\/api\/v1\/users$/, async () => ({ items: svc.listUsers() }));
on('GET', /^\/api\/v1\/audit$/, async (c) => ({ items: svc.listAuditLog(Number(c.query.limit) || 100, c.user) }));

/* ---- 金标集与校准 ---- */
on('GET', /^\/api\/v1\/goldset$/, async () => ({ items: gold.listGold() }));
on('POST', /^\/api\/v1\/goldset\/import$/, async (c) => gold.importGold(c.body.items || [], c.user.id));
on('POST', /^\/api\/v1\/goldset\/calibrate$/, async (c) => gold.calibrate(c.body || {}));
on('GET', /^\/api\/v1\/goldset\/runs$/, async (c) => ({ items: gold.listRuns(Number(c.query.limit) || 20) }));

/* ---- 运维：备份 ---- */
on('GET', /^\/api\/v1\/admin\/backup$/, async () => ({ items: backup.list(), keep: backup.keep, dir: config.backupDir }));
on('POST', /^\/api\/v1\/admin\/backup$/, async (c) => backup.create((c.user && c.user.name) || 'manual'));

/* ------------------------------------------------------------------ *
 * 入参校验小工具
 * ------------------------------------------------------------------ */
function expectFields(body, fields) {
  const miss = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (miss.length) throw Object.assign(new Error('缺少必填字段：' + miss.join('、')), { status: 400 });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '';
}

/* ------------------------------------------------------------------ *
 * 请求分发
 * ------------------------------------------------------------------ */
function checkLevel(level, idRes) {
  if (level !== 'staff') return null;
  if (idRes.error) return idRes.error;
  if (!idRes.user) {
    return Object.assign(new Error(
      config.auth.mode === 'enforce' ? '该接口需要登录（AUTH_MODE=enforce）' : '需要登录'), { status: 401 });
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // 预检
  if (req.method === 'OPTIONS') {
    if (!originAllowed(req)) { res.writeHead(403); return res.end(); }
    applyCors(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-User-Id');
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204);
    return res.end();
  }
  const corsOk = applyCors(req, res);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  if (!corsOk) return sendJSON(res, 403, { ok: false, error: '来源不被允许：' + req.headers.origin });

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.pattern);
    if (!m) continue;
    try {
      const body = (req.method === 'GET' || req.method === 'DELETE') ? {} : await readBody(req);

      // 身份解析：Authorization: Bearer 优先；open 模式下兼容 X-User-Id / body.userId
      const idRes = auth.resolve(req, body, parsed.query);
      const denied = checkLevel(r.level, idRes);
      if (denied) throw denied;

      // 以解析结果为准，避免"请求体自称身份"覆盖 token 身份
      if (idRes.user) {
        body.userId = idRes.user.id;
        if (!parsed.query.userId) parsed.query.userId = idRes.user.id;
      }

      const out = await r.handler({
        req, res, params: m.slice(1), query: parsed.query, body,
        user: idRes.user, authSource: idRes.source
      });
      return sendJSON(res, 200, { ok: true, data: out });
    } catch (e) {
      const code = e.status || 500;
      if (code >= 500) console.error('[API]', pathname, e);
      return sendJSON(res, code, {
        ok: false, error: e.message,
        validate: e.validate || undefined
      });
    }
  }
  sendJSON(res, 404, { ok: false, error: '接口不存在：' + req.method + ' ' + pathname });
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function start(opts) {
  opts = opts || {};
  const seed = dbm.seedIfEmpty();
  if (seed.seeded) {
    console.log(`[db] 已初始化：${seed.scenes} 场景 / ${seed.learners} 学员 / ${seed.tasks} 任务 / ${seed.records} 记录 / ${seed.goldSet} 金标 / ${seed.coachNotes || 0} 辅导记录 / ${seed.qcMarks || 0} 质检 / ${seed.dialogues || 0} 条成绩的逐轮对话`);
  }
  // 老库升级（如 P4→P5）时补了演示内容也要说一声，
  // 否则"教练台怎么突然有数据了 / 怎么还是空的"没人能判断
  const up5 = dbm.MIGRATED_P5;
  if (up5 && !up5.contentSkipped && (up5.coachNotes || up5.qcMarks)) {
    console.log(`[db] P5 升级补内容：辅导记录 ${up5.coachNotes} 条 / 质检结论 ${up5.qcMarks} 条`);
  }
  // P7：老库的演示成绩回填逐轮对话 —— 不说一声的话，
  // 「教练台怎么突然能点开对话了」同样没人能判断
  const up7 = dbm.MIGRATED_P7;
  if (up7 && up7.dialogues) {
    console.log(`[db] P7 升级补逐轮对话：${up7.dialogues} 条成绩`);
  }
  // 账号初始化：给没有口令的用户分配账号与初始口令（首次启动会打印一份）
  const created = auth.ensureAccounts(!!opts.resetPasswords);

  server.listen(config.port, config.host, () => {
    const lan = config.host === '0.0.0.0';
    console.log('');
    console.log('  新员工培训系统 · AI 服务层已启动');
    console.log('  ─────────────────────────────────────────');
    console.log(`  服务地址   http://127.0.0.1:${config.port}   ${lan ? '（已监听 0.0.0.0，内网可访问）' : '（仅本机）'}`);
    console.log(`  接口前缀   /api/v1`);
    console.log(`  数据库     ${config.dbFile}`);
    const pgm = dbm.pragmas();
    console.log(`  落盘级别   ${pgm.journalMode || '?'} + synchronous=${pgm.synchronousName}` +
      (pgm.synchronousName === 'FULL' ? '（每次提交 fsync，写吞吐会掉到个位数，' + '如需高性能请去掉 DB_SYNC=FULL）' : '（WAL 推荐值）'));
    console.log(`  备份目录   ${config.backupDir}（保留最近 ${backup.keep} 份）`);
    console.log(`  大模型     ${config.llm.enabled
      ? `已配置（${config.llm.model} @ ${config.llm.baseUrl}）` + (isLocalLlm() ? ' ← 指向本机，是内置 Mock 模型，不是真实大模型' : '')
      : '未配置 Key —— 自动降级为关键词引擎 + 剧本'}`);
    console.log(`  Rubric     ${config.rubricVersion}`);
    console.log(`  鉴权模式   ${config.auth.mode}${config.auth.mode === 'open' ? '（未带 token 时回落演示身份；生产请设 AUTH_MODE=enforce）' : '（管理类接口一律要求登录）'}`);
    console.log('  ─────────────────────────────────────────');
    if (created.length) {
      console.log('  初始账号（请登录后立即修改口令；服务端不保存明文）');
      created.forEach((a) => {
        console.log(`    ${a.account.padEnd(12)} ${a.password.padEnd(12)} ${a.name}（${a.role}）`);
      });
      console.log('');
    }
    console.log('  页面入口（推荐从此地址打开，天然同源、无跨域）');
    console.log(`    学员端     http://127.0.0.1:${config.port}/仿真培训原型-微信风格.html`);
    console.log(`    管理后台   http://127.0.0.1:${config.port}/管理后台-仿真培训.html`);
    console.log(`    教练工作台 http://127.0.0.1:${config.port}/教练工作台-带教主管.html`);
    console.log('');
  });
}

if (require.main === module) start();

module.exports = { server, start, routes };
