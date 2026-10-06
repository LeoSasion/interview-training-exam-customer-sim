#!/usr/bin/env node
'use strict';
/**
 * 备份 CLI：node server/tools/backup.js [reason]
 * 生成一份 SQLite 一致性快照（VACUUM INTO），并打印最近几份备份。
 */

const backup = require('../backup');

const info = backup.create(process.argv[2] || 'cli');
console.log('');
console.log('  ✅ 备份完成');
console.log('  ─────────────────────────────────────────');
console.log('  文件：' + info.file);
console.log('  大小：' + Math.round(info.size / 1024) + ' KB');
console.log('  时间：' + info.at);
console.log('');
const list = backup.list();
console.log('  最近备份（保留最近 ' + backup.keep + ' 份）');
list.slice(0, 10).forEach((x) => {
  console.log('    ' + String(x.at).slice(0, 19).replace('T', ' ') + '  ' +
    String(Math.round(x.size / 1024)).padStart(6) + ' KB  ' + x.name);
});
console.log('');
console.log('  恢复方法：停服务 → 用备份文件覆盖 server/store/training.db');
console.log('            （同时删除 training.db-wal / training.db-shm）→ 重启服务');
console.log('');
