/**
 * 语音识别适配层（P11）—— 本地 FunASR · SenseVoice-Small。
 *
 * 架构刻意分两层：
 *   voice/asr-server.py（8997，Python，模型常驻）← 本文件（Node 适配层）← 学员端
 *
 * 为什么不把模型塞进主服务：加载要 15s、内存数百 MB，混进 8848 会让主服务
 * 启动变慢且一崩全崩。语音是「增强能力」：ASR 服务不在线时学员端照常打字练，
 * 本层全部静默降级（与铁律 8 一致：绝不阻塞 UI、绝不抛错）。
 */
'use strict';

const config = require('./config');

/** ASR 服务是否在线（health 探测，短超时） */
async function asrOnline() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(config.voice.asrBase + '/health', { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const d = await r.json().catch(() => null);
    return !!(d && d.ok);
  } catch (e) {
    return false;
  }
}

/**
 * 音频 → 文本。成功返回 {ok:true,text,infer_ms}；服务不可达返回
 * {ok:false,error:'asr-unavailable',status:503}——调用方据此提示改用键盘，
 * 而不是把「服务没起」伪装成「识别为空」。
 */
async function transcribe(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: '空音频', status: 400 };
  }
  if (buffer.length > config.voice.maxBytes) {
    return { ok: false, error: '音频过大（上限 ' + Math.round(config.voice.maxBytes / 1024 / 1024) + 'MB）', status: 413 };
  }
  let r;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), config.voice.asrTimeoutMs);
    r = await fetch(config.voice.asrBase + '/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },   // Python 侧会按内容嗅探，webm/wav 均可
      body: buffer,
      signal: ctl.signal
    });
    clearTimeout(t);
  } catch (e) {
    const offline = { ok: false, error: '语音识别服务不可达', status: 503 };
    return offline;
  }
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    return { ok: false, error: (d && d.error) || ('ASR HTTP ' + r.status), status: r.status };
  }
  const d = await r.json().catch(() => null);
  if (!d || d.ok !== true || typeof d.text !== 'string') {
    return { ok: false, error: 'ASR 返回异常', status: 502 };
  }
  return { ok: true, text: d.text, inferMs: d.infer_ms | 0 };
}

module.exports = { asrOnline, transcribe };
