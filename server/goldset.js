'use strict';
/**
 * 金标集校准链路（P2 的第一交付物）
 *
 * 为什么它是第一交付物：模型能不能打分不是问题，**打的分和主管心里的分
 * 是不是一回事**才是。所以先建一条「人工标注 → 模型评分 → 一致性报告」
 * 的闭环，让 Rubric 的每次改动都有客观回归依据。
 *
 * 一致性指标：
 *   - Pearson 相关系数（目标 ≥ 0.8）
 *   - MAE 平均绝对误差（目标 ≤ 8 分）
 *   - 逐条明细，供人工复核分歧样本
 */

const { db, log, nowStamp, J, P } = require('./db');
const ai = require('./ai');
const config = require('./config');

/** Pearson 相关系数。零方差（所有值相同）时返回 null——数学上无定义 */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : Math.round((num / den) * 1000) / 1000;
}

/** 判断某序列是否有方差（全同则 Pearson 无定义） */
function hasVariance(arr) {
  if (!arr.length) return false;
  const first = arr[0];
  return arr.some((v) => v !== first);
}

function mae(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (!n) return null;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(xs[i] - ys[i]);
  return Math.round((s / n) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * 金标集：导入 / 列出
 * ------------------------------------------------------------------ */
const GOLD_FIELDS = ['id', 'sceneId', 'turnIndex', 'customerText', 'learnerText', 'humanScores', 'annotator', 'note'];

function weightTotal() {
  const T = require('./db').loadAppData();
  return (T.dims || []).reduce((s, d) => s + (d.weight || 0), 0) || 100;
}

/** 由 5 维分算加权总分 */
function totalOf(dimScores) {
  const T = require('./db').loadAppData();
  const dims = T.dims || [];
  const wsum = dims.reduce((s, d) => s + (d.weight || 0), 0) || 100;
  return Math.round(dims.reduce((s, d) => s + (Number(dimScores[d.id]) || 0) * (d.weight || 0), 0) / wsum);
}

function upsertGold(item, idx) {
  if (!item || item.id == null || item.id === '') {
    throw Object.assign(new Error(`第 ${(Number(idx) || 0) + 1} 条缺少 id`), { status: 400 });
  }
  const human = item.humanScores || {};
  const total = item.humanTotal != null ? Number(item.humanTotal) : totalOf(human);
  db.prepare(`INSERT INTO gold_set
    (id,scene_id,turn_index,customer_text,learner_text,human_scores,human_total,annotator,note)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET scene_id=excluded.scene_id, turn_index=excluded.turn_index,
      customer_text=excluded.customer_text, learner_text=excluded.learner_text,
      human_scores=excluded.human_scores, human_total=excluded.human_total,
      annotator=excluded.annotator, note=excluded.note`)
    .run(String(item.id), item.sceneId || '', Number(item.turnIndex) || 1, item.customerText || '',
      item.learnerText || '', J(human), total, item.annotator || '人工', item.note || '');
  return { id: item.id, humanTotal: total };
}

function goldCount() {
  const r = db.prepare('SELECT COUNT(*) AS n FROM gold_set').get();
  return r ? r.n : 0;
}

function importGold(items, userId) {
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('items 必须是非空数组'), { status: 400 });
  }
  const before = {};
  db.prepare('SELECT id FROM gold_set').all().forEach((r) => { before[r.id] = 1; });
  let inserted = 0, updated = 0;
  const out = items.map((it, i) => {
    const r = upsertGold(it, i);
    if (before[it.id]) updated++; else inserted++;
    return r;
  });
  const total = goldCount();
  log(userId || 'system', 'gold.import', '', `导入 ${out.length} 条金标样本（新增 ${inserted} / 更新 ${updated}）`);
  return { imported: out.length, inserted, updated, total, items: out };
}

function listGold() {
  return db.prepare('SELECT * FROM gold_set ORDER BY id').all().map((r) => ({
    id: r.id, sceneId: r.scene_id, turnIndex: r.turn_index,
    customerText: r.customer_text, learnerText: r.learner_text,
    humanScores: P(r.human_scores, {}), humanTotal: r.human_total,
    annotator: r.annotator, note: r.note
  }));
}

/* ------------------------------------------------------------------ *
 * 校准跑批：对金标集逐条跑模型评分，算一致性
 * ------------------------------------------------------------------ */
/**
 * 校准跑批：对金标集逐条跑评分，算一致性
 *
 * mode:
 *   'auto'（默认）—— 有 Key 用 LLM，无 Key 用关键词引擎（仅验证链路，结果无校准意义）
 *   'llm'        —— 强制 LLM，无 Key 直接报错
 *   'keyword'    —— 强制关键词引擎
 */
async function calibrate(opts) {
  opts = opts || {};
  const mode = opts.mode || 'auto';
  const items = listGold();
  if (!items.length) {
    throw Object.assign(new Error('金标集为空，请先导入标注样本'), { status: 400 });
  }

  // 决定评分通道
  let channel;
  if (mode === 'llm') {
    if (!config.llm.enabled) throw Object.assign(new Error('未配置 LLM_API_KEY，无法按 llm 模式校准'), { status: 400 });
    channel = 'llm';
  } else if (mode === 'keyword') {
    channel = 'keyword';
  } else {
    channel = config.llm.enabled ? 'llm' : 'keyword';
  }
  const meaningful = channel === 'llm';   // 只有真实模型跑出的指标才有校准意义

  const limit = opts.limit ? Math.min(opts.limit, items.length) : items.length;
  const subset = items.slice(0, limit);

  const detail = [];
  const humanTotals = [];
  const modelTotals = [];
  const perDimHuman = {};
  const perDimModel = {};

  for (const it of subset) {
    const scene = require('./service').getScene(it.sceneId);
    if (!scene) { detail.push({ id: it.id, error: '场景不存在' }); continue; }

    const objectives = scene.objectives || [];
    const objectiveDim = objectives[Math.min(it.turnIndex - 1, objectives.length - 1)]
      ? objectives[Math.min(it.turnIndex - 1, objectives.length - 1)].dim : null;
    const ctx = {
      scene, objectives, objectiveDim,
      learnerText: it.learnerText, customerText: it.customerText,
      history: [{ role: 'customer', text: it.customerText }],
      turn: it.turnIndex, isCall: false, state: {}, kw: {}
    };

    let res;
    try {
      res = channel === 'llm' ? await ai.scoreByLLM(ctx) : ai.scoreByKeyword(ctx);
    } catch (e) {
      detail.push({ id: it.id, error: '评分失败：' + e.message });
      continue;
    }

    const h = it.humanScores || {};
    const m = res.dimScores || {};

    Object.keys(h).forEach((k) => {
      if (!perDimHuman[k]) { perDimHuman[k] = []; perDimModel[k] = []; }
      perDimHuman[k].push(Number(h[k]) || 0);
      perDimModel[k].push(Number(m[k]) || 0);
    });

    humanTotals.push(it.humanTotal);
    modelTotals.push(res.score);

    detail.push({
      id: it.id, sceneId: it.sceneId, turnIndex: it.turnIndex,
      learnerText: it.learnerText,
      humanScores: h, modelScores: m,
      humanTotal: it.humanTotal, modelTotal: res.score,
      delta: res.score - it.humanTotal,
      confidence: res.confidence
    });
  }

  const scored = detail.filter((d) => !d.error);
  const p = pearson(humanTotals, modelTotals);
  const m = mae(humanTotals, modelTotals);
  const modelHasVar = hasVariance(modelTotals);

  const perDim = Object.keys(perDimHuman).map((k) => ({
    dim: k,
    pearson: pearson(perDimHuman[k], perDimModel[k]),
    mae: mae(perDimHuman[k], perDimModel[k])
  }));

  const pass = {
    pearson: p !== null && p >= 0.8,
    mae: m !== null && m <= 8,
    overall: p !== null && p >= 0.8 && m !== null && m <= 8
  };

  const run = {
    at: nowStamp(),
    rubricVersion: config.rubricVersion,
    model: channel === 'llm' ? config.llm.model : 'keyword-engine',
    channel,
    meaningful,
    mode: meaningful ? 'live' : 'keyword(未配置 Key，指标无校准意义，仅验证链路可通)',
    n: scored.length,
    pearson: p, mae: m,
    pearsonNote: p === null
      ? (modelHasVar ? '样本数不足 2，无法计算相关系数' : '评分无区分度：所有样本得分相同，相关系数在数学上无定义')
      : '',
    perDim,
    pass,
    detail
  };

  db.prepare('INSERT INTO gold_runs (at,rubric_version,model,n,pearson,mae,detail) VALUES (?,?,?,?,?,?,?)')
    .run(run.at, run.rubricVersion, run.model, run.n, p, m, J(detail));

  log('system', 'gold.calibrate', '', `channel=${channel} n=${run.n} pearson=${p} mae=${m}`);
  return run;
}

function listRuns(limit) {
  return db.prepare('SELECT id,at,rubric_version,model,n,pearson,mae FROM gold_runs ORDER BY id DESC LIMIT ?')
    .all(limit || 20)
    .map((r) => {
      const meaningful = r.model !== 'keyword-engine';
      return {
        id: r.id, at: r.at, rubricVersion: r.rubric_version, model: r.model,
        channel: meaningful ? 'llm' : 'keyword',
        meaningful,
        n: r.n, pearson: r.pearson, mae: r.mae,
        pass: meaningful && r.pearson >= 0.8 && r.mae <= 8
      };
    });
}

module.exports = { pearson, mae, totalOf, importGold, listGold, upsertGold, calibrate, listRuns };
