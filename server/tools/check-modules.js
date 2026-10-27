#!/usr/bin/env node
'use strict';
/**
 * 模块完整性检查（P23）
 *
 * 为什么需要：拆 service.js 时连续踩了三次同一个坑——
 * `node --check` 全过、服务能启动，但某个模块用了没 import 的标识符 /
 * 导出了没定义的函数 / require 路径多了一层 lib/，都是**调用那一刻**才炸。
 *
 * 这个脚本不看语法，直接 `require` 每个模块并检查：
 *   1. 能不能被 require（路径、循环引用）
 *   2. 导出的每个值是不是真的存在（不是 undefined/空）
 *
 *   node server/tools/check-modules.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib');

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    console.log('  \x1b[31m✗\x1b[0m ' + name + '  → ' + e.message);
  }
};

console.log('');
console.log('  服务端模块完整性检查');
console.log('  ─────────────────────────────────────────');

/* 1) 每个 lib 模块能 require 且导出解析得到 */
const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();
files.forEach((f) => {
  check('lib/' + f + ' 可加载', () => {
    const m = require(path.join(LIB, f));
    const keys = Object.keys(m);
    if (!keys.length) throw new Error('没有导出任何东西');
    const bad = keys.filter((k) => m[k] === undefined || m[k] === null);
    if (bad.length) throw new Error('导出了 undefined：' + bad.join(','));
  });
});

/* 2) service.js 的 56 个导出全部可用（它是路由层的唯一入口） */
check('service.js 全部导出可用', () => {
  const svc = require(path.join(ROOT, 'service.js'));
  const keys = Object.keys(svc);
  if (!keys.length) throw new Error('service.js 没有导出');
  const bad = keys.filter((k) => svc[k] === undefined || svc[k] === null);
  if (bad.length) throw new Error(bad.length + ' 个导出是 undefined：' + bad.slice(0, 8).join(','));
  if (keys.length < 40) throw new Error('导出数量异常偏少（' + keys.length + '），可能漏了模块');
});

/* 3) index.js 能被 require（真正起服务的入口，能抓住循环引用的最后一道） */
check('index.js 可加载', () => {
  // 只 require 不 listen：index.js 末尾才 listen，require 阶段不会占端口
  require(path.join(ROOT, 'index.js'));
});

console.log('  ─────────────────────────────────────────');
if (fail) {
  console.log('  \x1b[31m' + fail + ' 项失败\x1b[0m：以上都是"能解析但跑不起来"的问题');
  process.exit(1);
}
console.log('  \x1b[32m全部通过\x1b[0m');
console.log('');
