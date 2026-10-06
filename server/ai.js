'use strict';
/**
 * AI 适配层：LLM 双角色（客户 NPC + Rubric 评分官）+ 关键词引擎降级
 *
 * 关键设计：
 *  - **对外契约与 prototype 一致**：返回形状对齐 PRD 的 `POST /turn` 响应，
 *    并且 dimScores / score / objectives 的形状与 SCORER.scoreTurn 完全一致，
 *    前端不需要区分「模型评的」还是「关键词评的」。
 *  - **降级不中断**：LLM 未配置 / 超时 / 返回坏 JSON → 自动落到关键词引擎
 *    （复用 data/scoring-engine.js，同一份真相），响应里 `source` 标注来源。
 *  - **评分合法性校验**：模型可能漏维度、给越界分、给非数字，一律钳制回
 *    合法范围，缺维度用关键词结果补齐，绝不让脏数据进库。
 */

const config = require('./config');
const llm = require('./llm-client');
const rubric = require('./rubric');
const { loadAppData } = require('./db');

/* ------------------------------------------------------------------ *
 * 复用原型的关键词评分引擎（同一份真相，不重写第二套算法）
 * ------------------------------------------------------------------ */
function loadScorer() {
  // scoring-engine.js 是 UMD：node 下走 module.exports
  delete require.cache[require.resolve('../data/scoring-engine.js')];
  return require('../data/scoring-engine.js');
}

const DIM_FALLBACK = ['d1', 'd2', 'd3', 'd4', 'd5'];

/** 把任意输入钳制成 0–100 整数 */
function clampScore(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/**
 * 关键词引擎评分（降级路径 / 补齐路径）
 * 返回与 LLM 路径同形状的结果
 */
function scoreByKeyword(ctx) {
  const S = loadScorer();
  const T = loadAppData();
  const dims = T.dims || [];
  const state = ctx.state || {};
  const r = S.scoreTurn(ctx.learnerText, {
    dims,
    kw: ctx.kw || T.kw,
    state,
    objectiveDim: ctx.objectiveDim || null,
    inCall: !!ctx.isCall,
    noObjectiveBonus: !!ctx.isCall
  });
  const dimIds = dims.map((d) => d.id);
  const dimScores = {};
  dimIds.forEach((id) => { dimScores[id] = r.state[id]; });

  const objectives = (ctx.objectives || []).map((o) => {
    const hit = (r.hits || []).indexOf(o.dim) !== -1;
    return { dim: o.dim, text: o.text, achieved: hit, evidence: hit ? ctx.learnerText.slice(0, 40) : null };
  });

  return {
    dimScores,
    score: r.total,
    objectives,
    feedback: buildKeywordFeedback(r),
    confidence: 0.5,
    emotion: null,
    source: 'keyword-fallback',
    state: r.state,
    hits: r.hits || [],
    detail: r.detail || []
  };
}

function buildKeywordFeedback(r) {
  const hits = r.hits || [];
  if (!hits.length) return '这一轮没有命中任何能力维度的要点，建议先回应客户的诉求本身，而不是直接给结论。';
  const T = loadAppData();
  const names = hits.map((id) => {
    const d = (T.dims || []).filter((x) => x.id === id)[0];
    return d ? d.name : id;
  });
  const all = (T.dims || []).map((d) => d.id);
  const miss = all.filter((id) => hits.indexOf(id) === -1).map((id) => {
    const d = (T.dims || []).filter((x) => x.id === id)[0];
    return d ? d.name : id;
  });
  return `命中了「${names.join('、')}」；本轮未涉及「${miss.join('、')}」。` +
    '（当前由关键词引擎代评，接入大模型后评分会基于语义而非词面。）';
}

/* ------------------------------------------------------------------ *
 * LLM 评分
 * ------------------------------------------------------------------ */
async function scoreByLLM(ctx) {
  const rb = rubric.currentRubric();
  const messages = [
    { role: 'system', content: rubric.buildScorerSystemPrompt(rb) },
    { role: 'user', content: rubric.buildScorerUserPrompt(ctx) }
  ];
  const out = await llm.chatJSON(messages, { temperature: config.llm.tempScore });

  const dimIds = rb.dims.map((d) => d.id);
  const weightOf = {};
  rb.dims.forEach((d) => { weightOf[d.id] = d.weight; });

  // 1) 维度分：钳制 + 缺维度用关键词结果补
  const kwRes = scoreByKeyword(ctx);
  const dimScores = {};
  const raw = out.dimScores || out.dim_scores || {};
  dimIds.forEach((id) => {
    const v = clampScore(raw[id]);
    dimScores[id] = v !== null ? v : kwRes.dimScores[id];
  });

  // 2) 总分：优先用模型给的（若合法），否则按权重自算
  const wsum = dimIds.reduce((s, id) => s + (weightOf[id] || 0), 0) || 100;
  const computed = Math.round(dimIds.reduce((s, id) => s + dimScores[id] * (weightOf[id] || 0), 0) / wsum);
  let score = clampScore(out.score);
  if (score === null || Math.abs(score - computed) > 15) score = computed; // 模型算错就自算

  // 3) 目标达成：以模型判定为准，缺失则退关键词判定
  const outObj = Array.isArray(out.objectives) ? out.objectives : [];
  const objectives = (ctx.objectives || []).map((o, i) => {
    const hit = outObj.filter((x) => x && (x.dim === o.dim || x.index === i))[0];
    const kw = kwRes.objectives[i] || {};
    return {
      dim: o.dim,
      text: o.text,
      achieved: hit ? !!hit.achieved : !!kw.achieved,
      evidence: hit && hit.evidence ? String(hit.evidence).slice(0, 80) : (kw.evidence || null)
    };
  });

  // 4) 置信度
  let conf = Number(out.confidence);
  if (!isFinite(conf)) conf = 0.7;
  conf = Math.max(0, Math.min(1, conf));

  return {
    dimScores,
    score,
    objectives,
    feedback: String(out.feedback || '').trim() || kwRes.feedback,
    confidence: conf,
    source: 'llm',
    state: null,        // 由调用方按 dimScores 重建，保证状态与评分一致
    hits: [],
    detail: []
  };
}

/* ------------------------------------------------------------------ *
 * 客户 NPC 回复
 * ------------------------------------------------------------------ */
/** 本地兜底台词：LLM 不可用时按剧本走，保证练习不中断 */
function npcFallback(ctx) {
  const sc = ctx.scene || {};
  const script = sc.script || [];
  const idx = Math.min((ctx.turn || 1) - 1, script.length - 1);
  const line = script[Math.max(0, idx)] || { t: '（客户沉默了一会儿）', v: 4 };
  const EMOTIONS = ['impatient', 'skeptical', 'pressured', 'calm', 'warm'];
  return {
    text: line.t,
    emotion: EMOTIONS[Math.min((ctx.turn || 1) - 1, EMOTIONS.length - 1)],
    voiceSec: line.v || 5,
    source: 'script-fallback'
  };
}

async function npcReply(ctx) {
  const messages = [
    { role: 'system', content: rubric.buildNpcSystemPrompt(ctx.scene || {}, ctx) },
    { role: 'user', content: rubric.buildNpcUserPrompt(ctx) }
  ];
  const out = await llm.chatJSON(messages, { temperature: config.llm.tempNpc });
  let text = String(out.text || out.reply || '').trim();
  if (!text) throw new Error('NPC 返回为空');
  // 清掉模型偶尔会带的角色前缀
  text = text.replace(/^(客户|Customer|NPC)\s*[:：]\s*/i, '').trim();
  const okEmo = ['calm', 'impatient', 'skeptical', 'pressured', 'warm'];
  const emo = okEmo.indexOf(String(out.emotion)) !== -1 ? out.emotion : 'calm';
  let sec = parseInt(out.voiceSec, 10);
  if (!isFinite(sec) || sec < 2) sec = Math.max(3, Math.min(12, Math.round(text.length / 4)));
  return { text, emotion: emo, voiceSec: Math.max(3, Math.min(12, sec)), source: 'llm' };
}

/* ------------------------------------------------------------------ *
 * 对外主入口：一轮对话
 * ------------------------------------------------------------------ */
/**
 * @param {object} ctx {scene, objectives, objectiveDim, learnerText, customerText,
 *                      history, turn, isCall, state, kw}
 * @returns 对齐 PRD 契约的结果对象
 */
async function runTurn(ctx) {
  const notes = [];
  let scored = null;
  let npc = null;

  // 评分（并行发起，失败各自降级）
  const scoreTask = (async () => {
    if (!config.llm.enabled) { notes.push('未配置 LLM_API_KEY，评分走关键词引擎'); return scoreByKeyword(ctx); }
    try {
      return await scoreByLLM(ctx);
    } catch (e) {
      notes.push('模型评分失败已降级：' + e.message);
      if (!config.allowFallback) throw e;
      return scoreByKeyword(ctx);
    }
  })();

  // NPC 回复
  const npcTask = (async () => {
    if (!config.llm.enabled) { notes.push('未配置 LLM_API_KEY，客户回复走剧本'); return npcFallback(ctx); }
    try {
      return await npcReply(ctx);
    } catch (e) {
      notes.push('模型生成回复失败已降级：' + e.message);
      if (!config.allowFallback) throw e;
      return npcFallback(ctx);
    }
  })();

  const [s, n] = await Promise.all([scoreTask, npcTask]);
  scored = s; npc = n;

  return {
    dimScores: scored.dimScores,
    score: scored.score,
    objectives: scored.objectives,
    feedback: scored.feedback,
    confidence: scored.confidence,
    customerReply: { text: npc.text, emotion: npc.emotion, voiceSec: npc.voiceSec, source: npc.source },
    source: scored.source,
    fallback: scored.source !== 'llm',
    notes,
    // 供调用方更新会话状态（与 SCORER 快照同形状）
    nextState: scored.state || (() => {
      const st = Object.assign({}, ctx.state || {});
      Object.keys(scored.dimScores).forEach((k) => { st[k] = scored.dimScores[k]; });
      return st;
    })()
  };
}

async function aiStatus() {
  const h = await llm.health();
  return {
    configured: config.llm.enabled,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    rubricVersion: config.rubricVersion,
    timeoutMs: config.llm.timeoutMs,
    lowConfidenceThreshold: config.llm.lowConfidence,
    live: h
  };
}

module.exports = { runTurn, scoreByKeyword, scoreByLLM, npcReply, npcFallback, aiStatus, DIM_FALLBACK };
