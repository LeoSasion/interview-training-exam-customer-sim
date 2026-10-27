#!/usr/bin/env node
'use strict';
/**
 * 金标校准（直连版，不需要起服务）
 *
 * 为什么单独写一个：
 * 走 HTTP 校准要先起服务、登录、取 token、再 POST —— 换模型调参时太绕，
 * 而且"服务是否在跑"会干扰判断（你只想看模型跑出来的相关性）。
 * 这里直接调 goldset.calibrate()，一条命令出结果。
 *
 * 用法：
 *   LLM_API_KEY=sk-xxx node server/tools/calibrate.js
 *   LLM_API_KEY=sk-xxx LLM_MODEL=deepseek-chat node server/tools/calibrate.js
 *   node server/tools/calibrate.js --mode keyword     # 只跑本地关键词引擎（不需要 Key）
 *
 * 判定标准（README 里同一套）：
 *   pearson ≥ 0.60  模型与人工评分的方向基本一致，可以用
 *   mae     ≤ 15    平均分差在 15 分以内，可以接受
 *   两者都达标才算"可对外说校准通过"；未达标先别汇报准确率。
 */

const path = require('path');

// 允许通过环境变量注入 Key（也可写 .env.json，config.js 会读）
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || '';

const modeArg = process.argv.indexOf('--mode');
const mode = modeArg > -1 ? process.argv[modeArg + 1] : 'auto';

const config = require('../config');
const { calibrate, listGold } = require('../goldset');

(async () => {
  console.log('');
  console.log('  金标校准（直连，不经过 HTTP）');
  console.log('  ─────────────────────────────────────────');

  const gold = listGold();
  console.log('  金标样本：' + gold.length + ' 条');
  console.log('  通道配置：' + (config.llm.enabled ? 'LLM（' + config.llm.baseUrl + ' / ' + config.llm.model + '）' : '未配置 Key → 本地关键词引擎'));
  if (!KEY && !config.llm.enabled) {
    console.log('  \x1b[33m⚠ 没有 LLM_API_KEY：这次跑的是关键词引擎，指标只证明链路通，不能当准确率。\x1b[0m');
  }
  console.log('  ─────────────────────────────────────────');

  if (!gold.length) {
    console.log('  \x1b[31m金标集为空\x1b[0m：先导入标注样本（POST /goldset/import）。');
    process.exit(1);
  }

  let run;
  try {
    run = await calibrate({ mode });
  } catch (e) {
    console.log('  \x1b[31m校准失败：' + e.message + '\x1b[0m');
    process.exit(1);
  }

  const p = run.pearson, m = run.mae, n = run.n;
  const passP = p != null && p >= 0.6;
  const passM = m != null && m <= 15;
  const fmt = (v, digits) => (v == null ? '—' : Number(v).toFixed(digits || 3));

  console.log('');
  const channelLabel = run.meaningful ? 'llm（真实模型）'
    : (run.mock ? 'mock（本地模拟通道，仅验证链路）' : 'keyword（关键词引擎）');
  console.log('  通道      ' + channelLabel);
  console.log('  样本数    ' + n + ' / ' + gold.length);
  console.log('  Pearson   ' + fmt(p) + '   ' + (passP ? '\x1b[32m✓ ≥ 0.60\x1b[0m' : '\x1b[31m✗ 未达 0.60\x1b[0m'));
  console.log('  MAE       ' + fmt(m, 2) + '    ' + (passM ? '\x1b[32m✓ ≤ 15\x1b[0m' : '\x1b[31m✗ 超过 15\x1b[0m'));
  console.log('');

  if (run.channel === 'llm' && run.meaningful) {
    if (passP && passM) {
      console.log('  \x1b[32m可以对外说「校准通过」\x1b[0m：把下面这组数字一起写进材料——');
      console.log('    模型 ' + (MODEL || config.llm.model) + ' / n=' + n + ' / pearson=' + fmt(p) + ' / mae=' + fmt(m, 2));
    } else {
      console.log('  \x1b[33m还没到可以对外说的程度\x1b[0m：先别汇报准确率，建议按下面顺序调——');
      console.log('    1) 看 detail 里失败的样本（提示词太长/超时/JSON 解析失败）');
      console.log('    2) 微调评分提示词里的维度定义，让它和人工标注的口径对齐');
      console.log('    3) 换更强的模型再跑一次，对比 pearson');
    }
  } else {
    console.log('  \x1b[33m这只是链路验证\x1b[0m：关键词引擎的 pearson 不能当模型准确率。');
    console.log('  配置真实 Key 后重跑（同一个命令），才会得到可对外的数字：');
    console.log('    LLM_API_KEY=sk-xxx node server/tools/calibrate.js');
  }
  console.log('');
  process.exit(0);
})();
