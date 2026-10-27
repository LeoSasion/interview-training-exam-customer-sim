#!/usr/bin/env node
'use strict';
/**
 * 软著申请：源代码文档生成器（P25）
 *
 * 版权中心要求：
 *   - 提交源程序的前 1500 行 + 后 1500 行（共 3000 行、60 页、每页 50 行）
 *   - 页眉：软件名称 + 版本号（居中）
 *   - 页码：「第 X 页」
 *   - 不足 3000 行则全部提交
 *
 * 产出：docs/软著/源代码文档.pdf（A4，等宽字体，带行号）
 *
 *   node tools/gen-copyright-source.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', '软著');
const SOFT_NAME = '新员工仿真培训系统';
const SOFT_VERSION = 'V1.0';
const LINES_PER_PAGE = 50;
const HEAD_LINES = 1500;
const TAIL_LINES = 1500;

/* 源程序清单：按「入口 → 领域模块 → 数据层 → 前端」的逻辑顺序。
 * HTML 只取 <script> 内的 JS（CSS 与标记不属于程序逻辑）。 */
const FILES = [
  'server/index.js',
  'server/service.js',
  'server/lib/core.js',
  'server/lib/scenes.js',
  'server/lib/tasks.js',
  'server/lib/learners.js',
  'server/lib/records.js',
  'server/lib/coach.js',
  'server/auth.js',
  'server/ai.js',
  'server/db.js',
  'server/goldset.js',
  'server/config.js',
  'data/scoring-engine.js',
  'data/app-data.js',
  'assets/ai-bridge.js',
  'assets/admin-server-sync.js',
  '管理后台-仿真培训.html',
  '教练工作台-带教主管.html',
  '仿真培训原型-微信风格.html'
];

function readCode(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  let s = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  if (rel.endsWith('.html')) {
    // 只取 <script> 内的 JS，多个块顺序拼接
    const blocks = s.match(/<script>([\s\S]*?)<\/script>/g) || [];
    s = blocks.map((b) => b.replace(/<\/?script>/g, '')).join('\n');
  }
  return s.split('\n');
}

/* 1) 拼装完整源程序（带文件分隔注释，软著审查看得懂边界） */
const all = [];
let fileCount = 0;
FILES.forEach((rel) => {
  const lines = readCode(rel);
  if (!lines || !lines.length) return;
  fileCount++;
  all.push('/* ======== 文件：' + rel + ' ======== */');
  lines.forEach((l) => all.push(l));
  all.push('');
});
const totalLines = all.length;

/* 2) 取前 1500 + 后 1500；不足则全量 */
let picked;
let omitted = 0;
if (totalLines <= HEAD_LINES + TAIL_LINES) {
  picked = all.slice();
} else {
  /* 总行数必须正好 3000 = 60 页 × 50 行。
     省略标记占 2 行，所以前后各取 1499 行。 */
  const head = all.slice(0, HEAD_LINES - 1);
  const tail = all.slice(totalLines - (TAIL_LINES - 1));
  omitted = totalLines - head.length - tail.length;
  picked = head.concat(['/* ……（此处省略中间 ' + omitted + ' 行）…… */', '']).concat(tail);
}

/* 3) 分页（每页 50 行） */
const pages = [];
for (let i = 0; i < picked.length; i += LINES_PER_PAGE) {
  pages.push(picked.slice(i, i + LINES_PER_PAGE));
}
const totalPages = pages.length;

/* 4) 生成 HTML（每页一个固定 A4 容器，页眉/页码用绝对定位，打印最稳） */
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const body = pages.map((lines, idx) => {
  const rows = lines.map((l, j) => {
    const no = idx * LINES_PER_PAGE + j + 1;
    return '<div class="ln"><span class="no">' + String(no).padStart(5, ' ') + '</span>' + (esc(l) || ' ') + '</div>';
  }).join('');
  return '<section class="page">' +
    '<div class="hd">' + SOFT_NAME + ' ' + SOFT_VERSION + '</div>' +
    '<div class="code">' + rows + '</div>' +
    '<div class="ft">第 ' + (idx + 1) + ' 页</div>' +
    '</section>';
}).join('\n');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${SOFT_NAME} ${SOFT_VERSION} 源程序</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; font-family: "Consolas", "Courier New", "Microsoft YaHei", monospace; }
  .page {
    position: relative; width: 210mm; height: 297mm; padding: 22mm 18mm 16mm;
    page-break-after: always; overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  .hd {
    position: absolute; top: 11mm; left: 0; right: 0; text-align: center;
    font-family: "Microsoft YaHei", sans-serif; font-size: 10pt; color: #333;
    letter-spacing: .02em;
  }
  .ft {
    position: absolute; bottom: 9mm; left: 0; right: 0; text-align: center;
    font-family: "Microsoft YaHei", sans-serif; font-size: 9.5pt; color: #333;
  }
  .code { font-size: 8.6pt; line-height: 4.62mm; }
  .ln { white-space: pre; overflow: hidden; text-overflow: clip; }
  .no { display: inline-block; width: 11mm; color: #999; text-align: right; margin-right: 3mm; }
</style></head>
<body>
${body}
</body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const htmlPath = path.join(OUT_DIR, '源代码文档.html');
fs.writeFileSync(htmlPath, html, 'utf8');

/* 5) HTML → PDF（Chrome headless，绝对路径） */
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pdfPath = path.join(OUT_DIR, '源代码文档.pdf');
let pdfOk = false;
try {
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
    '--print-to-pdf=' + pdfPath.replace(/\\/g, '/'),
    'file:///' + htmlPath.replace(/\\/g, '/')
  ], { stdio: 'ignore', timeout: 120000 });
  pdfOk = fs.existsSync(pdfPath);
} catch (e) {
  console.log('  PDF 生成失败：' + e.message);
}

console.log('');
console.log('  软著 · 源代码文档');
console.log('  ─────────────────────────────────────────');
console.log('  软件名称    ' + SOFT_NAME + ' ' + SOFT_VERSION);
console.log('  源程序文件  ' + fileCount + ' 个');
console.log('  源程序总行  ' + totalLines + ' 行');
console.log('  提交行数    ' + picked.length + ' 行（前 1500 + 后 1500' + (omitted ? '，省略中间 ' + omitted + ' 行' : '') + '）');
console.log('  文档页数    ' + totalPages + ' 页（每页 ' + LINES_PER_PAGE + ' 行）');
console.log('  HTML        ' + path.relative(ROOT, htmlPath));
console.log('  PDF         ' + (pdfOk ? path.relative(ROOT, pdfPath) : '未生成（用 HTML 手动打印亦可）'));
console.log('  ─────────────────────────────────────────');

if (totalPages < 60) {
  console.log('  \x1b[33m提示\x1b[0m：软著通常要求 60 页（3000 行）。当前代码量偏少，');
  console.log('        按实际页数提交即可（不足 60 页全部提交），不影响受理。');
}
console.log('');
