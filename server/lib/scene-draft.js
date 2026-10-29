'use strict';
/**
 * 场景草稿生成（P31）
 *
 * 问题：现在建一个场景要运营手写「客户人设 + 6 轮剧本 + 每轮考察点 + 参考话术」，
 * 实测约 40 分钟一个。而运营手里最多的素材其实是**真实客户聊天记录**——
 * 那些对话本身就带着客户的语气、顾虑和异议类型，比凭空编的准得多。
 *
 * 这里把「粘贴一段真实对话 → 生成可编辑的场景草稿」做成一条命令：
 * 模型只负责起草，草稿**不直接入库**，运营在编辑器里改完再走审核发布
 * （内容治理闸门：canAssign 只认 published，草稿不可能绕过审核）。
 *
 * 设计约束：
 *  - 模型返回的 JSON 一律归一化 + 钳制，绝不让脏结构进编辑器（那会让表单渲染炸掉）
 *  - 维度只认 d1..d5；数量与剧本轮次对齐；台词秒数钳到 3–60
 *  - 不做关键词降级：没有模型就明确报错。草稿是"从对话里提炼"，关键词引擎做不到，
 *    返回一个编造的结构只会浪费运营的时间并污染场景库。
 */

const config = require('../config');
const llm = require('../llm-client');
const { loadAppData, log } = require('../db');
const { requireUser, assertCanEdit } = require('./core');

const CATEGORIES = ['价格异议', '客诉安抚', '破冰挖掘', '服务承诺', '成交推进'];
const DIFFICULTIES = ['入门', '进阶', '挑战'];

/** 维度清单（id → 名称/说明），注入提示词，让模型按真实能力模型落 dim */
function dimsOf() {
  let T;
  try { T = loadAppData(); } catch (e) { return []; }
  return (T.dims || []).map((d) => ({ id: d.id, name: d.name, desc: d.desc || '' }));
}

function buildMessages(chat, dims) {
  const dimLines = dims
    .map((d) => `  ${d.id} ${d.name}：${d.desc}`)
    .join('\n');

  const system = [
    '你是连锁零售/快消行业的销售培训场景设计师。',
    '任务：根据一段**真实客户对话**，设计一个可用于新人微信对练的场景。',
    '',
    '产品的能力维度固定为 5 个（训练目标必须绑定其中之一）：',
    dimLines,
    '',
    '输出严格 JSON（不要 markdown 代码块、不要解释），结构：',
    '{',
    '  "name": "场景名，6-14 字，点明客户类型+核心矛盾",',
    '  "brief": "给学员的上下文，40-90 字：客户是谁、发生了什么、你这次要达成什么",',
    '  "persona": "客户人设，20-50 字：职务、性格、说话习惯、最在意什么",',
    '  "category": "价格异议|客诉安抚|破冰挖掘|服务承诺|成交推进 之一",',
    '  "difficulty": "入门|进阶|挑战 之一",',
    '  "passLine": 60-75 的整数,',
    '  "objectives": [ { "text": "这一轮要考察的具体行为，≤20 字", "dim": "d1..d5" } ],',
    '  "script": [ { "t": "客户这一轮说的话（口语，符合人设）", "v": 8 } ]',
    '}',
    '',
    '硬性要求：',
    '1. objectives 与 script **条数必须相同**，建议 5 条（场景不长于 5 轮）。',
    '2. 客户台词要贴着真实对话里的语气和关注点，不要写成教科书式提问；第一条应当是对话里真实出现过的开场。',
    '3. objectives 的 dim 至少覆盖 3 个不同维度；顺序与剧本轮次一一对应（第 N 轮考察第 N 条）。',
    '4. "v" 是朗读秒数，按台词长度估，8 个字约 3 秒。',
    '5. 不要编造客户没说过的品牌名、金额；真实对话里有的细节要保留。'
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: '真实客户对话如下：\n\n' + chat }
  ];
}

/** 把模型输出归一化成编辑器能安全渲染的结构（不合格就丢弃，绝不半成品塞进去） */
function normalize(raw, dims) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const dimIds = dims.map((d) => d.id);
  const fallbackDim = dimIds[0] || 'd1';

  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  let passLine = Math.round(Number(src.passLine));
  if (!isFinite(passLine)) passLine = 65;
  passLine = Math.max(0, Math.min(100, passLine));

  const category = CATEGORIES.indexOf(String(src.category || '').trim()) >= 0
    ? String(src.category).trim() : CATEGORIES[0];
  if (CATEGORIES.indexOf(String(src.category || '').trim()) < 0) {
    warnings.push('模型给的分类不在允许范围内，已归到「' + CATEGORIES[0] + '」');
  }
  const difficulty = DIFFICULTIES.indexOf(String(src.difficulty || '').trim()) >= 0
    ? String(src.difficulty).trim() : DIFFICULTIES[1];

  const objectives = (Array.isArray(src.objectives) ? src.objectives : [])
    .map((o) => {
      const t = text(o && o.text, 40);
      let dim = text(o && o.dim, 4);
      if (dimIds.length && dimIds.indexOf(dim) < 0) {
        warnings.push('有训练目标的维度「' + (dim || '空') + '」不合法，已归到 ' + fallbackDim);
        dim = fallbackDim;
      }
      return { text: t, dim: dim || fallbackDim };
    })
    .filter((o) => o.text)
    .slice(0, 8);

  const script = (Array.isArray(src.script) ? src.script : [])
    .map((x) => {
      const t = text(x && x.t, 300);
      let v = Math.round(Number(x && x.v));
      if (!isFinite(v) || v <= 0) v = Math.max(3, Math.round(t.length / 3));
      v = Math.max(3, Math.min(60, v));
      return { t, v };
    })
    .filter((x) => x.t)
    .slice(0, 8);

  if (!script.length) return { ok: false, error: '模型没有生成可用的客户台词，请换一段更完整的对话重试' };
  if (!objectives.length) {
    warnings.push('模型没有给出训练目标，已按轮次留空，需要你手工补');
  }
  if (objectives.length !== script.length) {
    warnings.push('训练目标 ' + objectives.length + ' 条 vs 台词 ' + script.length +
      ' 轮，两者不等时多出的目标不会被考察');
  }
  const usedDims = new Set(objectives.map((o) => o.dim));
  if (usedDims.size < 3) {
    warnings.push('训练目标只覆盖了 ' + usedDims.size + ' 个维度（建议 ≥ 3），可手工补全');
  }

  return {
    ok: true,
    warnings,
    draft: {
      name: text(src.name, 40) || '未命名场景草稿',
      brief: text(src.brief, 400),
      persona: text(src.persona, 200),
      category, difficulty, passLine,
      objectives, script,
      voicePool: []
    }
  };
}

/**
 * 生成场景草稿
 * @param {{chat:string, note?:string}} input
 * @param {string} userId 调用者（必须是可编辑角色）
 */
async function generateSceneDraft(input, userId) {
  const user = requireUser(userId);
  assertCanEdit(user);

  const chat = String((input && input.chat) || '').trim();
  if (chat.length < 30) {
    throw Object.assign(new Error('对话内容太短（至少 30 字）。贴一段完整的客户往来效果最好'), { status: 400 });
  }
  if (chat.length > 8000) {
    throw Object.assign(new Error('对话过长（上限 8000 字），贴最关键的几轮即可'), { status: 400 });
  }
  if (!config.llm.enabled) {
    throw Object.assign(new Error(
      '未配置模型 Key，无法生成草稿（场景草稿需要真实模型从对话里提炼）。可手工新建场景，或先配置 LLM_API_KEY'),
      { status: 400 });
  }

  const dims = dimsOf();
  const messages = buildMessages(chat, dims);

  /* 实测 deepseek-flash 偶发返回空 content（同一段输入下一次就正常）。
   * 这种情况既不值得让运营手工重试，也不该当成"模型不行"报出去——
   * 空返回重试一次；超时 / 4xx 才直接报错（重试也没用，还多等一轮）。 */
  let raw = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await llm.chatJSON(messages, { temperature: 0.4, maxTokens: 2600, timeoutMs: 60000 });
      break;
    } catch (e) {
      lastErr = e;
      const kind = (e && e.kind) || '';
      if (kind !== 'empty' && kind !== 'parse') break;   // 只对"空/坏 JSON"重试
    }
  }
  if (!raw) {
    const why = lastErr ? lastErr.message : '未知原因';
    throw Object.assign(new Error('模型调用失败：' + why + '（可重试，或手工新建）'), { status: 502 });
  }

  const norm = normalize(raw, dims);
  if (!norm.ok) throw Object.assign(new Error(norm.error), { status: 502 });

  const out = {
    draft: norm.draft,
    warnings: norm.warnings,
    model: config.llm.model,
    sourceChars: chat.length
  };
  log(userId, 'scene.draft', '', norm.draft.name + ' · ' + norm.draft.objectives.length + ' 目标 / ' +
    norm.draft.script.length + ' 轮');
  return out;
}

module.exports = { generateSceneDraft };
