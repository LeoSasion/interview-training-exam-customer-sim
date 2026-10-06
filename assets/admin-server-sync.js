'use strict';
/**
 * 服务端同步层（可选加载）—— **管理后台与教练工作台共用**
 *
 * 名字里的 admin 只是历史原因；两个 staff 端用的是同一套登录态与同一个 REST 接口，
 * 所以共用这一份适配层（token 存在同一个 key，在管理端登录过，教练台打开即已登录）。
 *
 * 设计原则与 `assets/ai-bridge.js` 一致：**增强而非依赖**。
 *   - 后端可用：场景库以服务端为准（真正的落库 / 版本 / 审批 / 审计），
 *     后台本地的 localStorage 退化为「离线草稿缓存」。
 *   - 后端不可用：完全走原有 localStorage 逻辑，页面行为零变化。
 *
 * 鉴权：
 *   - 登录后 token 存在 localStorage('TRAIN_AUTH_V1')，请求带
 *     `Authorization: Bearer <token>`；服务端以 token 身份为准（请求体自称无效）。
 *   - 服务端返回 401（token 失效 / enforce 模式未登录）时清空本地登录态并
 *     触发 `ADMIN_SYNC.onAuthLost`，由宿主页面弹出登录框。
 *
 * 用法：
 *   ADMIN_SYNC.probe(true).then(ok => ...)
 *   ADMIN_SYNC.login('wangqian','op123456').then(r => ...)
 *   ADMIN_SYNC.pull().then(lib => { if (lib) applyServerLib(lib); });
 *   ADMIN_SYNC.save(scene).then(...);
 *   ADMIN_SYNC.act(id, 'submit'|'approve'|'reject'|'offline'|'rollback', extra)
 *   ADMIN_SYNC.coachNotes('L01') / addCoachNote({...}) / qcList() / setQc(rid,'ok')
 *
 * 注意：本文件**不修改任何页面状态**，只负责 HTTP 往返与数据形状转换，
 *       是否采用返回值由宿主页面决定 —— 保证「同步失败不破坏本地编辑」。
 */
(function (root) {
  var AUTH_KEY = 'TRAIN_AUTH_V1';

  /* 候选基址：?api= 显式指定 > 同源 /api/v1 > 127.0.0.1:8848 */
  function candidateBases() {
    var list = [];
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.get('api')) return [qs.get('api')];
    } catch (e) { /* ignore */ }
    try {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        list.push(location.origin + '/api/v1');
      }
    } catch (e) { /* ignore */ }
    list.push('http://127.0.0.1:8848/api/v1');
    return list.filter(function (x, i) { return list.indexOf(x) === i; });
  }

  var state = {
    status: 'unknown', base: candidateBases()[0], info: null,
    checkedAt: 0, auth: null, needLogin: false, lastError: null
  };

  /* 演示身份（open 模式下未登录时使用）；?as=U-COACH1 可预置 */
  try {
    var q0 = new URLSearchParams(location.search);
    if (q0.get('as')) state.user = q0.get('as');
  } catch (e) { /* ignore */ }
  state.user = state.user || 'U-ADMIN';

  /* ---- 登录态持久化 ---- */
  function loadAuth() {
    try {
      var raw = root.localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.token) return null;
      if (o.expiresAt && Date.now() > Date.parse(o.expiresAt)) return null;
      return o;
    } catch (e) { return null; }
  }
  function saveAuth(o) {
    try { root.localStorage.setItem(AUTH_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }
  function clearAuth() {
    try { root.localStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
  }
  state.auth = loadAuth();

  function timeout(ms) {
    return new Promise(function (_, rej) { setTimeout(function () { rej(new Error('请求超时')); }, ms); });
  }

  function req(path, opts, ms) {
    opts = opts || {};
    var headers = Object.assign({
      'Content-Type': 'application/json',
      'X-User-Id': state.user
    }, opts.headers || {});
    if (state.auth && state.auth.token) headers.Authorization = 'Bearer ' + state.auth.token;
    opts.headers = headers;
    return Promise.race([
      fetch(state.base + path, opts).then(function (r) {
        return r.json().then(function (j) { return { http: r.status, body: j }; })
          .catch(function () { return { http: r.status, body: null }; });
      }),
      timeout(ms || 15000)
    ]).then(function (res) {
      // 登录态失效：清空并通知宿主
      if (res.http === 401 && state.auth) {
        state.auth = null; clearAuth(); state.needLogin = true;
        if (typeof state.onAuthLost === 'function') { try { state.onAuthLost(); } catch (e) {} }
      }
      return res;
    });
  }

  /* ---- 探活：依次尝试候选基址 ---- */
  async function probe(force) {
    if (!force && state.status !== 'unknown' && Date.now() - state.checkedAt < 30000) {
      return state.status === 'online';
    }
    state.checkedAt = Date.now();
    var bases = candidateBases();
    if (state.base && bases.indexOf(state.base) === -1) bases.unshift(state.base);
    for (var i = 0; i < bases.length; i++) {
      var prev = state.base;
      state.base = bases[i];
      try {
        var r = await req('/status', { method: 'GET' }, 2500);
        if (r.body && r.body.ok) {
          state.status = 'online'; state.info = r.body.data;
          state.needLogin = !!(r.body.data.auth && r.body.data.auth.enforced) && !state.auth;
          return true;
        }
      } catch (e) { /* 试下一个 */ }
      if (state.status === 'unknown') state.base = prev;
    }
    state.status = 'offline';
    return false;
  }

  /* ---- 鉴权 ---- */
  async function login(account, password) {
    try {
      var r = await req('/auth/login', {
        method: 'POST', body: JSON.stringify({ account: account, password: password })
      }, 12000);
      if (r.body && r.body.ok) {
        state.auth = {
          token: r.body.data.token, user: r.body.data.user,
          expiresAt: r.body.data.expiresAt
        };
        saveAuth(state.auth);
        state.needLogin = false;
        if (state.auth.user && state.auth.user.id) state.user = state.auth.user.id;
        return { ok: true, user: state.auth.user, expiresAt: state.auth.expiresAt };
      }
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function logout() {
    state.auth = null; clearAuth(); state.needLogin = true;
    return { ok: true };
  }

  async function me() {
    try {
      var r = await req('/auth/me', { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  async function accounts() {
    try {
      var r = await req('/auth/accounts', { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  async function changePassword(oldPassword, newPassword) {
    try {
      var r = await req('/auth/password', {
        method: 'POST', body: JSON.stringify({ oldPassword: oldPassword, newPassword: newPassword })
      }, 12000);
      return { ok: !!(r.body && r.body.ok), error: (r.body && r.body.error) || (r.body && r.body.ok ? null : 'HTTP ' + r.http) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /* ---- 场景库 ---- */
  async function pull() {
    try {
      var r = await req('/scenes', { method: 'GET' }, 9000);
      if (!r.body || !r.body.ok) {
        return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
      }
      var items = r.body.data.items || [];
      var scenes = items.map(function (s) {
        return Object.assign({}, s, {
          /* 后台编辑器用的字段别名 */
          task: s.taskName, scene: s.channel, pass: s.passLine, ava: s.avatarText,
          obj: (s.objectives || []).map(function (o) { return o.text; }),
          objDim: (s.objectives || []).map(function (o) { return dimIndexOf(o.dim); }),
          /* 服务端字段：审批状态与版本 */
          _audit: s.audit, _versions: s.versions || 0
        });
      });
      state.status = 'online';
      return { ok: true, scenes: scenes, seq: scenes.length + 1 };
    } catch (e) {
      state.status = 'offline';
      return { ok: false, error: e.message };
    }
  }

  function dimIndexOf(dimId) {
    var list = (root.TRAIN && root.TRAIN.dims) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === dimId) return i;
    return 0;
  }

  /** 保存场景（新建或更新）。服务端会自动留版本、已发布自动转待审 */
  async function save(scene) {
    try {
      var r = await req('/scenes', {
        method: 'POST', body: JSON.stringify(toServerShape(scene))
      }, 12000);
      if (r.body && r.body.ok) return { ok: true, scene: r.body.data, validate: null };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http, validate: r.body && r.body.validate };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 审批动作：submit / approve / reject / offline / rollback */
  async function act(id, action, extra) {
    var map = { submit: 'submit', approve: 'approve', reject: 'reject', offline: 'offline', rollback: 'rollback' };
    var verb = map[action];
    if (!verb) return { ok: false, error: '未知动作 ' + action };
    try {
      var body = JSON.stringify(extra || {});
      var r = await req('/scenes/' + encodeURIComponent(id) + '/' + verb,
        { method: 'POST', body: body }, 12000);
      if (r.body && r.body.ok) return { ok: true, data: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function remove(id) {
    try {
      var r = await req('/scenes/' + encodeURIComponent(id), { method: 'DELETE' }, 10000);
      return { ok: !!(r.body && r.body.ok), error: r.body && r.body.error, status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function versions(id) {
    try {
      var r = await req('/scenes/' + encodeURIComponent(id) + '/versions', { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  async function auditLog(limit) {
    try {
      var r = await req('/audit?limit=' + (limit || 50), { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---- 数据快照：学员 / 成绩（服务端已按登录身份过滤数据范围） ---- */
  async function learners() {
    try {
      var r = await req('/learners', { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  async function records(query) {
    var qs = [];
    if (query) {
      if (query.learnerId) qs.push('learnerId=' + encodeURIComponent(query.learnerId));
      if (query.taskId) qs.push('taskId=' + encodeURIComponent(query.taskId));
      if (query.sceneId) qs.push('sceneId=' + encodeURIComponent(query.sceneId));
    }
    try {
      var r = await req('/records' + (qs.length ? '?' + qs.join('&') : ''), { method: 'GET' }, 12000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * 逐轮对话（P7）：按需读取某条成绩的逐轮明细。
   *
   * 为什么单独一个接口、而不是塞进 records()：
   * 一次列表 = 全部可见学员的记录，每条 5~6 轮，实测演示库 28 条就近 150 段文本，
   * 而列表页一个字都不渲染。只有真的点开某条记录时才请求这一条。
   *
   * 返回值的三种状态**必须区分开**，调用方据此决定说什么话：
   *   - 数组（含 `[]`）：服务端明确作答。`[]` = 这条成绩确实没有逐轮明细
   *     （P7 之前的练习没留存），页面应说"无逐轮记录"而不是"加载失败"。
   *   - `null`：拿不到（离线 / 未登录 / 越范围 403）。
   *
   * @returns {Array|null}
   */
  async function turns(recordId) {
    var id = String(recordId == null ? '' : recordId);
    if (!id) return null;
    try {
      var r = await req('/records/' + encodeURIComponent(id) + '/turns', { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return (r.body.data && r.body.data.turns) || [];
    } catch (e) { /* 静默降级：调用方按 null 处理，绝不向调用方抛错 */ }
    return null;
  }

  /* ---- 任务（P4）：下发 / 改期 / 结束 / 收回 / 删除 ---- */
  /**
   * 拉任务列表。服务端已按登录身份的数据范围过滤，前端直接展示即可。
   * @returns {Array|null} 失败返回 null（调用方回退本地 T.tasks）
   */
  async function tasks(query) {
    var qs = [];
    if (query) {
      if (query.status) qs.push('status=' + encodeURIComponent(query.status));
      if (query.learnerId) qs.push('learnerId=' + encodeURIComponent(query.learnerId));
    }
    try {
      var r = await req('/tasks' + (qs.length ? '?' + qs.join('&') : ''), { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return r.body.data.items || [];
      if (r.http === 401) return null;
      return null;
    } catch (e) { return null; }
  }

  /** 学员端专用：读某个学员的任务（允许匿名） */
  async function tasksOf(learnerId) {
    try {
      var r = await req('/tasks?learnerId=' + encodeURIComponent(learnerId), { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 下发任务（新建或更新） */
  async function saveTask(t) {
    try {
      var r = await req('/tasks', { method: 'POST', body: JSON.stringify(toTaskShape(t)) }, 15000);
      if (r.body && r.body.ok) return { ok: true, task: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function taskStatus(id, status) {
    try {
      var r = await req('/tasks/' + encodeURIComponent(id) + '/status',
        { method: 'POST', body: JSON.stringify({ status: status }) }, 12000);
      if (r.body && r.body.ok) return { ok: true, task: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function removeTask(id) {
    try {
      var r = await req('/tasks/' + encodeURIComponent(id), { method: 'DELETE' }, 10000);
      return { ok: !!(r.body && r.body.ok), error: r.body && r.body.error, status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** 本地任务 → 服务端入参形状 */
  function toTaskShape(t) {
    return {
      id: t.id, code: t.code, title: t.title, sceneId: t.sceneId,
      passLine: t.passLine, dueAt: t.dueAt, startAt: t.startAt,
      requireAll: t.requireAll, status: t.status, note: t.note,
      assignees: t.assignees || []
    };
  }

  /* ---- 教练动作（P5）：辅导记录 / 对话质检 ----
   * 服务端已按登录身份的数据范围过滤；范围外的读会被裁掉、写会拿到 403。
   * 读接口失败返回 null（调用方回退本地缓存），写接口失败返回 {ok:false,error}。 */
  async function coachNotes(learnerId) {
    try {
      var r = await req('/coach-notes' + (learnerId ? '?learnerId=' + encodeURIComponent(learnerId) : ''),
        { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  async function addCoachNote(note) {
    note = note || {};
    try {
      var r = await req('/coach-notes', {
        method: 'POST',
        body: JSON.stringify({
          id: note.id, learnerId: note.learnerId, recordId: note.recordId || '',
          type: note.type || '一对一辅导', text: note.text || ''
        })
      }, 12000);
      if (r.body && r.body.ok) return { ok: true, note: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function removeCoachNote(id) {
    try {
      var r = await req('/coach-notes/' + encodeURIComponent(id), { method: 'DELETE' }, 10000);
      return { ok: !!(r.body && r.body.ok), error: r.body && r.body.error, status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function qcList() {
    try {
      var r = await req('/qc', { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  async function setQc(recordId, state, note) {
    try {
      var r = await req('/records/' + encodeURIComponent(recordId) + '/qc', {
        method: 'POST', body: JSON.stringify({ state: state, note: note || '' })
      }, 12000);
      if (r.body && r.body.ok) return { ok: true, qc: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http), status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function clearQc(recordId) {
    try {
      var r = await req('/records/' + encodeURIComponent(recordId) + '/qc', { method: 'DELETE' }, 10000);
      return { ok: !!(r.body && r.body.ok), error: r.body && r.body.error, status: r.http };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /* ---- 金标集 ---- */
  async function goldList() {
    try {
      var r = await req('/goldset', { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* ignore */ }
    return null;
  }

  async function goldImport(items) {
    try {
      var r = await req('/goldset/import', {
        method: 'POST', body: JSON.stringify({ items: items })
      }, 20000);
      if (r.body && r.body.ok) return { ok: true, data: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function calibrate(mode) {
    try {
      var r = await req('/goldset/calibrate', { method: 'POST', body: JSON.stringify({ mode: mode || 'auto' }) }, 60000);
      if (r.body && r.body.ok) return r.body.data;
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /* ---- 运维：备份 ---- */
  async function backup() {
    try {
      var r = await req('/admin/backup', { method: 'POST', body: JSON.stringify({}) }, 30000);
      if (r.body && r.body.ok) return { ok: true, data: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http) };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  async function backupList() {
    try {
      var r = await req('/admin/backup', { method: 'GET' }, 9000);
      if (r.body && r.body.ok) return r.body.data;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** 本地场景 → 服务端入参形状 */
  function toServerShape(s) {
    return {
      id: s.id, code: s.code, name: s.name, subtitle: s.subtitle,
      avatarText: s.avatarText || s.ava, color: s.color,
      last: s.last, time: s.time, unread: s.unread,
      taskName: s.taskName || s.task, channel: s.channel || s.scene,
      category: s.category, difficulty: s.difficulty,
      passLine: s.passLine || s.pass, duration: s.duration,
      status: s.status, owner: s.owner, updatedAt: s.updatedAt,
      brief: s.brief, script: s.script,
      tips: s.tips,
      objectives: s.objectives || (s.obj || []).map(function (t, i) {
        return { text: t, dim: (root.TRAIN.dims[i] || {}).id || 'd1' };
      }),
      voicePool: s.voicePool
    };
  }

  root.ADMIN_SYNC = {
    probe: probe, pull: pull, save: save, act: act, remove: remove,
    versions: versions, auditLog: auditLog, calibrate: calibrate,
    tasks: tasks, tasksOf: tasksOf, saveTask: saveTask,
    taskStatus: taskStatus, removeTask: removeTask,
    coachNotes: coachNotes, addCoachNote: addCoachNote, removeCoachNote: removeCoachNote,
    qcList: qcList, setQc: setQc, clearQc: clearQc,
    learners: learners, records: records, turns: turns,
    login: login, logout: logout, me: me, accounts: accounts, changePassword: changePassword,
    goldList: goldList, goldImport: goldImport, backup: backup, backupList: backupList,
    toServerShape: toServerShape, toTaskShape: toTaskShape,
    get status() { return state.status; },
    get info() { return state.info; },
    get base() { return state.base; },
    get user() { return state.user; },
    get authUser() { return state.auth && state.auth.user; },
    get loggedIn() { return !!(state.auth && state.auth.token); },
    get needLogin() { return state.needLogin; },
    get authMode() { return (state.info && state.info.auth && state.info.auth.mode) || 'open'; },
    get authInfo() { return state.info && state.info.auth; },
    get onAuthLost() { return state.onAuthLost; },
    set onAuthLost(fn) { state.onAuthLost = fn; },
    set user(v) { state.user = v; },
    set base(v) { state.base = v; state.status = 'unknown'; }
  };
})(window);
