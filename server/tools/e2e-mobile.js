#!/usr/bin/env node
/**
 * 移动端 e2e（P13）：把「390×844 窄屏布局」的验证从人肉操作固化成脚本。
 *
 *   node server/tools/e2e-mobile.js            # 需要后端已在 8848 运行
 *   node server/tools/e2e-mobile.js --keep     # 结束后不关闭浏览器（调试用）
 *
 * 原理：agent-browser 改不了视口宽度，但 iframe 内的媒体查询按 iframe 尺寸算，
 * 同源时父页面可读子文档的 DOM 与 computedStyle——于是能在无真机环境验证窄屏。
 *
 * 为什么把它做成脚本：这条链路此前每次改动都要人肉开浏览器点一遍，
 * 而「移动端坏了」在桌面窗口里根本看不出来（媒体查询不触发）。
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8848';
const HARNESS = BASE + '/server/tools/mobile-harness.html';
const keep = process.argv.includes('--keep');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg + (extra ? '  → ' + extra : '')); }
}

function ab(args, timeout) {
  const a = args.slice();
  // shell:true 才能找到 PATH 里的 agent-browser（Windows 是 shim），
  // 但 shell 会把含空格/引号的表达式拆碎——所以 eval 的表达式要自己包一层双引号，
  // 并把内部换行压成空格（cmd 下引号内的换行不可靠）。
  if (a[0] === 'eval' && typeof a[1] === 'string' && a[1].charAt(0) !== '"') {
    a[1] = '"' + a[1].replace(/\s*\n\s*/g, ' ').replace(/"/g, '\\"') + '"';
  }
  const r = spawnSync('agent-browser', a, {
    encoding: 'utf8',
    shell: true,
    timeout: timeout || 240000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (r.error) throw new Error('调用 agent-browser 失败：' + r.error.message);
  return String(r.stdout || '').trim();
}

function evalJSON(expr) {
  const raw = ab(['eval', expr]);
  // eval 返回带引号的 JSON 字符串（agent-browser 会把表达式结果 JSON.stringify 两次）
  let out = raw;
  try { out = JSON.parse(raw); } catch (e) { /* raw 已是对象字面量 */ }
  try { return typeof out === 'string' ? JSON.parse(out) : out; }
  catch (e) { throw new Error('无法解析 eval 输出：' + raw.slice(0, 200)); }
}

const PROBE = `(function(){
  const f = document.getElementById('f');
  if (!f || !f.contentDocument) return JSON.stringify({ ready: false });
  const d = f.contentDocument, w = f.contentWindow;
  const phone = d.querySelector('.phone');
  const side = d.querySelector('.side');
  const fab = d.getElementById('mobileFab');
  const head = d.querySelector('.page-head');
  const pr = phone ? phone.getBoundingClientRect() : null;
  const fr = fab ? fab.getBoundingClientRect() : null;
  const mq = w.matchMedia('(max-width:960px)').matches;
  return JSON.stringify({
    ready: true,
    vw: d.documentElement.clientWidth,
    overflowX: d.documentElement.scrollWidth > d.documentElement.clientWidth + 2,
    mq,
    phone: pr ? { w: Math.round(pr.width), h: Math.round(pr.height), top: Math.round(pr.top) } : null,
    side: side ? w.getComputedStyle(side).display : null,
    fab: fab ? w.getComputedStyle(fab).display : null,
    fabRect: fr ? { right: Math.round(fr.right), bottom: Math.round(fr.bottom), w: Math.round(fr.width) } : null,
    head: head ? w.getComputedStyle(head).display : null
  });
})()`;

const TOGGLE = `(function(){
  const f = document.getElementById('f'), d = f.contentDocument, w = f.contentWindow;
  w.toggleMobileInfo();
  const side = d.querySelector('.side');
  const opened = side.classList.contains('mopen');
  const sr = side.getBoundingClientRect();
  const panelCovers = sr.top >= 0 && sr.left >= 0 && sr.width >= 380;
  const fabTextOpen = d.getElementById('mobileFab').textContent.trim();
  w.toggleMobileInfo();
  const closed = !d.querySelector('.side').classList.contains('mopen');
  return JSON.stringify({ opened, panelCovers, fabTextOpen, closed });
})()`;

(function main() {
  console.log('');
  console.log('  移动端 e2e（390×844 iframe 真实视口）');
  console.log('  ─────────────────────────────────────────');

  try {
    ab(['open', HARNESS]);
    ab(['wait', '--load', 'load']);
    ab(['eval', 'new Promise(r => setTimeout(r, 2500))']);
  } catch (e) {
    console.log('  \x1b[31m无法启动浏览器：' + e.message + '\x1b[0m');
    process.exit(2);
  }

  const s = evalJSON(PROBE);
  ok(s.ready === true, '测试页加载成功（390×844 iframe）');
  ok(s.vw === 390, '窄屏视口为 390px（实测 ' + s.vw + '）');
  ok(s.mq === true, '媒体查询 (max-width:960px) 已生效');
  ok(s.overflowX === false, '没有横向溢出（手机上不会出现左右滑动）');
  ok(!!s.phone && s.phone.w === 390 && s.phone.h === 844, '手机屏铺满整屏（实测 ' + (s.phone ? s.phone.w + '×' + s.phone.h : 'n/a') + '）');
  ok(!!s.phone && s.phone.top === 0, '手机屏从顶部开始（无多余留白）');
  ok(s.side === 'none', '左右信息栏已收起（不挤占手机屏）');
  ok(s.head === 'none', '页面标题区已隐藏（移动端不占空间）');
  ok(s.fab === 'flex', 'FAB「任务」按钮可见');
  ok(!!s.fabRect && s.fabRect.right <= 390 && s.fabRect.bottom <= 844,
    'FAB 在视口内（right=' + (s.fabRect ? s.fabRect.right : '?') + ', bottom=' + (s.fabRect ? s.fabRect.bottom : '?') + '）');

  const t = evalJSON(TOGGLE);
  ok(t.opened === true && t.panelCovers === true, '点 FAB 展开信息栏浮层（覆盖整屏可读）');
  ok(t.fabTextOpen === '收起', 'FAB 文案切换为「收起」');
  ok(t.closed === true, '再次点击可收起（不会卡住）');

  if (!keep) {
    try { ab(['close']); } catch (e) { /* ignore */ }
  }

  console.log('  ─────────────────────────────────────────');
  if (fail) {
    console.log('  结果：\x1b[31mPASS ' + pass + ' / FAIL ' + fail + '\x1b[0m');
    process.exit(1);
  }
  console.log('  结果：\x1b[32mPASS ' + pass + ' / FAIL 0\x1b[0m');
  console.log('');
  process.exit(0);
})();
