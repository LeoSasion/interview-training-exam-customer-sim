#!/usr/bin/env node
'use strict';
/**
 * 内联事件处理器检查（P24）
 *
 * 为什么需要：三个页面大量使用 `onclick="openChat(0)"` 这种内联写法。
 * 一旦函数改名/删除，浏览器不会报错——**点下去毫无反应**，
 * 而这类问题用肉眼扫代码极难发现（我就为此排查过好几次"按钮点不了"）。
 *
 * 做法：抽出 HTML 里的 onclick / onchange / oninput / onkeydown 等属性，
 * 取出被调用的函数名，检查它是否在页面脚本里定义（或挂在 window 上）。
 *
 *   node server/tools/check-inline-handlers.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PAGES = [
  '管理后台-仿真培训.html',
  '教练工作台-带教主管.html',
  '仿真培训原型-微信风格.html',
  '产品规划-新员工培训系统.html'
];

const ATTRS = ['onclick', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onsubmit', 'onblur'];

let totalBad = 0;

console.log('');
console.log('  内联事件处理器检查');
console.log('  ─────────────────────────────────────────');

PAGES.forEach((name) => {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');

  /* 1) 页面脚本里定义的函数（含挂到 window 的） */
  const scripts = (src.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map((b) => b.replace(/<\/?script>/g, ''))
    .join('\n');
  const defined = new Set();
  let m;
  const reFn = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(scripts))) defined.add(m[1]);
  const reVar = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = reVar.exec(scripts))) defined.add(m[1]);
  const reWin = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = reWin.exec(scripts))) defined.add(m[1]);

  /* 2) 内联属性里被调用的函数 */
  const called = new Map();   // fn -> 首次出现的属性片段
  ATTRS.forEach((attr) => {
    const re = new RegExp(attr + '="([^"]*)"', 'g');
    let a;
    while ((a = re.exec(src))) {
      const body = a[1];
      // 只取「函数调用」形式：name(  ；忽略 this.xxx / event.xxx / console 等
      const reCall = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
      let c;
      while ((c = reCall.exec(body))) {
        const fn = c[1];
        // if / for 等关键字与内置跳过
        if (/^(if|for|while|return|typeof|new|void|delete|switch|catch)$/.test(fn)) continue;
        if (!called.has(fn)) called.set(fn, attr + '="' + body.slice(0, 40) + '"');
      }
    }
  });

  /* 3) 差集 */
  const bad = [];
  called.forEach((ctx, fn) => {
    if (!defined.has(fn)) bad.push({ fn, ctx });
  });

  if (!bad.length) {
    console.log('  \x1b[32m✓\x1b[0m ' + name + '（' + called.size + ' 个内联调用，全部有定义）');
    return;
  }
  totalBad += bad.length;
  console.log('  \x1b[31m✗\x1b[0m ' + name + '  →  ' + bad.length + ' 个调用了未定义的函数');
  bad.slice(0, 6).forEach((x) => console.log('       ' + x.fn + '   … ' + x.ctx));
});

console.log('  ─────────────────────────────────────────');
if (totalBad) {
  console.log('  \x1b[31m' + totalBad + ' 处会「点了没反应」\x1b[0m：函数改名/删除后内联属性没跟着改');
  process.exit(1);
}
console.log('  \x1b[32m全部通过\x1b[0m');
console.log('');
