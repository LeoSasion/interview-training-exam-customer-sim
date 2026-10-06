'use strict';
/**
 * 前端 AI 服务适配层（可选加载）
 *
 * 设计原则：
 *  1. **不侵入**——本文件失败 / 不存在时，学员端仍能用本地 SCORER 引擎离线跑，
 *     所以它是「增强」而不是「依赖」。
 *  2. **接口形状对齐**——judge() 返回 {ok, 点评, 客户回复} 等字段，页面只需
 *     在原有逻辑外多一个 await 分支。
 *  3. **自动降级**——服务未启动 / 请求超时 / 接口报错，一律回落到本地 SCORER，
 *     学员端体验不中断（PRD 要求的"模型故障时练习不中断"）。
 *
 * 用法：
 *   AIBOOT.probe()            -> Promise<bool>  探测服务是否可用
 *   AIBOOT.turn(payload)      -> Promise<{ok,data}|{ok:false}>
 *   AIBOOT.finish(payload)    -> Promise<{ok,data}|{ok:false}>
 *   AIBOOT.status             -> 'unknown' | 'offline' | 'live'
 */
(function (root) {
  /* 候选基址（按优先级）：
   *  1) ?api=xxx 显式指定（局域网部署时用）
   *  2) 同源 /api/v1 —— 页面直接用后端服务打开时天然同源，最省事
   *  3) http://127.0.0.1:8848/api/v1 —— 页面由 file:// 或别的静态服务打开时的兜底
   * probe() 会依次探活，用第一个可用的，避免"硬编码 + 手带参数"的麻烦。 */
  function candidateBases() {
    var list = [];
    try {
      var qs = new URLSearchParams(location.search);
      var q = qs.get('api');
      if (q) return [q];
    } catch (e) { /* 老浏览器忽略 */ }
    try {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        list.push(location.origin + '/api/v1');
      }
    } catch (e) { /* ignore */ }
    list.push('http://127.0.0.1:8848/api/v1');
    return list.filter(function (x, i) { return list.indexOf(x) === i; });
  }

  var state = { status: 'unknown', base: candidateBases()[0], info: null, checkedAt: 0 };

  function timeout(ms) {
    return new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('请求超时')); }, ms);
    });
  }

  function req(path, opts, ms) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return Promise.race([
      fetch(state.base + path, opts).then(function (r) {
        return r.json().then(function (j) { return { http: r.status, body: j }; });
      }),
      timeout(ms || 45000)
    ]);
  }

  /** 探测服务可用性（页面加载时调一次，结果缓存）；会依次尝试候选基址 */
  async function probe(force) {
    if (!force && state.status !== 'unknown' && Date.now() - state.checkedAt < 30000) {
      return state.status === 'live';
    }
    state.checkedAt = Date.now();
    var bases = candidateBases();
    // 已确定可用基址时优先复用它
    if (state.base && bases.indexOf(state.base) === -1) bases.unshift(state.base);
    for (var i = 0; i < bases.length; i++) {
      var prev = state.base;
      state.base = bases[i];
      try {
        var r = await req('/status', { method: 'GET' }, 2500);
        if (r.body && r.body.ok) {
          state.status = 'live';
          state.info = r.body.data;
          return true;
        }
      } catch (e) { /* 试下一个 */ }
      if (state.status === 'unknown') state.base = prev;
    }
    state.status = 'offline';
    return false;
  }

  /** 一轮对话 */
  async function turn(p) {
    try {
      var r = await req('/session/' + encodeURIComponent(p.sessionId) + '/turn', {
        method: 'POST',
        body: JSON.stringify({
          taskId: p.taskId || '', sceneId: p.sceneId, learnerId: p.learnerId || '',
          channel: p.channel || 'text', learnerText: p.learnerText,
          customerText: p.customerText || ''
        })
      }, 45000);
      if (r.body && r.body.ok) return { ok: true, data: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 结束会话并落库 */
  async function finish(p) {
    try {
      var r = await req('/session/' + encodeURIComponent(p.sessionId) + '/finish', {
        method: 'POST', body: JSON.stringify({})
      }, 20000);
      if (r.body && r.body.ok) return { ok: true, data: r.body.data };
      return { ok: false, error: (r.body && r.body.error) || ('HTTP ' + r.http) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 场景库（管理端用） */
  async function api(path, opts) {
    return req(path, opts, 20000);
  }

  /**
   * 学员端：读「我的任务」清单（服务端此接口允许匿名，学员不必登录）
   * @returns {Array|null} 服务端不可用 / 未就绪时返回 null，调用方回退本地数据
   */
  async function tasks(learnerId) {
    if (!learnerId) return null;
    try {
      if (state.status === 'unknown') await probe();
      if (state.status !== 'live') return null;
      var r = await req('/tasks?learnerId=' + encodeURIComponent(learnerId), { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* 静默降级到本地 */ }
    return null;
  }

  /**
   * 学员端：读「已发布场景池」（此接口同样允许匿名）
   * 只回学员端渲染与判分需要的字段（服务端已剥离 audit/versions/owner/publish）。
   * @returns {Array|null} 服务端不可用 / 未就绪时返回 null，调用方保留本地种子场景
   */
  async function scenes() {
    try {
      if (state.status === 'unknown') await probe();
      if (state.status !== 'live') return null;
      var r = await req('/scenes/published', { method: 'GET' }, 8000);
      if (r.body && r.body.ok) return r.body.data.items || [];
    } catch (e) { /* 静默降级到本地 */ }
    return null;
  }

  function newSessionId() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return 'S-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  root.AIBOOT = {
    probe: probe, turn: turn, finish: finish, api: api, tasks: tasks, scenes: scenes,
    newSessionId: newSessionId,
    get status() { return state.status; },
    get info() { return state.info; },
    get base() { return state.base; },
    set base(v) { state.base = v; state.status = 'unknown'; }
  };
})(window);

/* ------------------------------------------------------------------ *
 * 在页面上挂一个「AI 服务」状态角标，让使用者一眼看到当前通道
 * ------------------------------------------------------------------ */
(function () {
  function mountBadge() {
    if (!window.AIBOOT || document.getElementById('aiBadge')) return;
    var el = document.createElement('div');
    el.id = 'aiBadge';
    el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:9999;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;' +
      'padding:6px 12px;border-radius:20px;background:rgba(0,0,0,.62);color:#fff;cursor:pointer;backdrop-filter:blur(6px);' +
      'box-shadow:0 2px 12px rgba(0,0,0,.25);user-select:none;transition:.2s';
    el.textContent = 'AI 通道检测中…';
    el.title = '点击查看 AI 服务状态';
    el.onclick = function () {
      var i = window.AIBOOT.info;
      var msg = window.AIBOOT.status === 'live'
        ? '已连接 AI 服务\n\n模型：' + i.llm.model + '\n地址：' + i.llm.baseUrl +
          '\nRubric：' + i.rubricVersion + '\n模式：' + (i.llm.configured ? '真实模型评分' : '关键词引擎降级（未配置 Key）')
        : '未连接 AI 服务（' + window.AIBOOT.base + '）\n\n当前使用本地关键词引擎评分，可离线练习。\n启动后端后刷新即可启用 AI 评分。';
      alert(msg);
    };
    document.body.appendChild(el);

    window.AIBOOT.probe().then(function (ok) {
      var i = window.AIBOOT.info;
      if (ok) {
        el.textContent = i.llm.configured ? '● AI 评分已启用' : '● 服务已连接（降级模式）';
        el.style.background = i.llm.configured ? 'rgba(7,193,96,.88)' : 'rgba(242,169,59,.9)';
      } else {
        el.textContent = '● 离线模式（本地评分）';
        el.style.background = 'rgba(0,0,0,.62)';
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBadge);
  } else {
    setTimeout(mountBadge, 0);
  }
})();
