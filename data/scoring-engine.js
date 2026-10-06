/* ============================================================================
 * 新员工培训系统 · 评分引擎（纯函数，零依赖）
 * ----------------------------------------------------------------------------
 * 为什么单独抽一个文件？
 *   学员端已经在用"关键词命中"算分了，但那是内联在页面里的。一旦教练端
 *   （带教主管看板）也想用同一套评分，就会出现"两端各写一套算法、分数打架"
 *   的老问题。所以把评分抽成纯函数：输入是「学员说的话 + 场景」，输出是
 *   「五维得分 + 目标达成情况 + 命中明细」，谁都能调，口径唯一。
 *
 * 设计约束：
 *   1. 纯函数、无副作用、不依赖 DOM、不读全局 TRAIN（KW/DIMS 由调用方传入
 *      或从 window 取，取不到时用内置兜底表）。
 *   2. 同时兼容 node（module.exports）与浏览器（window.SCORER），
 *      便于用 node 直接写单元测试。
 *   3. **不改变学员端现有行为**：本引擎的默认参数严格复刻学员端已验收的
 *      评分逻辑（初始 42 / 命中 +13 上限 97 / 本轮目标达成且命中 +6 /
 *      语音通话发言 +9），学员端可以按需切换到它，也可以先不切。
 * ==========================================================================*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SCORER = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* 与 app-data.js 的 dims 顺序严格一致 */
  var DIM_ORDER = ['d1', 'd2', 'd3', 'd4', 'd5'];

  /* 兜底关键词表：app-data.js 不可用时也能算分（内容与 TRAIN.kw 一致） */
  var FALLBACK_KW = {
    d1: ['你好', '您好', '早上好', '下午好', '感谢', '谢谢', '张经理', '王姐', '李总', '打扰', '方便', '抱歉', '不好意思', '我是'],
    d2: ['请问', '想了解', '您目前', '您现在', '具体', '预算', '用量', '多少', '什么顾虑', '哪方面', '主要是', '为什么', '怎么回事', '什么情况', '多久', '几次'],
    d3: ['理解', '我明白', '确实', '您说得对', '不好意思', '我们的问题', '给您添麻烦', '不过', '可以这样', '算下来', '长期', '性价比', '成本', '对比一下', '我帮您', '马上', '立刻', '先', '售后', '承诺', '补货', '退', '换货', '处理'],
    d4: ['案例', '数据', '门店', '实际', '质检', '标准', '认证', '批次', '参数', '规格', '保质期', '配方', '我们做过', '同类型', '客户反馈', '第三方', '报告', '专人'],
    d5: ['方案', '报价', '发您', '寄', '样品', '安排', '下一步', '什么时候', '约个', '明天', '今天下午', '您看', '确认', '试试', '先发', '留一批', '资料']
  };

  /* 默认参数：与学员端已验收的行为逐项对齐 */
  var DEFAULTS = {
    base: 42,        // 起始分
    hitBonus: 13,    // 每命中一个维度 +13
    maxPerDim: 97,   // 单维度上限
    objectiveBonus: 6, // 本轮目标达成且命中对应维度 +6
    callBonus: 9,    // 在语音通话里发言：命中维度按此值结算（替代 hitBonus）
    callBonusScope: 'hits', // 'hits' = 只给命中维度；'all' = 全维度加成
    multiHitThreshold: 2 // 命中 >= 2 个维度即视为本轮目标达成
  };

  /* ---------------------------------------------------------------- *
   * 命中检测：返回命中的维度集合
   * ---------------------------------------------------------------- */
  function detectHits(text, kwTable, dimIds) {
    var hits = [];
    if (!text) return hits;
    for (var i = 0; i < dimIds.length; i++) {
      var id = dimIds[i];
      var words = (kwTable && kwTable[id]) || [];
      for (var j = 0; j < words.length; j++) {
        if (words[j] && text.indexOf(words[j]) !== -1) { hits.push(id); break; }
      }
    }
    return hits;
  }

  /* ---------------------------------------------------------------- *
   * 一维打分
   * ---------------------------------------------------------------- */
  function scoreDim(dimId, state, opts) {
    var s = state[dimId] || 0;
    s = Math.min(opts.maxPerDim, s);
    return s;
  }

  /* ---------------------------------------------------------------- *
   * 逐句评分（核心）
   * ---------------------------------------------------------------- *
   * @param {string} text        学员说的这一句
   * @param {object} ctx
   *   ctx.state    {d1..d5} 当前五维累计分（会被原地更新）
   *   ctx.kw       关键词表（TRAIN.kw 形状：{d1:[...]}）
   *   ctx.dims     维度数组（TRAIN.dims，用于返回名称）
   *   ctx.objectiveDim  本轮目标对应的 dimId（可为 null，表示"本轮无目标"）
   *   ctx.inCall   是否处于语音通话
   *   ctx.options  覆盖默认参数
   * @returns {object} {
   *   hits:      命中的维度 id 数组
   *   gained:    各维度本次增量 {d1:13,...}
   *   objectiveMet: 本轮训练目标是否达成
   *   state:     更新后的五维分快照
   *   total:     综合分（五维算术平均）
   *   detail:    人类可读的命中明细，供报告/教练端展示
   * }
   * ---------------------------------------------------------------- */
  function scoreTurn(text, ctx) {
    ctx = ctx || {};
    var opts = merge(DEFAULTS, ctx.options || {});
    var dims = ctx.dims && ctx.dims.length ? ctx.dims : DIM_ORDER.map(function (id) {
      return { id: id, name: id };
    });
    var dimIds = dims.map(function (d) { return d.id; });
    var kw = ctx.kw || FALLBACK_KW;
    var state = ctx.state || {};
    dimIds.forEach(function (id) { if (typeof state[id] !== 'number') state[id] = opts.base; });

    var hits = detectHits(text, kw, dimIds);
    var gained = {};
    var before = {};

    // 1) 每个命中维度 +hitBonus，并封顶
    hits.forEach(function (id) {
      before[id] = state[id];
      var next = Math.min(opts.maxPerDim, state[id] + opts.hitBonus);
      gained[id] = next - state[id];
      state[id] = next;
    });

    // 2) 本轮目标达成判定：命中了目标对应维度，或同时命中 >= 2 个维度
    var objDim = ctx.objectiveDim || null;
    var objectiveMet = false;
    if (objDim) {
      objectiveMet = hits.indexOf(objDim) !== -1 || hits.length >= opts.multiHitThreshold;
    } else {
      objectiveMet = hits.length >= opts.multiHitThreshold;
    }

    // 3) 目标达成且命中了对应维度 -> 额外 +objectiveBonus
    //    ctx.noObjectiveBonus：语音通话路径调用时置 true——通话路径的目标达成情况
    //    由调用方（judge）统一结算，避免同一次练习被重复计分。
    if (!ctx.noObjectiveBonus && objectiveMet && objDim && hits.indexOf(objDim) !== -1) {
      var nxt = Math.min(opts.maxPerDim, state[objDim] + opts.objectiveBonus);
      gained[objDim] = (gained[objDim] || 0) + (nxt - state[objDim]);
      state[objDim] = nxt;
    }

    // 4) 语音通话加成（callBonus，默认 9）
    //    语义与文字路径不同：通话里**命中维度按 callBonus 结算（而非 hitBonus）**，
    //    未命中的维度不加分。callBonusScope='hits' 即此语义。
    //    callBonusScope='all' 时改为全维度加成，供未来的"勇气分"之类玩法扩展。
    if (ctx.inCall && text) {
      var extra = opts.callBonus - opts.hitBonus; // 相对已加过的 hitBonus 的补差
      if (opts.callBonusScope === 'all') {
        dimIds.forEach(function (id) {
          var n2 = Math.min(opts.maxPerDim, state[id] + opts.callBonus);
          gained[id] = (gained[id] || 0) + (n2 - state[id]);
          state[id] = n2;
        });
      } else {
        hits.forEach(function (id) {
          // 已按 hitBonus 加过，这里补到 callBonus 的差额（负值即回调）
          var n3 = Math.max(opts.base, Math.min(opts.maxPerDim, state[id] + extra));
          gained[id] = (gained[id] || 0) + (n3 - state[id]);
          state[id] = n3;
        });
      }
    }

    var total = average(dimIds.map(function (id) { return state[id]; }));

    return {
      hits: hits,
      gained: gained,
      objectiveMet: objectiveMet,
      objectiveDim: objDim,
      state: snapshot(state, dimIds),
      total: total,
      detail: buildDetail(hits, dims, gained, objectiveMet)
    };
  }

  /* ---------------------------------------------------------------- *
   * 整场评分：直接吐出一份"成绩单"，供教练端 / 报告页使用
   * ---------------------------------------------------------------- *
   * @param {object} session {
   *   turns: [{ text, objectiveDim, inCall }],   // 学员每一句
   *   kw, dims, options
   * }
   * @returns {object} {
   *   dimScores: {d1..d5},
   *   score: 综合分,
   *   objectives: [{ index, met }],  // 按顺序的目标达成情况
   *   hitsByTurn: 每一句的命中维度,
   *   weakDims: 最低的 2 个维度（带名称与分数）,
   *   highlights: 值得表扬的点（命中最多的维度）,
   *   suggestions: 针对弱项的改进话术（规则生成）,
   *   durationTurns
   * }
   * ---------------------------------------------------------------- */
  function scoreSession(session) {
    session = session || {};
    var dims = session.dims && session.dims.length ? session.dims : DIM_ORDER.map(function (id) {
      return { id: id, name: id };
    });
    var dimIds = dims.map(function (d) { return d.id; });
    var state = {};
    dimIds.forEach(function (id) { state[id] = (session.options && session.options.base) || DEFAULTS.base; });

    var turns = session.turns || [];
    var hitsByTurn = [];
    var objectives = [];

    for (var i = 0; i < turns.length; i++) {
      var r = scoreTurn(turns[i].text, {
        state: state,
        kw: session.kw,
        dims: dims,
        objectiveDim: turns[i].objectiveDim || null,
        inCall: !!turns[i].inCall,
        options: session.options
      });
      hitsByTurn.push(r.hits);
      objectives.push({ index: i, dim: turns[i].objectiveDim || null, met: r.objectiveMet });
    }

    var dimScores = snapshot(state, dimIds);
    var ranked = dimIds.map(function (id) {
      var d = dims.filter(function (x) { return x.id === id; })[0] || {};
      return { id: id, name: d.name || id, score: dimScores[id] };
    }).sort(function (a, b) { return a.score - b.score; });

    var weakDims = withTips(ranked.slice(0, 2));
    var strongDims = withTips(ranked.slice().reverse().slice(0, 2));

    return {
      dimScores: dimScores,
      score: average(dimIds.map(function (id) { return dimScores[id]; })),
      objectives: objectives,
      metCount: objectives.filter(function (o) { return o.met; }).length,
      hitsByTurn: hitsByTurn,
      hitCount: hitsByTurn.reduce(function (a, h) { return a + h.length; }, 0),
      weakDims: weakDims,
      strongDims: strongDims,
      highlights: strongDims.slice(0, 1),
      suggestions: weakDims,      turns: turns.length
    };
  }

  /* ---------------------------------------------------------------- *
   * 弱项 -> 改进话术（规则生成，接入大模型后可替换为模型输出）
   *
   * 形状契约：入参放宽，出参恒定。
   *   入参：任一形状的"维度项"数组，只要能取出 id 即可，
   *         支持 {id} / {dimId} / {dim}（=维度名，回查 dims 得到 id）。
   *   出参：{ dim, dimId, name, score, tip }，与 withTips() 完全一致，
   *         保证「scoreSession().weakDims 可直接喂进来」且下游字段名统一。
   * ---------------------------------------------------------------- */
  var SUGGESTIONS = {
    d1: '开场先自报家门：我是谁、来自哪家公司、为什么找您。控制在 15 秒内，别铺垫太久。',
    d2: '多用开放式提问把顾虑问出来，比如「您现在主要担心的是价格还是品质？」。先问清楚，再回答。',
    d3: '面对压价或投诉，第一句先接情绪再给方案。可以用「理解」「确实是我们没做到」开场，不要辩解。',
    d4: '讲方案时把形容词换成证据：具体案例、批次数据、第三方报告。说「我们上个月给同城某连锁供过」比说「我们质量好」有效。',
    d5: '每轮对话都要收一个明确动作：发什么、什么时候、谁跟进。把「我发您」升级成「我今天 5 点前发您，明天上午跟您确认」。'
  };

  /* 从任一形状的维度项里解出维度 id */
  function resolveDimId(w, dims) {
    if (!w) { return null; }
    if (w.dimId) { return w.dimId; }
    if (w.id) { return w.id; }
    // {dim: '需求挖掘'} 这种只给了名称的，回查 dims
    var name = w.dim || w.name;
    if (name && dims) {
      var hit = dims.filter(function (d) { return d.name === name || d.id === name; })[0];
      if (hit) { return hit.id; }
    }
    return null;
  }

  function suggestionsFor(weakDims, dims) {
    if (!weakDims || !weakDims.length) { return []; }
    return weakDims.map(function (w) {
      var id = resolveDimId(w, dims);
      var d = (dims || []).filter(function (x) { return x.id === id; })[0] || {};
      var name = w.name || w.dim || d.name || id || '';
      return {
        dim: name,
        dimId: id,
        name: name,
        score: (typeof w.score === 'number' ? w.score : null),
        tip: SUGGESTIONS[id] || ''
      };
    });
  }

  /* 把 ranked 项补上 tip（供教练端直接渲染） */
  function withTips(rankedItems) {
    return rankedItems.map(function (w) {
      return { dim: w.name, dimId: w.id, name: w.name, score: w.score, tip: SUGGESTIONS[w.id] || '' };
    });
  }

  /* ---------------------------------------------------------------- *
   * 与"历史成绩"对比：给教练端用的进步/退步判定
   * ---------------------------------------------------------------- */
  function compareWithHistory(result, historyScores) {
    historyScores = historyScores || [];
    if (!historyScores.length) {
      return { trend: 'first', delta: 0, avg: 0, vsAvg: 0, note: '首次练习，暂无对比基准' };
    }
    var avg = Math.round(historyScores.reduce(function (a, b) { return a + b; }, 0) / historyScores.length);
    var delta = result.score - historyScores[historyScores.length - 1];
    var vsAvg = result.score - avg;
    var trend = delta > 2 ? 'up' : (delta < -2 ? 'down' : 'flat');
    var note = trend === 'up' ? ('较上次进步 ' + delta + ' 分')
      : (trend === 'down' ? ('较上次退步 ' + Math.abs(delta) + ' 分') : '与上次基本持平');
    return { trend: trend, delta: delta, avg: avg, vsAvg: vsAvg, note: note };
  }

  /* ---------------------------------------------------------------- *
   * 内部工具
   * ---------------------------------------------------------------- */
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (a.hasOwnProperty(k)) o[k] = a[k];
    for (k in b) if (b.hasOwnProperty(k)) o[k] = b[k];
    return o;
  }
  function average(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return Math.round(s / arr.length);
  }
  function snapshot(state, dimIds) {
    var o = {};
    dimIds.forEach(function (id) { o[id] = state[id]; });
    return o;
  }
  function buildDetail(hits, dims, gained, objectiveMet) {
    return hits.map(function (id) {
      var d = dims.filter(function (x) { return x.id === id; })[0] || {};
      return { dimId: id, dimName: d.name || id, delta: gained[id] || 0 };
    }).concat(objectiveMet ? [{ dimId: '_obj', dimName: '本轮训练目标', delta: '已达成' }] : []);
  }

  return {
    DIM_ORDER: DIM_ORDER,
    FALLBACK_KW: FALLBACK_KW,
    DEFAULTS: DEFAULTS,
    detectHits: detectHits,
    scoreTurn: scoreTurn,
    scoreSession: scoreSession,
    compareWithHistory: compareWithHistory,
    suggestionsFor: suggestionsFor,
    SUGGESTIONS: SUGGESTIONS
  };
});
