/**
 * 进程守护器（P10）—— 零 npm 依赖，刻意只做三件事：
 *
 *   1. 拉起 server/index.js 子进程，异常退出后自动重启（指数退避，1s 起步、封顶 30s）
 *   2. 把 SIGINT / SIGTERM 转发给子进程，自己等子进程退干净再退（不留孤儿）
 *   3. 把 PID 写进 server/store/daemon.pid，供 --stop 整树停止
 *
 * 用法：
 *   node server/daemon.js          # 守护启动（PORT / DB_FILE / AUTH_MODE 等环境变量原样透传）
 *   node server/daemon.js --stop   # 按 pid 文件结束整棵进程树（Windows: taskkill //T //F）
 *
 * 设计说明（为什么这么朴素）：
 *   - 生产更推荐 systemd / pm2 / Windows 服务，这里给的是「零依赖兜底」——
 *     试点环境没有运维工具时，至少保证后端崩了能自己爬起来。
 *   - 子进程【正常退出】（exit code 0）不重启：那是它自己想退（比如端口被占的启动失败重试没意义）。
 *   - 日志不落盘、只转发到本进程 stdout：调用方重定向到文件即可
 *     （node server/daemon.js >> server/store/daemon.log 2>&1），守护器不做日志轮转——
 *     越权做日志管理，轮转策略迟早和运维的日志收集打架。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(__dirname, 'index.js');
const PID_FILE = path.join(__dirname, 'store', 'daemon.pid');

/* ---- --stop：读 pid 文件，整树终止 ---- */
if (process.argv.includes('--stop')) {
  let pid = null;
  try {
    pid = Number(String(fs.readFileSync(PID_FILE, 'utf8')).trim());
  } catch (e) { /* 文件不存在视为已停 */ }
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    console.log('[daemon] 没有 PID 记录，视为已停止。');
    process.exit(0);
  }
  const { exec } = require('child_process');
  // //T 连同子进程树一起结束（否则守护器死了子进程会变孤儿继续占端口）
  exec(`taskkill /PID ${pid} /T /F`, (err) => {
    if (err) console.log('[daemon] 结束进程树 ' + pid + '：' + (err.message || '失败（可能已退出）'));
    else console.log('[daemon] 进程树 ' + pid + ' 已结束。');
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    process.exit(0);
  });
  return;
}

/* ---- 守护主循环 ---- */
let child = null;
let stopping = false;
let backoff = 1000;
let restarts = 0;
const startedAt = Date.now();

try {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch (e) {
  console.warn('[daemon] PID 文件写入失败（不影响守护，只影响 --stop）：' + e.message);
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function startChild() {
  child = spawn(process.execPath, [ENTRY], {
    env: Object.assign({}, process.env),   // PORT / DB_FILE / AUTH_MODE / DB_SYNC 原样透传
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT
  });

  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  child.on('exit', (code, signal) => {
    if (stopping) {
      console.log(`[daemon] ${ts()} 子进程已退出（code=${code} signal=${signal}），守护器结束。`);
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
      process.exit(0);
    }
    if (code === 0) {
      // 正常退出不重启：端口被占这类启动失败，重启只会无限循环
      console.log(`[daemon] ${ts()} 子进程正常退出（code=0），守护器随之结束。`);
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
      process.exit(0);
    }
    restarts++;
    console.log(`[daemon] ${ts()} 子进程异常退出（code=${code} signal=${signal}），${backoff / 1000}s 后第 ${restarts} 次重启`);
    setTimeout(() => {
      if (!stopping) startChild();
    }, backoff);
    backoff = Math.min(backoff * 2, 30000);   // 指数退避封顶 30s
  });

  console.log(`[daemon] ${ts()} 已拉起服务进程 pid=${child.pid}（守护 pid=${process.pid}，重启 ${restarts} 次）`);
}

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[daemon] ${ts()} 收到 ${sig}，转发给子进程并等待退出…`);
    if (child && child.exitCode === null) {
      try { child.kill(sig); } catch (e) { /* ignore */ }
      // 兜底：子进程 5s 内不退就强杀，避免守护器赖着不走
      setTimeout(() => {
        if (child && child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
      }, 5000);
    } else {
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
      process.exit(0);
    }
  });
});

process.on('exit', () => {
  try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
});

console.log(`[daemon] ${ts()} 守护器启动（入口 ${path.relative(ROOT, ENTRY)}）`);
startChild();
