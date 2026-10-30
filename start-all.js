#!/usr/bin/env node
/**
 * 一键启动全栈（P11 优化）
 *
 * 以前演示要手动开三个窗口（后端 8848 / Mock 模型 8999 / 语音识别 8997），
 * 且「哪个起来了、哪个没起来」全靠肉眼。这个脚本一次搞定：
 *   node start-all.js            # 全起（缺哪个起哪个，已占端口的跳过）
 *   node start-all.js --no-asr   # 不起语音识别（不演示语音时省 45s 模型加载）
 *   node start-all.js --no-mock  # 不起 Mock 模型（已配真实 Key 时用）
 *
 * Ctrl+C 结束全部子进程。
 */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const args = process.argv.slice(2);
const withAsr = !args.includes('--no-asr');
const withMock = !args.includes('--no-mock');

const C = {
  g: (s) => '\x1b[32m' + s + '\x1b[0m',
  y: (s) => '\x1b[33m' + s + '\x1b[0m',
  d: (s) => '\x1b[90m' + s + '\x1b[0m'
};

/** 端口是否已在监听 */
function isUp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(600);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

/** 轻量 GET（健康探测，2s 超时） */
function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 && /"ok"\s*:\s*true|"object"|"model"/.test(body)));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const services = [
  {
    name: '后端主服务',
    port: 8848,
    cmd: process.execPath,
    cmdArgs: [path.join(ROOT, 'server', 'index.js')],
    health: 'http://127.0.0.1:8848/api/v1/status',
    log: path.join(ROOT, 'server', 'store', 'run-backend.log'),
    enabled: true,
    waitMs: 20000
  },
  {
    name: 'Mock 大模型',
    port: 8999,
    cmd: process.execPath,
    cmdArgs: [path.join(ROOT, 'server', 'mock-llm.js')],
    health: 'http://127.0.0.1:8999/v1/models',
    log: path.join(ROOT, 'server', 'store', 'run-mock.log'),
    enabled: withMock,
    waitMs: 15000
  },
  {
    name: '语音识别 ASR',
    port: 8997,
    cmd: 'D:\\\\wbproject\\\\_tools\\\\asr-venv\\\\Scripts\\\\python.exe',
    cmdArgs: [path.join(ROOT, 'voice', 'asr-server.py')],
    health: 'http://127.0.0.1:8997/health',
    log: path.join(ROOT, 'voice', 'run-asr.log'),
    enabled: withAsr,
    waitMs: 90000        // 模型冷加载 45-60s，留足
  }
];

const children = [];

function shutdown(code) {
  children.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } });
  process.exit(code);
}
process.on('SIGINT', () => { console.log('\n  正在停止全部服务…'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

(async function main() {
  console.log('');
  console.log('  新员工培训系统 · 一键启动');
  console.log('  ─────────────────────────────────────────');

  const fs = require('fs');
  const logDir = path.join(ROOT, 'server', 'store');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  // 1) 已在跑的跳过，缺的拉起
  const started = [];
  for (const s of services) {
    if (!s.enabled) { console.log(`  ${C.d('跳过')}  ${s.name}（--no 参数）`); continue; }
    if (await isUp(s.port)) { console.log(`  ${C.g('已运行')} ${s.name} :${s.port}（跳过启动）`); continue; }
    const out = fs.openSync(s.log, 'w');
    const child = spawn(s.cmd, s.cmdArgs, {
      cwd: ROOT,
      env: Object.assign({}, process.env, s.port === 8848 ? { PORT: '8848' } : {}),
      stdio: ['ignore', out, out],
      windowsHide: true
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) console.log(`  ${C.y('注意')} ${s.name} 已退出（code ${code}），日志：${path.basename(s.log)}`);
    });
    children.push(child);
    started.push(s);
    console.log(`  ${C.d('启动中')} ${s.name} :${s.port} …`);
  }

  // 2) 健康轮询（按各自 waitMs；一次跑完，避免串行等待）
  if (started.length) {
    const waits = started.map((s) => new Promise((resolve) => {
      const t0 = Date.now();
      const tick = async () => {
        if (await ping(s.health)) return resolve({ s, ok: true, ms: Date.now() - t0 });
        if (Date.now() - t0 > s.waitMs) return resolve({ s, ok: false, ms: Date.now() - t0 });
        setTimeout(tick, 800);
      };
      tick();
    }));
    const results = await Promise.all(waits);
    console.log('  ─────────────────────────────────────────');
    results.forEach(({ s, ok, ms }) => {
      if (ok) console.log(`  ${C.g('就绪')} ${s.name.padEnd(12)} :${s.port}  ${C.d('(' + Math.round(ms / 100) / 10 + 's)')}`);
      else console.log(`  ${C.y('超时')} ${s.name.padEnd(12)} :${s.port}  详见 ${path.basename(s.log)}`);
    });
  }

  console.log('  ─────────────────────────────────────────');
  console.log('  页面入口（同一地址打开，天然同源）');
  const base = 'http://127.0.0.1:8848/';
  console.log(`    学员端     ${base}仿真培训原型-微信风格.html`);
  console.log(`    教练工作台 ${base}教练工作台-带教主管.html   ${C.d('admin/admin123 或 coach2/coach123')}`);
  console.log(`    管理后台   ${base}管理后台-仿真培训.html`);
  console.log(`    项目门户   ${base}index.html`);
  console.log('');
  console.log(`  ${C.d('按 Ctrl+C 停止全部服务（日志在 server/store/run-*.log）')}`);
  console.log('');
})();
