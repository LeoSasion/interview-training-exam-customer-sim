#!/usr/bin/env node
'use strict';
/**
 * 恢复出厂：node server/tools/reset.js --yes
 *
 * ⚠️ 危险操作：删除 SQLite 主库及 -wal / -shm 伴生文件，重启后重新播种。
 *    只删 .db 会保留旧数据（WAL 里的内容会被回放），必须三个文件一起删。
 *
 * 运行前请先停掉服务（否则文件被占用，Windows 下会删除失败）。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const yes = process.argv.includes('--yes') || process.argv.includes('-y');
if (!yes) {
  console.log('');
  console.log('  该命令会删除数据库并恢复出厂数据：');
  console.log('    ' + config.dbFile);
  console.log('    ' + config.dbFile + '-wal');
  console.log('    ' + config.dbFile + '-shm');
  console.log('');
  console.log('  确认请加 --yes 重跑： node server/tools/reset.js --yes');
  console.log('  可先备份：          node server/tools/backup.js pre-reset');
  console.log('');
  process.exit(1);
}

const victims = [config.dbFile, config.dbFile + '-wal', config.dbFile + '-shm'];
const removed = [];
victims.forEach((f) => {
  try {
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(path.basename(f)); }
  } catch (e) {
    console.error('  ❌ 删除失败：' + f + ' —— ' + e.message);
    console.error('     常见原因：① 服务仍在运行（先 taskkill /F /IM node.exe 或 Ctrl+C）');
    console.error('              ② 文件被沙箱/杀软拦截（可改用 shell 删除）');
    console.error('     手工删除： rm -f ' + f + ' ' + f + '-wal ' + f + '-shm');
    process.exit(2);
  }
});

console.log('');
console.log('  ✅ 已删除：' + (removed.join(', ') || '（无文件）'));
console.log('     下次启动服务会自动重新播种（3 场景 / 12 学员 / 5 任务 / 28 成绩 / 10 金标）');
console.log('     并重新生成初始账号口令。');
console.log('');
