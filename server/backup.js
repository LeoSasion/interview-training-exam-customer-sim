'use strict';
/**
 * SQLite 备份（零依赖）
 *
 * 用 `VACUUM INTO` 做一致性快照 —— 在 WAL 模式下也安全，且不需要停服务。
 * 数据只有一个 .db 文件是这套方案最大的运维风险，因此这里给出：
 *   1) 一键快照（HTTP 接口 /api/v1/admin/backup 与 CLI 两种触发方式）
 *   2) 保留最近 N 份，自动清理旧的
 *   3) 恢复说明（见 server/README.md「备份与恢复」）
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const dbm = require('./db');

const KEEP = Number(process.env.BACKUP_KEEP || 20);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 生成一份快照，返回 { file, size, at } */
function create(reason) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const base = path.basename(config.dbFile).replace(/\.db$/, '');
  const file = path.join(config.backupDir, `${base}-${stamp()}.db`);
  // VACUUM INTO 要求目标文件不存在；同名（同秒）时加后缀
  let target = file;
  let n = 1;
  while (fs.existsSync(target)) target = file.replace(/\.db$/, `-${++n}.db`);
  const sql = "VACUUM INTO '" + target.replace(/'/g, "''") + "'";
  dbm.db.exec(sql);
  const st = fs.statSync(target);
  const info = { file: target, size: st.size, at: new Date().toISOString(), reason: reason || 'manual' };
  dbm.log('system', 'db.backup', path.basename(target), `${Math.round(st.size / 1024)} KB${reason ? ' · ' + reason : ''}`);
  prune();
  return info;
}

/** 只保留最近 KEEP 份 */
function prune() {
  try {
    const files = fs.readdirSync(config.backupDir)
      .filter((f) => /\.db$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(config.backupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(KEEP).forEach((x) => {
      try { fs.unlinkSync(path.join(config.backupDir, x.f)); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

function list() {
  try {
    return fs.readdirSync(config.backupDir)
      .filter((f) => /\.db$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(config.backupDir, f));
        return { file: path.join(config.backupDir, f), name: f, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch (e) { return []; }
}

module.exports = { create, list, prune, keep: KEEP };
