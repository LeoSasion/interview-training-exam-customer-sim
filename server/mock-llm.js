'use strict';
/**
 * 本地 Mock LLM 服务：用于在没有真实 API Key 时端到端验证整条链路。
 *
 * 它模拟 OpenAI 兼容接口 /chat/completions，行为特点：
 *  - 从 prompt 里解析出「学员本轮回答」，用一套**确定性的启发式规则**打分
 *    （比关键词引擎更接近语义：看长度、看疑问句、看数字/案例、看时间承诺）
 *  - 因此它有**区分度**，能让 Pearson 被真正算出来，验证校准链路数学正确性
 *  - 与真实模型接口完全一致，切换只需把 LLM_BASE_URL 指回真服务
 *
 * 启动：node server/mock-llm.js [port]
 */

const http = require('http');

const PORT = Number(process.argv[2] || 8999);

/** 从 prompt 中抽出学员本轮回答 */
function extractLearnerText(prompt) {
  const m = prompt.match(/学员本轮回答：([\s\S]*?)(?:\n注意：|\n请按上述规则|$)/);
  return m ? m[1].trim() : '';
}
function extractCustomerText(prompt) {
  const m = prompt.match(/客户说：([\s\S]*?)\n/);
  return m ? m[1].trim() : '';
}

/** 确定性启发式评分：模拟一个「还不错的评分官」 */
function heuristicScore(text) {
  const t = String(text || '');
  const len = t.length;
  const has = (re) => re.test(t);

  let d1 = 42, d2 = 42, d3 = 42, d4 = 42, d5 = 42;

  // d1 开场与礼貌：有称呼 / 自报家门 / 争取许可
  if (has(/您好|你好|张经理|王姐|李总/)) d1 += 14;
  if (has(/我是|我这边是|XX食品|小陈/)) d1 += 16;
  if (has(/方便|占用|几分钟|三分钟|打扰/)) d1 += 14;
  if (len > 120) d1 -= 8;                      // 啰嗦扣分
  if (len < 12) d1 -= 22;                      // 过短扣分

  // d2 需求挖掘：疑问句 / 追问
  const q = (t.match(/[？?]/g) || []).length;
  if (q >= 1) d2 += 16;
  if (q >= 2) d2 += 12;
  if (has(/您是|还是|哪一|多少|怎么|为什么|具体/)) d2 += 12;
  if (!q) d2 -= 10;

  // d3 异议处理：接情绪 / 不争辩
  if (has(/正常|理解|理解您|换我|确实|抱歉|不好意思|别急|您说得对/)) d3 += 20;
  if (has(/不是我们的问题|你找|这不怪我们|您不懂/)) d3 -= 30;   // 推卸责任重罚
  if (has(/您这顾虑|您担心/)) d3 += 10;

  // d4 方案讲解：案例 / 数据 / 可验证凭证
  if (has(/\d+\s*(家|个|份|%|天|次|门店|客户)/)) d4 += 18;
  if (has(/案例|之前|有家|一家|连锁餐饮|质检报告|损耗数据|第三方/)) d4 += 20;
  if (has(/质量很好|服务一流|放心|绝对|肯定没问题/) && !has(/\d/)) d4 -= 22;  // 空形容词

  // d5 促成推进：明确下一步 + 时间
  if (has(/周[一二三四五六日]|明天|明早|今天内|下周一|本周/)) d5 += 18;
  if (has(/发给您|发您|上门|电话跟|过一遍|确认|约定|方案/)) d5 += 16;
  if (has(/再考虑|回头联系|以后再说/)) d5 -= 12;
  if (len < 20) d5 -= 10;

  const clamp = (v) => Math.max(5, Math.min(97, Math.round(v)));
  return { d1: clamp(d1), d2: clamp(d2), d3: clamp(d3), d4: clamp(d4), d5: clamp(d5) };
}

/** 加权总分（与 TRAIN.dims 权重一致：15/25/25/20/15） */
const WEIGHTS = { d1: 15, d2: 25, d3: 25, d4: 20, d5: 15 };
function totalOf(s) {
  let sum = 0, w = 0;
  Object.keys(WEIGHTS).forEach((k) => { sum += s[k] * WEIGHTS[k]; w += WEIGHTS[k]; });
  return Math.round(sum / w);
}

/** 从 prompt 里数出「已经发生了几轮学员发言」，用于推进 NPC 剧本 */
function turnIndex(prompt) {
  // NPC prompt 里有「## 到目前为止的对话」段，历史中每条「学员：」算一轮已完成发言
  const m = prompt.match(/## 到目前为止的对话([\s\S]*?)(?:## 学员刚刚说|$)/);
  if (m) return (m[1].match(/学员[:：]/g) || []).length;
  // 兼容评分官 prompt 的「## 对话历史」段
  const m2 = prompt.match(/## 对话历史([\s\S]*?)(?:## 本轮|$)/);
  if (m2) return (m2[1].match(/学员[:：]/g) || []).length;
  return 0;
}

/** 生成客户 NPC 回复（模拟：按轮次从剧本池推进，语气随学员本轮表现浮动） */
function npcReply(prompt) {
  const learner = extractLearnerText(prompt);
  const score = totalOf(heuristicScore(learner));
  const pool = [
    '你好，报价单我看了，你们这个价格比我们现在合作的供应商高不少啊。',
    '我们一年采购量不小，这个价我没法跟老板交代。你们最低能给到多少？',
    '便宜是便宜，但便宜的东西我们以前吃过亏。你凭什么让我信你们质量？',
    '嗯……你说的那个门店我可以去看看。那物流时效怎么保证？',
    '行，这个方案听着还行。你打算什么时候给我？',
    '那就先这样吧，你发过来我看看再说。'
  ];
  // 轮次驱动前进：每完成一轮学员发言，NPC 推进一句，避免复读
  const idx = Math.min(turnIndex(prompt), pool.length - 1);
  const base = pool[idx] || '';
  // 学员本轮表现好 → 语气转暖；明显跑题 → 先表达不满再带出剧本（保证仍按轮次推进）
  const text = score >= 80
    ? '嗯，你这么说我倒是能听进去。' + base
    : (score < 40 ? '你先别急着介绍，' + base : base);
  const emotion = score >= 78 ? 'warm' : (score < 50 ? 'impatient' : 'skeptical');
  return { text, emotion, voiceSec: Math.min(12, Math.max(3, Math.round(text.length / 4))) };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) {}
    const msgs = payload.messages || [];
    const sys = (msgs.find((m) => m.role === 'system') || {}).content || '';
    const usr = (msgs.find((m) => m.role === 'user') || {}).content || '';
    const isScorer = /评分官/.test(sys) && /dimScores/.test(sys);
    const isNpc = /扮演客户/.test(sys);

    let content;
    if (isScorer) {
      const lt = extractLearnerText(usr);
      const s = heuristicScore(lt);
      const ct = extractCustomerText(usr);
      content = JSON.stringify({
        dimScores: s,
        score: totalOf(s),
        objectives: [
          { dim: 'd1', achieved: /您好|我是/.test(lt), evidence: lt.slice(0, 24) },
          { dim: 'd2', achieved: /[？?]/.test(lt), evidence: lt.slice(0, 24) },
          { dim: 'd4', achieved: /\d|案例|报告/.test(lt), evidence: lt.slice(0, 24) }
        ],
        feedback: totalOf(s) >= 75 ? '开场与推进都清楚，可以再加一组数据。' : '建议先接住客户的顾虑，再给依据。',
        confidence: 0.82,
        _mock: { customerText: ct }
      });
    } else if (isNpc) {
      content = JSON.stringify(npcReply(usr));
    } else {
      content = '正常';
    }

    const out = {
      id: 'mock-' + Date.now(),
      object: 'chat.completion',
      model: 'mock-scorer-v1',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 }
    };
    const s = JSON.stringify(out);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(s);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] OpenAI 兼容模拟服务已启动：http://127.0.0.1:${PORT}/v1`);
  console.log('[mock-llm] 用途：无 Key 时验证「LLM 双角色 + Rubric + 校准」全链路。');
});

module.exports = { heuristicScore, totalOf };
