#!/usr/bin/env node
'use strict';
/**
 * 服务端端到端自测（零依赖，用原生 fetch 打自己的 HTTP 接口）
 *
 *   node server/tools/selftest.js            # 需先把服务跑起来（默认 8848）
 *   PORT=8899 node server/tools/selftest.js
 *
 * 覆盖：鉴权（登录 / token / 越权 403 / 提交人≠审核人）、场景版本与审批流、
 *       回滚、学员端已发布场景池（匿名可读 + 发布闸门 + 字段最小化）、
 *       逐轮对话（P7：返回体与逐轮接口**字段集完全一致**、列表**不带正文**只带 turnCount、
 *       逐轮均分与成绩单总分**精确一致**、无归属记录 403）、
 *       金标校准、备份、CORS 白名单、练习通道匿名可用、enforce 模式拦截。
 *
 * 会在服务端新建一个临时场景并在结束时删除，不会污染演示场景（s1/s2/s3）。
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PORT || 8848);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ENFORCE_PORT = Number(process.env.ENFORCE_PORT || 8899);

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) { ok(name + '（期望 ' + want + '，实际 ' + got + '）', got === want); }

async function call(method, p, body, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.origin) headers.Origin = opts.origin;
  const res = await fetch(BASE + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body: json, headers: res.headers };
}
const data = (r) => (r.body && r.body.ok ? r.body.data : null);
const errText = (r) => (r.body && r.body.error) || ('HTTP ' + r.status);

async function login(account, password) {
  const r = await call('POST', '/auth/login', { account, password });
  return data(r);
}

(async function main() {
  console.log('');
  console.log('  服务端自测 · ' + BASE);
  console.log('  ─────────────────────────────────────────');

  /* ---- 0. 探活 ---- */
  const st = await call('GET', '/status');
  ok('/status 公开可访问', st.status === 200 && data(st) && data(st).ok === true);
  ok('/status 回报鉴权模式', !!(data(st) && data(st).auth && data(st).auth.mode), JSON.stringify(data(st) && data(st).auth));
  const mode = data(st) && data(st).auth ? data(st).auth.mode : '?';

  /* ---- 0b. 落盘级别（性能塌陷属于「功能正常、只有性能坏掉」，必须用断言看住）---- */
  // 背景：SQLite 出厂默认 synchronous=FULL，WAL 下**每次提交都 fsync**。
  // 本机实测单条写入 FULL 43.96ms / NORMAL 0.06ms（约 700 倍），且 fsync 阻塞事件循环——
  // 一旦被改回 FULL，所有功能与全部其它断言照样全绿，只有写吞吐从数百 req/s 掉到个位数。
  const pgm = data(st) && data(st).dbSync;
  ok('/status 回报落盘级别（journal + synchronous 真值）', !!(pgm && pgm.journalMode && pgm.synchronous !== null && pgm.synchronous !== undefined), JSON.stringify(pgm));
  eq('journal_mode = WAL', String(pgm && pgm.journalMode).toLowerCase(), 'wal');
  ok('synchronous 未退回 SQLite 出厂默认 FULL', pgm && pgm.synchronous !== 2,
    '当前 synchronous=' + (pgm && pgm.synchronousName) + '（0=OFF/1=NORMAL/2=FULL/3=EXTRA）；设为 2 会让每次提交 fsync，写吞吐掉到个位数');
  eq('synchronous 与配置一致', pgm && pgm.synchronousName, pgm && pgm.configured);
  eq('外键约束已开启', pgm && pgm.foreignKeys, true);

  /* ---- 1. 登录 ---- */
  const bad = await call('POST', '/auth/login', { account: 'wangqian', password: 'definitely-wrong' });
  eq('错误口令被拒', bad.status, 401);
  const miss = await call('POST', '/auth/login', { account: 'wangqian' });
  eq('缺字段被拒', miss.status, 400);

  const op = await login('wangqian', 'op123456');            // 培训运营（可编辑）
  const rv = await login('zhangtao', 'rev123456');           // 带教主管（可审核）
  const cch = await login('chenxi', 'coach123');             // 教练（无编辑无审核）
  const adm = await login('admin', 'admin123');              // 管理员
  const cch2 = await login('zhoumin', 'coach123');           // P4 新增：带教范围教练
  ok('运营账号登录成功', !!op && !!op.token && op.user.id === 'U-OP01');
  ok('审核账号登录成功', !!rv && rv.user.id === 'U-REV01');
  ok('教练账号登录成功', !!cch && cch.user.id === 'U-COACH1');
  ok('P4 新增带教账号可登录（周敏 / mentor 范围）', !!cch2 && cch2.user.id === 'U-COACH2' && cch2.user.scope === 'mentor');
  ok('登录响应不含口令哈希', !!op && !('password_hash' in op.user) && !('salt' in op.user));
  ok('登录响应带数据范围说明', !!op && !!op.user.scopeLabel);

  const tampered = op.token.slice(0, -3) + 'aaa';
  const badTok = await call('GET', '/auth/me', undefined, { token: tampered });
  eq('被篡改 token 被拒', badTok.status, 401);

  const me = await call('GET', '/auth/me', undefined, { token: op.token });
  eq('/auth/me 返回正确身份', data(me) && data(me).user.id, 'U-OP01');
  eq('/auth/me 身份来源为 token', data(me) && data(me).source, 'token');

  /* ---- 1b. 开跑前清场 ----
   * 自测的清理段在**结尾**，中途抛错就永远跑不到。于是上一次中断会把
   * 临时场景 / 临时任务 / R-selfcheck-* 成绩永久留在库里（实测攒过
   * SC09 + 1 条任务 + 9 条成绩），下次跑的人还以为是自己弄脏的。
   * 所以开工前先把自己上次的残渣扫掉 —— 只认自测专用的特征，不碰演示数据。
   */
  const swept = { scenes: 0, tasks: 0, records: 0, notes: 0 };
  const sAll = await call('GET', '/scenes', undefined, { token: adm.token });
  for (const s of ((data(sAll) && data(sAll).items) || [])) {
    if (!/^自测临时场景/.test(s.name || '') && !/^SC-SC/.test(s.code || '')) continue;
    const rm = await call('DELETE', '/scenes/' + encodeURIComponent(s.id), undefined, { token: adm.token });
    if (rm.status === 200) swept.scenes++;
  }
  const tAll = await call('GET', '/tasks', undefined, { token: adm.token });
  for (const t of ((data(tAll) && data(tAll).items) || [])) {
    if (t.title !== '自测下发任务' && !/^TN\d+$/.test(t.id || '')) continue;
    const rm = await call('DELETE', '/tasks/' + encodeURIComponent(t.id), undefined, { token: adm.token });
    if (rm.status === 200) swept.tasks++;
  }
  const rAll = await call('GET', '/records', undefined, { token: adm.token });
  for (const r of ((data(rAll) && data(rAll).items) || [])) {
    if (!/^R-selfcheck/.test(r.id || '')) continue;
    const rm = await call('DELETE', '/records/' + encodeURIComponent(r.id), undefined, { token: adm.token });
    if (rm.status === 200) swept.records++;
  }
  // 辅导记录：中断点正好落在「写完临时记录、还没删」之间时留下的
  const nAll = await call('GET', '/coach-notes', undefined, { token: adm.token });
  for (const n of ((data(nAll) && data(nAll).items) || [])) {
    if (!/^自测临时辅导记录/.test(n.text || '')) continue;
    const rm = await call('DELETE', '/coach-notes/' + encodeURIComponent(n.id), undefined, { token: adm.token });
    if (rm.status === 200) swept.notes++;
  }
  if (swept.scenes || swept.tasks || swept.records || swept.notes) {
    console.log(`  · 已清扫上次残留：场景 ${swept.scenes} / 任务 ${swept.tasks} / 成绩 ${swept.records} / 辅导记录 ${swept.notes}`);
  }

  /* ---- 2. 越权 ---- */
  const sceneDraft = {
    name: '自测临时场景', subtitle: '自动化测试创建，结束后会删除',
    avatarText: '测', color: '#5B9DF9', taskName: '自测', channel: '微信文字',
    category: '破冰挖掘', difficulty: '入门', passLine: 60, duration: 8,
    brief: '这是服务端自测创建的临时场景，用于验证权限与审批流。',
    objectives: [{ text: '验证权限拦截', dim: 'd1' }],
    script: [{ t: '你好，有什么事？', v: 5 }],
    tips: ['测试'], voicePool: [['测试语音']]
  };
  const denyEdit = await call('POST', '/scenes', sceneDraft, { token: cch.token });
  eq('教练创建场景被拒（403）', denyEdit.status, 403);

  const noTok = await call('POST', '/scenes', sceneDraft);
  if (mode === 'enforce') eq('enforce 模式无 token 被拒', noTok.status, 401);
  else ok('open 模式无 token 回落演示身份（' + noTok.status + '）', noTok.status === 200 || noTok.status === 400);
  if (noTok.status === 200 && data(noTok)) { await call('DELETE', '/scenes/' + data(noTok).id, undefined, { token: adm.token }); }

  /* ---- 3. 场景新建 + 版本 + 审批流 ---- */
  const created = await call('POST', '/scenes', sceneDraft, { token: op.token });
  ok('运营创建场景成功', created.status === 200 && !!data(created), errText(created));
  const sid = data(created) ? data(created).id : null;
  if (!sid) { finish(); return; }
  eq('新建场景为草稿', data(created).publish, 'draft');
  eq('新建场景版本数为 1', data(created).versions, 1);

  const badScene = await call('POST', '/scenes', { id: 'SCXX', name: '' }, { token: op.token });
  eq('非法场景被拒（400）', badScene.status, 400);

  // 提交审核
  const sub = await call('POST', `/scenes/${sid}/submit`, {}, { token: op.token });
  eq('运营提交审核成功', sub.status, 200);
  eq('提交后状态为 review', data(sub) && data(sub).audit.status, 'review');

  // 提交人自己审批 → 403（角色分离）
  const selfApprove = await call('POST', `/scenes/${sid}/approve`, {}, { token: op.token });
  eq('提交人不能自审（403）', selfApprove.status, 403);

  // 教练审批 → 403（无审核权）
  const coachApprove = await call('POST', `/scenes/${sid}/approve`, {}, { token: cch.token });
  eq('教练审批被拒（403）', coachApprove.status, 403);

  // 带教主管审批 → 通过
  const appr = await call('POST', `/scenes/${sid}/approve`, {}, { token: rv.token });
  eq('带教主管审批通过', appr.status, 200);
  eq('审批后状态为 published', data(appr) && data(appr).audit.status, 'published');
  eq('审批人记录正确', data(appr) && data(appr).audit.reviewBy, '带教主管 · 张涛');

  // 可下发判定
  const assignable = await call('GET', '/scenes?assignable=1', undefined, { token: op.token });
  const ids = (data(assignable) && data(assignable).items || []).map((s) => s.id);
  ok('已发布场景出现在可下发列表', ids.indexOf(sid) !== -1);

  /* ---- 3b. 学员端场景池（P6）：匿名可读 + 只含已发布 + 字段最小化 ----
     学员端必须能在**不登录**的情况下拿到运营刚发布的场景，
     否则「下发 → 学员练」对新场景是断的（场景库永远停在页面加载时的种子）。 */
  const pool = await call('GET', '/scenes/published');          // 刻意不带 token
  ok('匿名可读已发布场景池（' + pool.status + '）', pool.status === 200 && !!data(pool), errText(pool));
  const poolItems = (data(pool) && data(pool).items) || [];
  const poolIds = poolItems.map((s) => s.id);
  ok('刚审批发布的场景立刻出现在学员端场景池', poolIds.indexOf(sid) !== -1);
  ok('场景池为全量已发布集合（与 assignable 一致）',
    poolIds.slice().sort().join(',') === ids.slice().sort().join(','),
    '池 ' + poolIds.length + ' 个 / 可下发 ' + ids.length + ' 个');
  ok('场景池非空（含 3 个种子场景）', poolItems.length >= 3, '实际 ' + poolItems.length + ' 个');
  // 匿名端点绝不能泄漏治理字段
  const LEAK = ['audit', 'versions', 'owner', 'publish', 'status', 'updatedAt', 'brief'];
  const leaked = [];
  poolItems.forEach((s) => LEAK.forEach((k) => { if (s[k] !== undefined) leaked.push(s.id + '.' + k); }));
  ok('匿名端点不泄漏治理字段（' + (leaked.join(',') || '无泄漏') + '）', leaked.length === 0);
  // 但学员端判分/渲染要用的字段必须齐
  const NEED = ['id', 'name', 'passLine', 'script', 'tips', 'objectives', 'voicePool'];
  const missing = [];
  poolItems.forEach((s) => NEED.forEach((k) => { if (s[k] === undefined) missing.push(s.id + '.' + k); }));
  ok('场景池字段齐全，学员端可直接判分（缺：' + (missing.join(',') || '无') + '）', missing.length === 0);

  // 改动已发布场景 → 自动回 review，并归档新版本
  const edited = await call('POST', '/scenes', Object.assign({}, sceneDraft, { id: sid, name: '自测临时场景（已改）' }), { token: op.token });
  eq('改动已发布场景后自动回待审', data(edited) && data(edited).audit.status, 'review');
  eq('版本号递增到 2', data(edited) && data(edited).versions, 2);

  // 回滚到 v1
  const rb = await call('POST', `/scenes/${sid}/rollback`, { v: 1 }, { token: op.token });
  eq('回滚成功', rb.status, 200);
  eq('回滚后为草稿', data(rb) && data(rb).audit.status, 'draft');
  eq('回滚保留原 id', data(rb) && data(rb).id, sid);

  // 同一个场景从 published 退回 draft 后，必须立刻从学员端场景池消失（发布闸门在服务端收口）
  const pool2 = await call('GET', '/scenes/published');
  const poolIds2 = ((data(pool2) && data(pool2).items) || []).map((s) => s.id);
  ok('退回草稿后不再出现在学员端场景池', poolIds2.indexOf(sid) === -1 && poolIds2.length === poolIds.length - 1,
    '池 ' + poolIds2.length + ' 个（取池时 ' + poolIds.length + ' 个，其中含临时场景）');

  // 版本列表
  const vers = await call('GET', `/scenes/${sid}/versions`, undefined, { token: op.token });
  ok('版本列表可读且有记录', (data(vers) && data(vers).items || []).length >= 3);

  /* ---- 4. 练习通道匿名可用（学员端必须没登录也能练） ---- */
  const sid2 = 'selfcheck-' + Date.now();
  const turn = await call('POST', `/session/${sid2}/turn`, {
    learnerId: 'L01', sceneId: 's1',
    learnerText: '王总您好，我是XX食品的小李，想跟您聊两分钟门店动销，方便吗？'
  });
  ok('练习通道匿名可打分（' + turn.status + '）', turn.status === 200 && !!data(turn), errText(turn));
  ok('返回体含 source / dimScores / customerReply',
    !!(data(turn) && data(turn).source && data(turn).dimScores && data(turn).customerReply));
  const fin = await call('POST', `/session/${sid2}/finish`, {});
  ok('练习通道匿名可结束并落库', fin.status === 200 && !!data(fin) && typeof data(fin).score === 'number');
  const anonRecId = data(fin) && data(fin).recordId;

  /* ---- 4b. P7：逐轮对话（单一形状 + 按需读取 + 口径精确一致） ----
   * 这一段存在的理由：逐轮对话此前**只写不读** —— session_turns 有写入口，
   * 却既没有读接口，也没有任何页面渲染它。教练台的「逐轮复盘」整块是拿
   * 场景剧本拼的，"学员当时答了什么"一个字都没有，而那个界面叫「对话质检」。 */
  console.log('  ─────────────────────────────────────────');
  console.log('  P7：逐轮对话');

  const finTurns = (data(fin) && data(fin).turns) || [];
  ok('finish 返回逐轮明细（' + finTurns.length + ' 轮）', finTurns.length === 1);

  const recTurns = await call('GET', '/records/' + encodeURIComponent(anonRecId) + '/turns', undefined, { token: adm.token });
  const rt = data(recTurns) || {};
  ok('逐轮对话接口可读（' + recTurns.status + '）', recTurns.status === 200 && Array.isArray(rt.turns), errText(recTurns));

  // 铁律 8：同一份数据在「finish 返回 / 落库 evidence / 逐轮接口」三处必须
  // 是**同一个字段集**。P7 之前是两种形状（{turn,learner,customer,score} 与
  // {idx,learnerText,customerReply,...}），按后者写的前端拿前者会静默读出 undefined。
  const keysOf = (o) => Object.keys(o || {}).sort().join(',');
  ok('finish 返回与逐轮接口字段集完全一致',
    !!rt.turns && rt.turns.length > 0 && keysOf(finTurns[0]) === keysOf(rt.turns[0]),
    keysOf(finTurns[0]) + ' vs ' + keysOf(rt.turns && rt.turns[0]));
  // 注意必须断言**5 个维度都在**：只断言 typeof dimScores === 'object' 是假绿 ——
  // 旧的 4 字段 evidence 经 evidenceTurn() 归一化后同样给出一个对象（只是空的）。
  ok('逐轮对象含完整五维明细（evidence 不能是 4 字段简写）',
    !!(rt.turns && rt.turns[0]) && Object.keys(rt.turns[0].dimScores || {}).length === 5 &&
    rt.turns[0].learnerText !== undefined && rt.turns[0].customerReply !== undefined &&
    rt.turns[0].emotion !== undefined);
  ok('逐轮接口带 learnerId / sceneId / score 上下文',
    rt.learnerId === 'L01' && !!rt.sceneId && typeof rt.score === 'number',
    JSON.stringify({ l: rt.learnerId, s: rt.sceneId, sc: rt.score }));

  // 列表接口给列表用的字段，不该背对话正文（28 条 × 5~6 轮 ≈ 150 段文本）
  const listNow = (data(await call('GET', '/records', undefined, { token: adm.token })) || {}).items || [];
  const leakRows = listNow.filter((r) => r.evidence !== undefined).map((r) => r.id);
  ok('成绩列表不再返回 evidence 正文（泄漏：' + (leakRows.join(',') || '无') + '）', leakRows.length === 0);
  ok('成绩列表改为返回 turnCount（页面据此决定是否给「看对话」入口）',
    listNow.length > 0 && listNow.every((r) => typeof r.turnCount === 'number'));

  const withTurns = listNow.filter((r) => r.turnCount > 0);
  ok('演示成绩已播种逐轮对话（' + withTurns.length + '/' + listNow.length + ' 条）',
    withTurns.length >= 25, '仅 ' + withTurns.length + ' 条');

  // 口径精确一致：逐轮均分必须等于成绩单总分，每维逐轮均分必须等于该维得分。
  // 否则教练台把两者并排显示时会出现「逐轮均分 72 / 总分 58」这种自相矛盾。
  // 样本优先取**种子记录**（db.js 播种的固定基线）：早先按「列表第一条」取，
  // 用户真实练习记录（at 更近、话术是长句）会顶替样本，让下面这条**内容**断言漂移变红
  // （P11 全流程巡检实测：跑完两轮真机练习后此断言变红）。
  const tgt = withTurns.filter((r) => r.source === 'seed' && r.turnCount >= 5)[0]
    || withTurns.filter((r) => r.turnCount >= 5)[0];
  const tgtResp = data(await call('GET', '/records/' + encodeURIComponent(tgt.id) + '/turns', undefined, { token: adm.token }));
  const tts = (tgtResp && tgtResp.turns) || [];
  const tMean = tts.length ? Math.round(tts.reduce((a, t) => a + t.score, 0) / tts.length) : -1;
  ok('逐轮均分 === 成绩单总分（' + tMean + ' vs ' + tgt.score + '，' + tts.length + ' 轮）', tMean === tgt.score);
  const dimBad = ['d1', 'd2', 'd3', 'd4', 'd5'].filter((d) => {
    const vs = tts.map((t) => (t.dimScores || {})[d]);
    if (!vs.length || vs.some((v) => typeof v !== 'number')) return true;
    return Math.round(vs.reduce((a, b) => a + b, 0) / vs.length) !== tgt.dimScores[d];
  });
  ok('每一维的逐轮均分 === 成绩单维度分（不符：' + (dimBad.join(',') || '无') + '）', dimBad.length === 0);
  ok('逐轮条数 === 成绩单轮次字段（' + tts.length + ' vs ' + tgt.turns + '）',
    tts.length === tgt.turns && tgt.turns > 0);
  ok('逐轮顺序 idx 从 1 连续递增',
    tts.every((t, i) => t.idx === i + 1));
  ok('弱轮次有可复盘的"敷衍话术"（教练能指着说这一轮没接话）（样本 ' + tgt.id + '）',
    tts.some((t) => t.score < tgt.score && t.learnerText.length <= 16),
    '弱轮 ' + tts.filter((t) => t.score < tgt.score).length + ' 个');

  // 权限：404（不存在） / 403（越范围）
  eq('不存在成绩的逐轮明细（404）',
    (await call('GET', '/records/R-NO-SUCH-AT-ALL/turns', undefined, { token: adm.token })).status, 404);
  const coVisible = (data(await call('GET', '/records', undefined, { token: cch.token })) || {}).items || [];
  const coachVisibleIds = coVisible.map((r) => r.id);
  const outside = listNow.filter((r) => coachVisibleIds.indexOf(r.id) < 0)[0];
  if (outside) {
    eq('越范围读逐轮明细被拒（403）',
      (await call('GET', '/records/' + encodeURIComponent(outside.id) + '/turns', undefined, { token: cch.token })).status, 403);
  } else {
    ok('越范围读逐轮明细被拒（403）', false, '教练可见全部记录，无法构造越范围样本');
  }

  /* ---- 4c. P8：自主练习（free）来源可见 ----
   * 这一段存在的理由：自由练习（无任务归属）的成绩此前在管理端显示**空白**任务名、
   * 教练台只写「练习」，主管无法区分「任务考核」与「学员自主学习」。
   * 上面 4 段的匿名会话（sid2）不带 taskId，它落的成绩就是一条现成的 free 记录。 */
  console.log('  ─────────────────────────────────────────');
  console.log('  P8：自主练习来源');
  {
    const recAll2 = (data(await call('GET', '/records', undefined, { token: adm.token })) || {}).items || [];
    const anonRec = recAll2.filter((r) => r.id === anonRecId)[0];
    ok('自由练习成绩带 mode=free 且 taskId 为空',
      !!anonRec && anonRec.mode === 'free' && (anonRec.taskId || '') === '',
      anonRec ? ('mode=' + anonRec.mode + ' taskId=' + JSON.stringify(anonRec.taskId)) : '成绩不存在');
    ok('成绩列表每条都带 mode（task|free）',
      recAll2.length > 0 && recAll2.every((r) => r.mode === 'task' || r.mode === 'free'));
    const freeList = (data(await call('GET', '/records?mode=free', undefined, { token: adm.token })) || {}).items || [];
    const taskList = (data(await call('GET', '/records?mode=task', undefined, { token: adm.token })) || {}).items || [];
    ok('?mode=free 筛出的全部是 free 且含刚练的一条',
      freeList.length > 0 && freeList.every((r) => r.mode === 'free') && freeList.some((r) => r.id === anonRecId));
    ok('?mode=task 筛出的全部是 task 且不含 free',
      taskList.length > 0 && taskList.every((r) => r.mode === 'task') && !taskList.some((r) => r.id === anonRecId));
    ok('free + task 两类合计 === 全量（不重不漏）',
      freeList.length + taskList.length === recAll2.length,
      freeList.length + ' + ' + taskList.length + ' vs ' + recAll2.length);
    const l01free = (data(await call('GET', '/records?learnerId=L01&mode=free', undefined, { token: adm.token })) || {}).items || [];
    ok('learnerId 与 mode 筛选可组合（教练按学员看自主练习）',
      l01free.some((r) => r.id === anonRecId) && l01free.every((r) => r.mode === 'free' && r.learnerId === 'L01'));
  }

  /* ---- 4d. P9：列表分页统一口径 + 辅导记录检索 ----
   * 这一段存在的理由：列表接口（records/learners/tasks/coach-notes）一次返回全量，
   * 数据量大时会拖垮调用方；audit 老实现还是「先 LIMIT 再 JS 过滤」，带范围的账号
   * 看到的行数比 limit 还少且没有 total —— 分页语义是错的。 */
  console.log('  ─────────────────────────────────────────');
  console.log('  P9：列表分页与检索');
  {
    // 向后兼容：无参必须仍是全量，且形状统一（items/total/limit/offset/hasMore 五件套）
    const all9 = data(await call('GET', '/records', undefined, { token: adm.token })) || {};
    ok('records 无参仍回全量（三端水合依赖，向后兼容）',
      (all9.items || []).length === all9.total && all9.hasMore === false,
      (all9.items || []).length + '/' + all9.total);
    // 翻页不重不漏 + meta 正确（稳定排序：at 相同按 id 定序）
    const p9a = data(await call('GET', '/records?limit=10&offset=0', undefined, { token: adm.token })) || {};
    const p9b = data(await call('GET', '/records?limit=10&offset=10', undefined, { token: adm.token })) || {};
    const ids9 = (x) => (x.items || []).map((r) => r.id);
    const i9a = ids9(p9a), i9b = ids9(p9b), i9all = ids9(all9);
    ok('翻页两页行数正确（10/' + Math.min(10, all9.total - 10) + '）',
      i9a.length === 10 && i9b.length === Math.min(10, all9.total - 10));
    ok('翻页两页无重叠且都在全量里（稳定排序）',
      i9a.length > 0 && i9a.every((x) => i9b.indexOf(x) < 0) && i9a.concat(i9b).every((x) => i9all.indexOf(x) >= 0));
    ok('翻页 meta 正确（total===全量、首页 hasMore）',
      p9a.total === all9.total && p9a.hasMore === true && p9a.limit === 10 && p9a.offset === 0);
    // 分页与筛选组合：total 是「筛选后」的总数，不因分页而变
    const l01a = data(await call('GET', '/records?learnerId=L01', undefined, { token: adm.token })) || {};
    const l01p = data(await call('GET', '/records?learnerId=L01&limit=1', undefined, { token: adm.token })) || {};
    ok('分页与 learnerId 筛选可组合（total 不因分页变）',
      l01p.total === l01a.total && (l01p.items || []).length === 1);
    // 非法分页参数一律 400（宁拒不猜：防 limit=0 / 负数 / 小数 / 巨值把库拖垮）
    for (const bad9 of ['limit=0', 'limit=501', 'limit=abc', 'offset=-1', 'limit=2.5']) {
      eq('非法分页参数被拒 400（' + bad9 + '）',
        (await call('GET', '/records?' + bad9, undefined, { token: adm.token })).status, 400);
    }
    // 其它列表接口同口径
    const lr9 = data(await call('GET', '/learners?limit=2', undefined, { token: adm.token })) || {};
    ok('learners 分页同口径', (lr9.items || []).length === 2 && lr9.total > 2 && lr9.hasMore === true,
      (lr9.items || []).length + '/' + lr9.total);
    const tk9 = data(await call('GET', '/tasks?limit=2', undefined, { token: adm.token })) || {};
    ok('tasks 分页同口径（staff 视角）', (tk9.items || []).length === 2 && tk9.hasMore === true);
    const tkl9 = data(await call('GET', '/tasks?learnerId=L01&limit=1', undefined)) || {};
    ok('学员端任务分页同口径（匿名）', (tkl9.items || []).length === 1 && tkl9.total === 2 && tkl9.hasMore === true,
      (tkl9.items || []).length + '/' + tkl9.total);
    // 辅导记录检索：演示种子「价格异议」必命中；LIKE 通配符必须转义
    const nHit = data(await call('GET', '/coach-notes?q=' + encodeURIComponent('价格异议'), undefined, { token: adm.token })) || {};
    ok('辅导记录按关键字命中且只含命中行',
      (nHit.items || []).length >= 1 && nHit.items.every((n) => (n.text || '').indexOf('价格异议') >= 0));
    const nMiss = data(await call('GET', '/coach-notes?q=' + encodeURIComponent('绝不存在的检索串'), undefined, { token: adm.token })) || {};
    ok('检索不命中返回空（而非全表）', (nMiss.items || []).length === 0 && nMiss.total === 0);
    const nPct = data(await call('GET', '/coach-notes?q=%25', undefined, { token: adm.token })) || {};
    ok('检索的 % 被转义（按字面匹配，非全表）', (nPct.items || []).length === 0, '命中 ' + (nPct.items || []).length);
    const nUnd = data(await call('GET', '/coach-notes?q=_', undefined, { token: adm.token })) || {};
    ok('检索的 _ 被转义（按字面匹配，非全表）', (nUnd.items || []).length === 0, '命中 ' + (nUnd.items || []).length);
    // audit：默认 100 条 + total + 翻页无重叠
    const au1 = data(await call('GET', '/audit', undefined, { token: adm.token })) || {};
    ok('审计默认最多 100 条且 total/hasMore 如实',
      (au1.items || []).length <= 100 && au1.total >= (au1.items || []).length &&
      au1.hasMore === ((au1.items || []).length < au1.total),
      (au1.items || []).length + '/' + au1.total);
    const au2 = data(await call('GET', '/audit?limit=50&offset=100', undefined, { token: adm.token })) || {};
    const a1 = (au1.items || []).map((x) => x.id), a2 = (au2.items || []).map((x) => x.id);
    ok('审计翻页与首页无重叠（offset=100 起的第二页）',
      a1.length > 0 && a2.length > 0 && a2.every((x) => a1.indexOf(x) < 0));
    // 老实现的坑：先 LIMIT 再 JS 过滤 → 带范围账号看到少于 limit 的行且 total 语义缺失。
    // SQL 化修正后：条数 === total，且范围（dept）账号的 total 不超过全量。
    const auc = data(await call('GET', '/audit?limit=500', undefined, { token: cch.token })) || {};
    ok('审计按范围过滤后条数 === total（SQL 化修正）',
      (auc.items || []).length === auc.total && auc.total <= au1.total,
      (auc.items || []).length + '/' + auc.total + ' vs 全量 ' + au1.total);
    ok('范围账号的审计只含本部门与自己', (auc.items || []).length === 0 ||
      auc.items.every((x) => ['U-COACH1', 'U-COACH3', 'U-REV01'].indexOf(x.userId) >= 0));
  }

  /* ---- 4e. P11：本地语音识别（FunASR · SenseVoiceSmall） ----
   * 两条硬断言（任何时候都跑）：/status 如实报 voice 状态；ASR 服务不可达时
   * /asr 一律 503（绝不把「没起」伪装成「识别为空」）。
   * 一条在线断言：ASR 在线时用项目自带的测试音频走真实识别。
   * ASR 未启动时该断言显式 SKIP（打印 ⚠，不是静默）——语音是增强能力，
   * 不强求每个自测环境都起 Python 服务。 */
  console.log('  ─────────────────────────────────────────');
  console.log('  P11：本地语音识别');
  {
    const st11 = data(await call('GET', '/status'));
    ok('/status 如实报告语音通道（voice.asrOnline 为布尔）',
      st11 && typeof st11.voice.asrOnline === 'boolean' && !!st11.voice.asrBase);
    if (st11 && st11.voice.asrOnline) {
      const fs11 = require('fs');
      const path11 = require('path');
      const wavPath = path.join(__dirname, '..', '..', 'voice', 'asr_example_zh.wav');
      if (fs11.existsSync(wavPath)) {
        const buf11 = fs11.readFileSync(wavPath);
        const r11 = await fetch('http://127.0.0.1:' + (process.env.PORT || '8848') + '/api/v1/asr', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: buf11
        });
        const j11 = await r11.json();
        ok('语音识别真实往返（含「达摩院」）',
          r11.status === 200 && j11 && j11.ok && (j11.data.text || '').indexOf('达摩院') >= 0,
          'HTTP ' + r11.status + ' → ' + (j11 && j11.data && j11.data.text));
        ok('识别返回带耗时', j11 && j11.ok && typeof j11.data.inferMs === 'number');
      } else {
        console.log('      ⚠ 缺少 voice/asr_example_zh.wav，在线识别断言跳过');
      }
    } else {
      console.log('      ⚠ ASR 服务未启动（voice/asr-server.py），在线识别断言跳过');
    }
    // ASR 不可达必须如实 503：起一个 ASR_BASE 指向黑洞的独立实例
    {
      const { spawn } = require('child_process');
      const p11 = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
        env: Object.assign({}, process.env, {
          PORT: '8853', HOST: '127.0.0.1', ASR_BASE: 'http://127.0.0.1:9'
        }),
        stdio: ['ignore', 'ignore', 'pipe']
      });
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r11 = await fetch('http://127.0.0.1:8853/api/v1/asr', {
          method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.from('RIFF-fake')
        });
        const j11 = await r11.json();
        eq('ASR 服务不可达时 /asr 如实 503（不伪装成识别为空）', r11.status, 503);
        ok('503 的错误信息指向语音服务（' + ((j11 && j11.error) || '').slice(0, 24) + '…）',
          !!(j11 && j11.error && j11.error.indexOf('语音') >= 0));
        const s11 = await (await fetch('http://127.0.0.1:8853/api/v1/status')).json();
        ok('黑洞实例的 /status 如实报 asrOnline=false',
          s11 && s11.data && s11.data.voice && s11.data.voice.asrOnline === false);
      } finally {
        p11.kill();
      }
    }
    // 空音频 → 400（有 ASR 也要拒空体，参数校验不依赖后端服务）
    const rEmpty = await fetch('http://127.0.0.1:' + (process.env.PORT || '8848') + '/api/v1/asr', {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(0)
    });
    eq('空音频被拒 400', rEmpty.status, 400);
  }

  /* ---- 5. 金标校准 ---- */
  const calib = await call('POST', '/goldset/calibrate', { mode: 'auto' }, { token: adm.token });
  const cd = data(calib);
  ok('金标校准可跑通', calib.status === 200 && !!cd, errText(calib));
  if (cd) {
    console.log('      通道=' + cd.channel + ' 样本=' + cd.n +
      ' Pearson=' + cd.pearson + ' MAE=' + cd.mae + ' meaningful=' + cd.meaningful);
  }
  /* P10：金标集扩容到 30 条后的口径断言（分数不设阈值——mock 通道的指标值不背书，
   * 只锁「样本量、覆盖面、逐条打上分、无失败样本」这些结构性事实）。 */
  {
    const goldList = (data(await call('GET', '/goldset', undefined, { token: adm.token })) || {}).items || [];
    ok('金标集 30 条（P10 扩容后）', goldList.length >= 30, '实际 ' + goldList.length + ' 条');
    const byScene = {};
    goldList.forEach((g) => { byScene[g.sceneId] = (byScene[g.sceneId] || 0) + 1; });
    ok('金标覆盖全部三个场景', ['s1', 's2', 's3'].every((s) => (byScene[s] || 0) >= 2),
      JSON.stringify(byScene));
    const badDim = goldList.filter((g) => !g.humanScores || Object.keys(g.humanScores).length !== 5).map((g) => g.id);
    ok('每条金标都带五维人工分（缺失：' + (badDim.join(',') || '无') + '）', badDim.length === 0);
    ok('校准样本数 === 金标条数（全量过模型，无失败样本）', !!cd && cd.n === goldList.length,
      '校准 ' + (cd && cd.n) + ' vs 金标 ' + goldList.length);
  }

  /* ---- 6. 备份 ---- */
  const bk = await call('POST', '/admin/backup', {}, { token: adm.token });
  ok('一键备份成功', bk.status === 200 && !!(data(bk) && data(bk).file), errText(bk));
  const bkl = await call('GET', '/admin/backup', undefined, { token: adm.token });
  ok('备份列表可读', !!(data(bkl) && Array.isArray(data(bkl).items)));

  /* ---- 7. 审计日志 ---- */
  const audit = await call('GET', '/audit?limit=200', undefined, { token: adm.token });
  const logs = (data(audit) && data(audit).items) || [];
  ok('审计日志已记录登录', logs.some((x) => x.action === 'auth.login' && x.userId === 'U-OP01'));
  ok('审计日志已记录场景审批', logs.some((x) => x.action === 'scene.approve' && x.userId === 'U-REV01'));
  ok('审计日志已记录备份', logs.some((x) => x.action === 'db.backup'));

  /* ---- 8. CORS 白名单 ---- */
  const evil = await call('GET', '/status', undefined, { origin: 'http://evil.example.com' });
  eq('非白名单来源被拒（403）', evil.status, 403);
  const local = await call('GET', '/status', undefined, { origin: 'http://127.0.0.1:9999' });
  ok('本机来源放行且回显 Origin', local.status === 200 && local.headers.get('access-control-allow-origin') === 'http://127.0.0.1:9999');
  const fileOrigin = await call('GET', '/status', undefined, { origin: 'null' });
  ok('file:// 页面放行', fileOrigin.status === 200);

  /* ---- 8b. P4：任务闭环（下发 → 学员接收 → 练习 → 进度推进） ---- */
  console.log('  ─────────────────────────────────────────');
  console.log('  P4：任务闭环与数据范围');

  // 学员端「我的任务」：匿名可读，且只含派给自己的、已下发的任务
  const mine6 = await call('GET', '/tasks?learnerId=L06');
  const m6 = (data(mine6) && data(mine6).items) || [];
  ok('学员端匿名可读「我的任务」（' + m6.length + ' 条）', mine6.status === 200 && m6.length > 0);
  ok('「我的任务」只含派给本人的任务',
    m6.every((t) => t.assignees.indexOf('L06') >= 0));
  ok('「我的任务」不含 draft（未下发）任务', m6.every((t) => t.status !== 'draft'));
  const mine1 = await call('GET', '/tasks?learnerId=L01');
  const m1 = (data(mine1) && data(mine1).items) || [];
  ok('不同学员的清单不同（L01=' + m1.length + ' / L06=' + m6.length + '）',
    m1.length !== m6.length || m1.map((t) => t.id).join() !== m6.map((t) => t.id).join());

  // 下发校验：不合法必须 400 且说明原因
  const tkBadScene = await call('POST', '/tasks', { title: 'x', sceneId: 'S-NOT-EXIST', assignees: ['L01'] }, { token: op.token });
  eq('下发到不存在的场景被拒（400）', tkBadScene.status, 400);
  const tkBadNone = await call('POST', '/tasks', { title: '无指派', sceneId: 's1', assignees: [] }, { token: op.token });
  eq('空指派被拒（400）', tkBadNone.status, 400);
  const tkBadLrn = await call('POST', '/tasks', { title: 'x', sceneId: 's1', assignees: ['L-NOPE'] }, { token: op.token });
  eq('指派不存在的学员被拒（400）', tkBadLrn.status, 400);

  // 正常下发
  const mk = await call('POST', '/tasks', {
    title: '自测下发任务', sceneId: 's1', passLine: 68,
    dueAt: '2026-11-01 18:00', assignees: ['L01', 'L02'], note: 'selftest'
  }, { token: op.token });
  const tk = data(mk);
  ok('任务下发成功（' + mk.status + '）', mk.status === 200 && !!tk);
  if (tk) {
    ok('指派人已落库且带上限', tk.assignees.length === 2 && tk.progress.total === 2);
    ok('任务带编码与下发人', !!tk.code && !!tk.createdBy);
  }
  const TKID = tk && tk.id;

  // 闭环关键：学员端立刻能看到新下发的任务
  const mine1b = await call('GET', '/tasks?learnerId=L01');
  ok('下发后学员端立刻可见（下发→接收闭环）',
    ((data(mine1b) && data(mine1b).items) || []).some((t) => t.id === TKID));

  // 闭环关键：学员带 taskId 练习 → 成绩归属该任务 → 任务进度推进
  const sid3 = 'selfcheck-task-' + Date.now();
  await call('POST', `/session/${sid3}/turn`, {
    taskId: TKID, learnerId: 'L01', sceneId: 's1',
    learnerText: '您好，我是XX食品的小李，想先了解一下您现在门店的动销情况，方便吗？'
  });
  const fin3 = await call('POST', `/session/${sid3}/finish`, {});
  const recId = data(fin3) && data(fin3).recordId;
  ok('学员练习结束并落库', fin3.status === 200 && !!recId);

  const recs = await call('GET', '/records?taskId=' + encodeURIComponent(TKID), undefined, { token: adm.token });
  const rl = (data(recs) && data(recs).items) || [];
  ok('成绩已归属到该任务（records?taskId 命中 ' + rl.length + ' 条）',
    rl.length === 1 && rl[0].learnerId === 'L01');
  const tkAfter = await call('GET', '/tasks/' + encodeURIComponent(TKID), undefined, { token: adm.token });
  const tka = data(tkAfter);
  ok('任务进度随练习推进（' + (tka && tka.progress.finishedCount) + '/' + (tka && tka.progress.total) + '）',
    !!tka && tka.progress.finishedCount === 1 && tka.progress.total === 2);

  // 改期 + 扩人：必须保留标题与编码
  const upd = await call('PUT', '/tasks/' + encodeURIComponent(TKID), {
    dueAt: '2026-11-05 18:00', assignees: ['L01', 'L02', 'L03']
  }, { token: op.token });
  const tku = data(upd);
  ok('改期+扩人成功且保留标题/编码',
    !!tku && tku.title === '自测下发任务' && tku.code === tk.code && tku.assignees.length === 3 && tku.dueAt === '2026-11-05 18:00',
    tku ? JSON.stringify({ title: tku.title, code: tku.code, n: tku.assignees.length, due: tku.dueAt }) : errText(upd));

  // 状态机
  const badSt = await call('POST', `/tasks/${encodeURIComponent(TKID)}/status`, { status: 'bogus' }, { token: op.token });
  eq('非法任务状态被拒（400）', badSt.status, 400);
  const finSt = await call('POST', `/tasks/${encodeURIComponent(TKID)}/status`, { status: 'draft' }, { token: op.token });
  ok('任务可收回为 draft', finSt.status === 200 && data(finSt).status === 'draft');
  const mine1c = await call('GET', '/tasks?learnerId=L01');
  ok('收回后学员端不再可见',
    !((data(mine1c) && data(mine1c).items) || []).some((t) => t.id === TKID));
  await call('POST', `/tasks/${encodeURIComponent(TKID)}/status`, { status: 'finished' }, { token: op.token });

  // 权限：教练不能下发/改状态
  const coachTk = await call('POST', '/tasks', { title: 'x', sceneId: 's1', assignees: ['L01'] }, { token: cch.token });
  eq('教练下发任务被拒（403）', coachTk.status, 403);
  const coachSt = await call('POST', `/tasks/${encodeURIComponent(TKID)}/status`, { status: 'finished' }, { token: cch.token });
  eq('教练改任务状态被拒（403）', coachSt.status, 403);

  /* ---- 8c. P4：数据范围隔离 ---- */
  const allL = await call('GET', '/learners', undefined, { token: adm.token });
  const allR = await call('GET', '/records', undefined, { token: adm.token });
  const allLr = (data(allL) && data(allL).items) || [];
  const allRr = (data(allR) && data(allR).items) || [];
  const allN = allLr.length;
  const allRn = allRr.length;

  const opT = await login('limeng', 'op123456');
  const dpL = await call('GET', '/learners', undefined, { token: opT.token });
  const dpLr = (data(dpL) && data(dpL).items) || [];
  const dpR = await call('GET', '/records', undefined, { token: opT.token });
  const dpRr = (data(dpR) && data(dpR).items) || [];
  const meOp = await call('GET', '/auth/me', undefined, { token: opT.token });
  ok('事业部账号范围=本部（' + ((data(meOp) && data(meOp).user.scopeLabel) || '?') + '）',
    !!(data(meOp) && data(meOp).user.scope === 'dept'));
  ok('事业部账号只看到本部门学员（' + dpLr.length + '/' + allN + '）',
    dpLr.length > 0 && dpLr.length < allN && dpLr.every((l) => l.dept === '连锁渠道事业部'));
  const dpIds = dpLr.map((l) => l.id);
  ok('事业部账号的成绩也被限制在部门内（' + dpRr.length + '/' + allRn + '）',
    dpRr.length > 0 && dpRr.length < allRn && dpRr.every((r) => dpIds.indexOf(r.learnerId) >= 0));
  const dpT = await call('GET', '/tasks', undefined, { token: opT.token });
  const dpTr = (data(dpT) && data(dpT).items) || [];
  ok('事业部账号的任务只含本部门学员的指派',
    dpTr.length > 0 && dpTr.every((t) => t.assignees.every((x) => dpIds.indexOf(x) >= 0)));

  const coT = await login('zhoumin', 'coach123');
  const coL = await call('GET', '/learners', undefined, { token: coT.token });
  const coLr = (data(coL) && data(coL).items) || [];
  const coIds = coLr.map((l) => l.id); // 8c-2 也要用，故定义在块外
  const meCo = await call('GET', '/auth/me', undefined, { token: coT.token });
  ok('带教账号范围=本人带教（' + ((data(meCo) && data(meCo).user.scopeLabel) || '?') + '）',
    !!(data(meCo) && data(meCo).user.scope === 'mentor'));
  ok('带教账号只看到本人带教的学员（' + coLr.length + ' 人）',
    coLr.length > 0 && coLr.length < allN && coLr.every((l) => l.coach === '周敏'));

  // 匿名 / 无身份不得读到 staff 数据（enforce 下由 8d 覆盖；open 模式回落演示身份，属预期）
  const anonRec = await call('GET', '/records');
  ok('open 模式未带 token 时回落演示身份（这是刻意保留的本地演示路径）', anonRec.status === 200);

  /* ---- 8c-2. P5：教练动作（辅导记录 / 质检结论） ---- */
  console.log('  ─────────────────────────────────────────');
  console.log('  P5：教练动作与数据范围');

  const cch3 = await login('zhaolei', 'coach123');
  ok('P5 新增带教账号可登录（赵磊 / mentor 范围）',
    !!cch3 && cch3.user.id === 'U-COACH3' && cch3.user.scope === 'mentor' && cch3.user.scopeRef === '赵磊');
  ok('身份带「干净姓名」staffName（用于匹配 learners.coach，避开带前缀的展示名）',
    !!cch3 && cch3.user.staffName === '赵磊');
  ok('教练角色确实没有场景编辑权（辅导/质检不该卡这一位）', !!coT && coT.user.canEdit === false);

  // 读：只能读范围内学员的辅导记录
  const coNotes = await call('GET', '/coach-notes', undefined, { token: coT.token });
  const coNotesR = (data(coNotes) && data(coNotes).items) || [];
  ok('带教账号可读辅导记录（' + coNotesR.length + ' 条）', coNotes.status === 200);
  ok('辅导记录只含范围内学员', coNotesR.every((n) => coIds.indexOf(n.learnerId) >= 0));

  // 写：教练可以写（不依赖 can_edit），记录人落库为干净姓名
  const addNote = await call('POST', '/coach-notes',
    { learnerId: coIds[0], text: '自测临时辅导记录（跑完删除）', type: '一对一辅导' }, { token: coT.token });
  const myNote = data(addNote);
  ok('教练可写辅导记录（本职动作，不卡 can_edit）', addNote.status === 200 && !!(myNote && myNote.id));
  eq('记录人落库为干净姓名', myNote && myNote.by, '周敏');
  const notesOne = await call('GET', '/coach-notes?learnerId=' + coIds[0], undefined, { token: coT.token });
  ok('按学员收窄能查到刚写的记录',
    ((data(notesOne) && data(notesOne).items) || []).some((n) => n.id === myNote.id));

  // 校验与越权
  const nOut = await call('POST', '/coach-notes', { learnerId: allLr.filter((l) => coIds.indexOf(l.id) < 0)[0].id, text: 'x' }, { token: coT.token });
  eq('给范围外学员写记录被拒（403）', nOut.status, 403);
  const nEmpty = await call('POST', '/coach-notes', { learnerId: coIds[0], text: '   ' }, { token: coT.token });
  eq('空辅导记录被拒（400）', nEmpty.status, 400);
  const nGhost = await call('POST', '/coach-notes', { learnerId: 'L-NOPE', text: 'x' }, { token: coT.token });
  eq('给不存在的学员写记录被拒（400）', nGhost.status, 400);

  // 质检：成绩列表必须带 qc 字段
  const coR = await call('GET', '/records', undefined, { token: coT.token });
  const coRr = (data(coR) && data(coR).items) || [];
  ok('教练可见成绩全部落在范围内（' + coRr.length + ' 条）',
    coRr.length > 0 && coRr.every((r) => coIds.indexOf(r.learnerId) >= 0));
  ok('成绩记录带 qc 字段', coRr.every((r) => typeof r.qc === 'string'));

  const qcTarget = coRr[0];
  const setQc1 = await call('POST', '/records/' + encodeURIComponent(qcTarget.id) + '/qc',
    { state: 'ok' }, { token: coT.token });
  eq('写入质检结论成功', setQc1.status, 200);
  eq('质检结论状态正确', data(setQc1) && data(setQc1).state, 'ok');
  const qcBad = await call('POST', '/records/' + encodeURIComponent(qcTarget.id) + '/qc',
    { state: 'maybe' }, { token: coT.token });
  eq('非法质检结论被拒（400）', qcBad.status, 400);
  const qcMiss = await call('POST', '/records/' + encodeURIComponent(qcTarget.id) + '/qc', {}, { token: coT.token });
  eq('缺质检状态被拒（400）', qcMiss.status, 400);
  const qcOut = await call('POST', '/records/' + encodeURIComponent(allRr.filter((r) => r.learnerId && coIds.indexOf(r.learnerId) < 0)[0].id) + '/qc',
    { state: 'ok' }, { token: coT.token });
  eq('给范围外记录做质检被拒（403）', qcOut.status, 403);
  const qcGhost = await call('POST', '/records/R-NOPE/qc', { state: 'ok' }, { token: coT.token });
  eq('给不存在的记录做质检被拒（404）', qcGhost.status, 404);

  // 无归属成绩（请求体不带 learnerId 时练习通道照常落库）对谁都不可质检。
  // 这里曾返回 400「缺少学员 id」—— 服务端自己的数据状态，被说成调用方参数错误，很误导；
  // 更隐蔽的是 inScope(user,'') 在 scope=all 时返回 true，管理员能给无主成绩打质检结论。
  //
  // 不依赖"库里恰好有没有主成绩"（那取决于先前跑过什么），直接自己造一条：
  // 学员端页面总是带 learnerId，但练习通道并不强制，脚本接入就是这种形态。
  const sidOrphan = 'selfcheck-orphan-' + Date.now();
  await call('POST', `/session/${sidOrphan}/turn`, { sceneId: 's1', learnerText: '您好，想了解一下供货政策。' });
  const finOrphan = await call('POST', `/session/${sidOrphan}/finish`, {});
  const orphanId = data(finOrphan) && data(finOrphan).recordId;
  const rOrphan = await call('GET', '/records', undefined, { token: adm.token });
  const orphanRow = ((data(rOrphan) && data(rOrphan).items) || []).filter((r) => r.id === orphanId)[0];
  ok('不传 learnerId 的练习确实产生无归属成绩（' + orphanId + '）', !!orphanRow && !orphanRow.learnerId);
  const qcOrphanCo = await call('POST', '/records/' + encodeURIComponent(orphanId) + '/qc', { state: 'ok' }, { token: coT.token });
  eq('教练给无归属成绩做质检被拒（403）', qcOrphanCo.status, 403);
  const qcOrphanAd = await call('POST', '/records/' + encodeURIComponent(orphanId) + '/qc', { state: 'ok' }, { token: adm.token });
  eq('管理员也不能给无归属成绩做质检（403）', qcOrphanAd.status, 403);
  // P7：逐轮对话走同一个 assertRecordScope，无主成绩同样对谁都不可读
  const turnsOrphanAd = await call('GET', '/records/' + encodeURIComponent(orphanId) + '/turns', undefined, { token: adm.token });
  eq('管理员也不能读无归属成绩的逐轮明细（403）', turnsOrphanAd.status, 403);
  ok('无归属成绩的逐轮报错说的是「查看逐轮对话」而不是「做质检」',
    /查看逐轮对话/.test(errText(turnsOrphanAd)), errText(turnsOrphanAd));

  const qcList = await call('GET', '/qc', undefined, { token: coT.token });
  const qcListR = (data(qcList) && data(qcList).items) || [];
  ok('质检列表只含范围内记录（' + qcListR.length + ' 条）',
    qcList.status === 200 && qcListR.every((q) => coRr.some((r) => r.id === q.recordId)));
  const coR2 = await call('GET', '/records', undefined, { token: coT.token });
  const hitRec = ((data(coR2) && data(coR2).items) || []).filter((r) => r.id === qcTarget.id)[0];
  ok('成绩列表里的 qc 已回写为 ok', !!hitRec && hitRec.qc === 'ok');

  // 删除成绩是内容运营动作 → 卡 can_edit（教练不在范围内也有权看，但无权删）
  const delByCoach = await call('DELETE', '/records/' + encodeURIComponent(qcTarget.id), undefined, { token: coT.token });
  eq('教练删除成绩被拒（403）', delByCoach.status, 403);

  // 审计 + 清理（保持幂等：撤销质检、删掉临时记录）
  const audit3 = await call('GET', '/audit?limit=300', undefined, { token: adm.token });
  const logs3 = (data(audit3) && data(audit3).items) || [];
  ok('审计记录教练写辅导记录', logs3.some((x) => x.action === 'coach.note' && x.userId === 'U-COACH2'));
  ok('审计记录质检结论', logs3.some((x) => x.action === 'qc.mark' && x.userId === 'U-COACH2'));
  const qcClr = await call('DELETE', '/records/' + encodeURIComponent(qcTarget.id) + '/qc', undefined, { token: coT.token });
  eq('撤销质检结论成功', qcClr.status, 200);
  const rmNote = await call('DELETE', '/coach-notes/' + encodeURIComponent(myNote.id), undefined, { token: coT.token });
  eq('删除辅导记录成功', rmNote.status, 200);
  const noteGone = await call('GET', '/coach-notes?learnerId=' + coIds[0], undefined, { token: coT.token });
  ok('删除后查不到该记录',
    !((data(noteGone) && data(noteGone).items) || []).some((n) => n.id === myNote.id));

  /* ---- 8d. P4：任务审计 ---- */
  const audit2 = await call('GET', '/audit?limit=300', undefined, { token: adm.token });
  const logs2 = (data(audit2) && data(audit2).items) || [];
  ok('审计记录任务下发', logs2.some((x) => x.action === 'task.assign' && x.userId === 'U-OP01'));
  ok('审计记录任务改期', logs2.some((x) => x.action === 'task.update'));
  ok('审计记录任务状态变更', logs2.some((x) => x.action === 'task.status'));

  /* ---- 8e. 清理临时任务 ---- */
  const delTk = await call('DELETE', '/tasks/' + encodeURIComponent(TKID), undefined, { token: op.token });
  eq('清理临时任务成功', delTk.status, 200);
  const gone = await call('GET', '/tasks/' + encodeURIComponent(TKID), undefined, { token: adm.token });
  eq('删除后任务不可读（404）', gone.status, 404);

  /* ---- 9. 清理临时场景 ---- */
  const del = await call('DELETE', '/scenes/' + sid, undefined, { token: op.token });
  eq('清理临时场景成功', del.status, 200);

  /* ---- 9b. 清理本次练习产生的成绩 ----
   * 不复用 sid2 的中间产物：这两条成绩只属于本进程，删掉才算真正幂等。
   * 删完再确认一次，顺带验证 deleteRecord 的 404 语义。
   */
  for (const rid of [anonRecId, recId, orphanId]) {
    if (!rid) continue;
    const rm = await call('DELETE', '/records/' + encodeURIComponent(rid), undefined, { token: adm.token });
    ok('清理自测成绩 ' + rid + '（期望 200，实际 ' + rm.status + '）', rm.status === 200);
  }
  const recGone = await call('DELETE', '/records/' + encodeURIComponent(recId || 'R-NOPE'), undefined, { token: adm.token });
  eq('成绩已不存在（重复删除 404）', recGone.status, 404);

  /* ---- 10. enforce 模式：独立进程验证无 token 一律 401 ---- */
  await checkEnforce();

  finish();
})().catch((e) => { console.error('\n  自测异常：' + e.stack); process.exit(2); });

/* ------------------------------------------------------------------ */
async function checkEnforce() {
  console.log('  ─────────────────────────────────────────');
  console.log('  enforce 模式（独立进程 ' + ENFORCE_PORT + '）');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: Object.assign({}, process.env, { AUTH_MODE: 'enforce', PORT: String(ENFORCE_PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let booted = false;
  child.stdout.on('data', (b) => { if (String(b).indexOf('已启动') >= 0) booted = true; });
  child.stderr.on('data', () => {});

  const EB = `http://127.0.0.1:${ENFORCE_PORT}/api/v1`;
  const tryFetch = async (p, token, init) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    try {
      const r = await fetch(EB + p, Object.assign({ headers: h }, init || {}));
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) { return { status: 0, body: null }; }
  };

  // 等启动（最多 8 秒）
  for (let i = 0; i < 40 && !booted; i++) await new Promise((r) => setTimeout(r, 200));
  try {
    const s0 = await tryFetch('/status');
    ok('enforce：/status 仍公开', s0.status === 200);
    const a0 = await tryFetch('/audit');
    eq('enforce：无 token 读审计被拒', a0.status, 401);
    const e0 = await tryFetch('/scenes', undefined);
    eq('enforce：无 token 读场景被拒', e0.status, 401);
    // P4：任务列表要身份，但「我的任务」（带 learnerId）必须匿名可读
    const t0 = await tryFetch('/tasks');
    eq('enforce：无 token 列任务被拒', t0.status, 401);
    const t1 = await tryFetch('/tasks?learnerId=L01');
    ok('enforce：学员端匿名读「我的任务」仍可用（不登录也要能练）', t1.status === 200 && !!(t1.body && t1.body.ok));
    // P6：场景池同样是 practice 档；这条同时能抓到「/scenes/published 被 /scenes/:id 抢先匹配」的注册顺序错误
    const p0 = await tryFetch('/scenes/published');
    ok('enforce：学员端匿名读「已发布场景池」仍可用', p0.status === 200 && !!(p0.body && p0.body.ok) &&
      Array.isArray(p0.body.data && p0.body.data.items),
      'HTTP ' + p0.status + (p0.body && p0.body.data && Array.isArray(p0.body.data.items) ? ' · ' + p0.body.data.items.length + ' 个场景' : ' · 形状异常'));
    const t2 = await tryFetch('/tasks', undefined, { method: 'POST', body: JSON.stringify({ title: 'x', sceneId: 's1', assignees: ['L01'] }) });
    eq('enforce：无 token 下发任务被拒', t2.status, 401);
    // P7：逐轮对话是 staff 档 —— 它含学员真实作答，不是练习通道能匿名读的东西。
    // 同时能抓到「/records/:id/turns 被 /records/:id 抢先匹配」的注册顺序错误。
    const tu0 = await tryFetch('/records/R001/turns');
    eq('enforce：无 token 读逐轮对话被拒', tu0.status, 401);

    const lg = await (async () => {
      const r = await fetch(EB + '/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: 'wangqian', password: 'op123456' })
      });
      return { status: r.status, body: await r.json() };
    })();
    ok('enforce：登录仍可用', lg.status === 200 && lg.body && lg.body.ok);
    const tok = lg.body && lg.body.ok ? lg.body.data.token : null;
    const a1 = await tryFetch('/audit', tok);
    eq('enforce：带 token 可读审计', a1.status, 200);
    const t3 = await tryFetch('/tasks', tok);
    eq('enforce：带 token 可列任务', t3.status, 200);
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }
}

function finish() {
  console.log('  ─────────────────────────────────────────');
  if (fail) {
    console.log('  结果：\x1b[31mPASS ' + pass + ' / FAIL ' + fail + '\x1b[0m');
    failures.forEach((f) => console.log('    ✗ ' + f));
    process.exit(1);
  }
  console.log('  结果：\x1b[32mPASS ' + pass + ' / FAIL 0\x1b[0m');
  console.log('');
  process.exit(0);
}
