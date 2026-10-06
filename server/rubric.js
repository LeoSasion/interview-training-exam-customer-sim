'use strict';
/**
 * Rubric 定义：把「什么样的回复算好」写成可执行的口径。
 *
 * 权重从 TRAIN.dims 读（单一真相源），锚点在这里维护。
 * 评分官 prompt 完全由本文件生成——改口径只改这里，不在别处硬编码。
 */

const config = require('./config');
const { loadAppData } = require('./db');

/** 五维评分锚点（高 / 中 / 低分特征），业务方可直接评审这份文案 */
const ANCHORS = {
  d1: {
    name: '开场与礼貌',
    intent: '能否在 20 秒内完成「自报家门 + 说明来意 + 争取沟通许可」，且不显得背稿。',
    high: '自报家门与来意清晰，主动争取沟通许可（如"方便占用您三分钟吗"），语气自然不谄媚。',
    mid: '有自我介绍但略长或漏掉来意；基本礼貌到位但不主动争取许可。',
    low: '上来就讲产品 / 报价，没自报家门；或全程无称呼、无礼貌用语。'
  },
  d2: {
    name: '需求挖掘',
    intent: '是否先问清客户真实顾虑（价格 / 质量 / 售后 / 用量 / 决策链）再给方案。',
    high: '提出至少 1 个开放性问题且指向具体顾虑，并顺着客户回答追问了一层。',
    mid: '有提问但偏封闭（是否类）或只问了一句就转去讲解。',
    low: '完全没问，客户一抱怨就开始解释或推销。'
  },
  d3: {
    name: '异议处理',
    intent: '面对客户负面情绪时，是否先接情绪、再澄清事实、后给方案。',
    high: '先复述/认可客户感受（"您这个顾虑很正常"），再追问具体点，最后才谈解决，全程不对立。',
    mid: '有安抚但很快转到辩解；或只道歉没推进。',
    low: '直接反驳客户（"不是您想的那样"），或把责任推给客户/公司其他部门。'
  },
  d4: {
    name: '方案讲解',
    intent: '讲解是否有案例 / 数据 / 可验证凭证支撑，而不是堆形容词。',
    high: '至少给出 1 个同类客户案例或 1 组可验证数据（质检报告 / 合作门店数 / 交付记录），且与客户顾虑对应。',
    mid: '有具体信息但没和客户的顾虑明确挂钩；或只给结论不给依据。',
    low: '全是"我们质量很好""服务一流"这类无法验证的形容词。'
  },
  d5: {
    name: '促成推进',
    intent: '结束时是否把「下一步做什么、什么时候、谁跟进」说死。',
    high: '明确给出下一步动作 + 时间 + 责任人（如"我周四前把质检报告发您，周五电话跟您确认"），并当场确认。',
    mid: '提了下一步但含糊（"我回头联系您"），没有时间点。',
    low: '以"那您再考虑考虑"结束，没有推进动作。'
  }
};

/** 取当次生效的 Rubric（权重来自数据源，锚点来自本文件） */
function currentRubric() {
  const T = loadAppData();
  const dims = (T.dims || []).map((d) => {
    const a = ANCHORS[d.id] || {};
    return {
      id: d.id,
      name: d.name || a.name || d.id,
      weight: d.weight || 0,
      desc: d.desc || '',
      intent: a.intent || '',
      high: a.high || '',
      mid: a.mid || '',
      low: a.low || ''
    };
  });
  const total = dims.reduce((s, d) => s + d.weight, 0);
  return { version: config.rubricVersion, dims, weightSum: total };
}

/** 生成评分官 system prompt */
function buildScorerSystemPrompt(rubric) {
  const lines = rubric.dims.map((d, i) => {
    return `${i + 1}. 【${d.name}】(id=${d.id}, 权重 ${d.weight}%)
   考察意图：${d.intent}
   高分特征：${d.high}
   中分特征：${d.mid}
   低分特征：${d.low}`;
  }).join('\n');

  return `你是「XX食品 · 连锁渠道事业部」新员工销售话术训练的资深评分官。
你的任务：对学员在一轮客户对话中的发言，按 5 个能力维度打分，并判定训练目标是否达成。

## 评分维度与锚点（Rubric ${rubric.version}）
${lines}

## 打分规则
- 每个维度 0–100 整数分。参照锚点：完全符合高分特征 → 85–95；中等 → 60–80；
  符合低分特征 → 30–55；该轮完全未涉及该维度 → 40 分左右（不给 0，避免过度惩罚）。
- 不要所有维度都给相近的分——必须体现差异，这是这套评分存在的意义。
- 证据优先：只有在学员的话里找到明确依据才给高分，` + '`evidence`' + ` 字段必须引用学员原话片段（可节选）。
- 总分 score = Σ(维度分 × 权重) / 100，四舍五入取整。
- confidence 为你对自己评分的置信度（0–1）。若学员发言与本轮目标完全无关、
  或内容过短无法判断，confidence 应低于 0.6。

## 输出格式
只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块：
{
  "dimScores": { "d1": 82, "d2": 74, "d3": 68, "d4": 77, "d5": 71 },
  "objectives": [ { "dim": "d1", "achieved": true, "evidence": "学员原话片段" } ],
  "feedback": "一句话点评：先说做对的，再说最该改的一点（40 字内）",
  "confidence": 0.86
}
`;
}

/** 生成评分官 user prompt（把场景、目标、客户发言、学员发言、历史装进去） */
function buildScorerUserPrompt(ctx) {
  const s = ctx.scene || {};
  const objLines = (ctx.objectives || []).map((o, i) =>
    `  ${i + 1}. [${o.dim}] ${o.text}`).join('\n');
  const hist = (ctx.history || []).map((h) =>
    `  ${h.role === 'learner' ? '学员' : '客户'}：${h.text}`).join('\n');
  return `## 场景
${s.name || ''} — ${s.subtitle || ''}
背景：${s.brief || ''}

## 本轮考察的训练目标
${objLines || '  （无）'}

## 对话历史
${hist || '  （本轮为第一轮）'}

## 本轮
客户说：${ctx.customerText || '（开场）'}
学员本轮回答：${ctx.learnerText}
${ctx.isCall ? '\n注意：本轮发生在**语音通话**中，请把口头表达的流畅度与主动性也纳入考量。' : ''}

请按上述规则评分，只输出 JSON。`;
}

/** 生成客户 NPC 的 system prompt */
function buildNpcSystemPrompt(scene, ctx) {
  const pool = (scene.voicePool || [])[(ctx.turn || 1) - 1] || [];
  const poolHint = pool.length ? `\n本轮的参考话术（可用其语气，不要照抄）：${pool.join(' / ')}` : '';
  const tail = (scene.script || []).slice(ctx.turn || 1).map((x, i) => `  第${(ctx.turn || 1) + 1 + i}轮会说到：${x.t}`).join('\n');
  return `你在一场销售话术仿真训练中扮演客户。必须始终以客户身份说话，绝不跳出角色。

## 你扮演的客户
姓名/称呼：${scene.name || '客户'}
画像：${scene.subtitle || ''}
背景：${scene.brief || ''}
你的性格与难度：${scene.difficulty || '进阶'}——难度越高越挑剔、越会追问、越不容易松口。${poolHint}

## 剧本走向（你后续要表达的，按顺序，但不要一次说完）
${tail || '  （剧本已到最后一轮）'}

## 说话规则
1. 只说 1–3 句，口语化，像真实微信/电话对话，不写旁白、不加引号、不加"客户："前缀。
2. 严格保持与你人设一致的态度；如果学员答得好，可以逐步松动（但仍保持谨慎）。
3. 不要替学员总结、不要给学员建议、不要评价学员的表现——那是评分官的事。
4. 学员如果答得空洞或跑题，你要追问或表现出不耐烦，而不是照样往下走。
5. 情绪从以下选一个：calm（平静）/ impatient（不耐烦）/ skeptical（怀疑）/ pressured（有压力）/ warm（松动）。`;
}

/** 生成 NPC user prompt */
function buildNpcUserPrompt(ctx) {
  const hist = (ctx.history || []).map((h) =>
    `${h.role === 'learner' ? '学员' : '客户'}：${h.text}`).join('\n');
  return `## 到目前为止的对话
${hist || '（还没有开始）'}

## 学员刚刚说
${ctx.learnerText}

请你作为客户回应。只输出一个 JSON 对象，不要任何解释：
{
  "text": "你的回应（1–3 句中文口语）",
  "emotion": "calm | impatient | skeptical | pressured | warm",
  "voiceSec": 5
}
voiceSec 是你这句话念出来的大致秒数（3–12 的整数）。`;
}

module.exports = {
  ANCHORS, currentRubric,
  buildScorerSystemPrompt, buildScorerUserPrompt,
  buildNpcSystemPrompt, buildNpcUserPrompt
};
