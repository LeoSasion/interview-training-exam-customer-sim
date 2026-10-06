'use strict';
/**
 * 口令哈希与随机串（零依赖，只用 node:crypto）
 *
 * 存储格式：salt（16 字节 hex） + scrypt 派生 64 字节。
 * 校验用 timingSafeEqual，避免比较耗时泄漏。
 *
 * 说明：这里刻意不做「慢哈希参数随版本升级」的复杂度，scrypt 默认参数
 * （N=16384, r=8, p=1）在本场景（内网小规模账号）足够；若未来接入企业
 * 统一身份（SSO），本模块整体替换即可，接口保持不变。
 */

const crypto = require('crypto');

const KEYLEN = 64;

/** 生成口令哈希，返回 { salt, hash } */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, KEYLEN).toString('hex');
  return { salt: s, hash: h };
}

/** 校验口令 */
function verifyPassword(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  let calc;
  try { calc = crypto.scryptSync(String(password), salt, KEYLEN); }
  catch (e) { return false; }
  const stored = Buffer.from(String(hash), 'hex');
  if (stored.length !== calc.length) return false;
  return crypto.timingSafeEqual(calc, stored);
}

/** URL 安全的随机串（可作初始口令 / session id） */
function randomToken(bytes) {
  return crypto.randomBytes(bytes || 24).toString('base64url');
}

/** 生成一个便于人工念读的初始口令 */
function randomPassphrase() {
  const words = ['qiang', 'meng', 'tao', 'xi', 'lin', 'yu', 'hao', 'jing', 'nan', 'bei'];
  const w = words[crypto.randomInt(words.length)];
  return w + String(crypto.randomInt(100000, 999999));
}

module.exports = { hashPassword, verifyPassword, randomToken, randomPassphrase };
