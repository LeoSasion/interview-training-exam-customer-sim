'use strict';
/**
 * 服务配置
 * 所有可调项集中在这里；密钥优先读环境变量，其次读 server/.env.json（不入版本库）。
 *
 * 大模型走 OpenAI 兼容接口（/chat/completions），因此 DeepSeek / 通义 / 智谱 /
 * Moonshot / OpenAI 等只要改 baseUrl + model 即可，无需改代码。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 读取 server/.env.json（不存在则返回空对象） */
function loadEnvFile() {
  const p = path.join(__dirname, '.env.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[config] .env.json 解析失败，已忽略：' + e.message);
  }
  return {};
}

const file = loadEnvFile();
const pick = (k, dflt) => (process.env[k] !== undefined ? process.env[k] : (file[k] !== undefined ? file[k] : dflt));

/** 逗号分隔 → 数组 */
function list(k, dflt) {
  const v = pick(k, dflt);
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  /** 服务端口 */
  port: Number(pick('PORT', 8848)),
  /**
   * 监听地址
   *   127.0.0.1 = 仅本机（默认，最安全）
   *   0.0.0.0   = 允许内网其他机器访问（小范围试点用；务必同时收紧 CORS 与开启鉴权）
   */
  host: pick('HOST', '127.0.0.1'),
  /** 静态资源根目录（原型页面就在项目根） */
  root: ROOT,
  /** SQLite 文件位置 */
  dbFile: pick('DB_FILE', path.join(__dirname, 'store', 'training.db')),
  /** 备份目录 */
  backupDir: pick('BACKUP_DIR', path.join(__dirname, 'store', 'backup')),

  /**
   * SQLite 落盘同步级别（PRAGMA synchronous）
   *
   *   NORMAL（默认）= WAL 模式下的**官方推荐值**：进程崩溃不会损坏库，只可能丢
   *                   「崩溃前最后几个已提交事务」；断电 / 系统崩溃才会丢一小段。
   *   FULL          = 恢复 SQLite 出厂行为（每次提交都 fsync）。
   *
   * 为什么要显式设成 NORMAL：SQLite 的出厂默认是 FULL，在 WAL 下**每次 INSERT /
   * UPDATE 提交都要 fsync 一次**。本机实测单条写入提交耗时——
   *     FULL 43.96ms   vs   NORMAL 0.06ms   （约 700 倍）
   * 直接后果是「一轮练习」的落库开销从 ~77ms 掉到 ~1ms，写吞吐从个位数 req/s
   * 变成数百 req/s；反过来，FULL 会让所有请求**串行阻塞在 fsync 上**（读接口
   * 在写入并发时从 2ms 劣化到 1.5s）。
   * 若部署环境的磁盘/合规要求「断电也不丢」，设 DB_SYNC=FULL 回到旧行为。
   */
  dbSync: (() => {
    const v = String(pick('DB_SYNC', 'NORMAL')).toUpperCase();
    return ['NORMAL', 'FULL', 'EXTRA', 'OFF'].indexOf(v) >= 0 ? v : 'NORMAL';
  })(),

  /** 跨域策略：默认只放行本机来源与同源，不再使用 * */
  cors: {
    /** 额外允许的来源（完整 origin，如 http://10.0.0.7:8080） */
    origins: list('CORS_ORIGINS', ''),
    /** 是否放行本机来源（127.0.0.1 / localhost / ::1 任意端口） */
    allowLocal: pick('CORS_ALLOW_LOCAL', 'true') !== 'false',
    /** 是否放行 file:// 打开的页面（Origin: null） */
    allowFile: pick('CORS_ALLOW_FILE', 'true') !== 'false'
  },

  /** 鉴权 */
  auth: {
    /** open = 演示便利（默认）；enforce = 强制登录，管理类接口一律要求 token */
    mode: String(pick('AUTH_MODE', 'open')).toLowerCase() === 'enforce' ? 'enforce' : 'open',
    /** 固定签名密钥（不配置则首次启动在库里生成并持久化） */
    secret: pick('AUTH_SECRET', ''),
    /** token 有效期（小时） */
    ttlHours: Number(pick('AUTH_TTL_HOURS', 12))
  },

  /** LLM 通道 */
  llm: {
    /** 未配置 apiKey 时自动进入 mock 模式（用本地模拟实现，契约一致） */
    apiKey: pick('LLM_API_KEY', ''),
    baseUrl: pick('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
    model: pick('LLM_MODEL', 'deepseek-chat'),
    /** 单次请求超时（毫秒） */
    timeoutMs: Number(pick('LLM_TIMEOUT_MS', 30000)),
    /** 温度：NPC 对话偏发散，评分偏稳定 */
    tempNpc: Number(pick('LLM_TEMP_NPC', 0.85)),
    tempScore: Number(pick('LLM_TEMP_SCORE', 0.2)),
    /** 单轮最大重试次数 */
    maxRetry: Number(pick('LLM_MAX_RETRY', 1)),
    /** 评分置信度低于此值时标记转人工 */
    lowConfidence: Number(pick('LLM_LOW_CONFIDENCE', 0.6))
  },

  /** 当前 Rubric 版本（评分口径可追溯） */
  rubricVersion: pick('RUBRIC_VERSION', 'rubric-v1'),

  /** 是否允许在无 Key 时降级（true = 降级到关键词引擎，练习不中断） */
  allowFallback: pick('ALLOW_FALLBACK', 'true') !== 'false'
};

config.llm.enabled = !!config.llm.apiKey;

module.exports = config;
