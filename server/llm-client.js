'use strict';
/**
 * LLM 客户端：OpenAI 兼容 /chat/completions
 *
 * 设计要点：
 *  1. **零依赖**——用 Node 18+ 原生 fetch，不引任何 SDK。
 *  2. **可换厂商**——只认 baseUrl + apiKey + model，DeepSeek / 通义 / 智谱 /
 *     Moonshot / OpenAI 通用。
 *  3. **健壮**——超时（AbortController）、重试、JSON 宽容抽取（模型常把
 *     JSON 包在 ```json 里或多说一句）、失败抛结构化错误交上层降级。
 */

const config = require('./config');

class LLMError extends Error {
  constructor(msg, kind) { super(msg); this.name = 'LLMError'; this.kind = kind || 'error'; }
}

/** 从模型输出里宽容地抽出第一个 JSON 对象 */
function extractJSON(text) {
  if (!text) throw new LLMError('模型返回为空', 'empty');
  let s = String(text).trim();

  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 直接尝试
  try { return JSON.parse(s); } catch (e) { /* 继续 */ }

  // 截取第一个 { 到最后一个 }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const frag = s.slice(a, b + 1);
    try { return JSON.parse(frag); } catch (e) { /* 继续 */ }
    // 常见毛病：尾逗号
    try { return JSON.parse(frag.replace(/,\s*([}\]])/g, '$1')); } catch (e) { /* 继续 */ }
  }
  throw new LLMError('无法从模型输出中解析 JSON：' + s.slice(0, 200), 'parse');
}

/**
 * 调用对话补全
 * @returns {Promise<{content:string, usage:object, raw:object}>}
 */
async function chat(messages, opts) {
  opts = opts || {};
  if (!config.llm.enabled) throw new LLMError('未配置 LLM_API_KEY', 'no-key');

  const body = {
    model: opts.model || config.llm.model,
    messages,
    temperature: opts.temperature !== undefined ? opts.temperature : 0.5,
    stream: false
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const url = config.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const maxRetry = config.llm.maxRetry;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.llm.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + config.llm.apiKey
        },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        // 4xx 多为配置问题，不重试；5xx / 429 可重试
        if (resp.status < 500 && resp.status !== 429) {
          throw new LLMError(`HTTP ${resp.status}: ${txt.slice(0, 300)}`, 'http');
        }
        lastErr = new LLMError(`HTTP ${resp.status}: ${txt.slice(0, 200)}`, 'http');
        continue;
      }

      const data = await resp.json();
      const choice = (data.choices && data.choices[0]) || {};
      const content = (choice.message && choice.message.content) || '';
      return { content, usage: data.usage || {}, raw: data };
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof LLMError && e.kind === 'http') { lastErr = e; if (attempt < maxRetry) continue; break; }
      if (e.name === 'AbortError') { lastErr = new LLMError('模型请求超时', 'timeout'); continue; }
      lastErr = e;
      if (attempt < maxRetry) continue;
    }
  }
  throw lastErr || new LLMError('模型调用失败', 'unknown');
}

/** 调用并要求 JSON 返回 */
async function chatJSON(messages, opts) {
  const r = await chat(messages, Object.assign({ jsonMode: true }, opts || {}));
  return extractJSON(r.content);
}

/** 探活：最小请求验证 Key 与连通性 */
async function health() {
  if (!config.llm.enabled) {
    return { ok: false, mode: 'mock', reason: '未配置 LLM_API_KEY（当前走本地模拟）' };
  }
  try {
    const t0 = Date.now();
    const r = await chat([{ role: 'user', content: '回复两个字：正常' }], { temperature: 0, maxTokens: 16 });
    return { ok: true, mode: 'live', model: config.llm.model, baseUrl: config.llm.baseUrl,
             latencyMs: Date.now() - t0, sample: (r.content || '').trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, mode: 'live', model: config.llm.model, baseUrl: config.llm.baseUrl, reason: e.message };
  }
}

module.exports = { chat, chatJSON, extractJSON, health, LLMError };
