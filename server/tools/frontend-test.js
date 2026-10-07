'use strict';
/**
 * 前端接入验证（**不需要浏览器**）
 *
 *   node server/tools/frontend-test.js          # 默认打 http://127.0.0.1:8848
 *   BASE=http://127.0.0.1:8850/api/v1 node server/tools/frontend-test.js
 *
 * 为什么不用无头浏览器：本机 Chrome/Edge 在部分环境下完全无法启动（连
 * `--version` 都没有输出），而真正要验的是「脚本能否解析 + 数据口径是否
 * 真的跟着服务端走 + 接线有没有漏」。用 Node 的 vm 沙箱加载真实前端脚本、
 * 用真 fetch 打真服务端，比截图更能证明逻辑正确、也更快更稳。
 * 界面观感（布局/遮挡/主题）仍需人工或在可用浏览器的环境里过一眼。
 *
 * 覆盖十个层次（①②②b③③b③c③d③e④⑤）：
 *   1. 语法检查：5 个页面的内联脚本 + 4 个共享脚本能否解析
 *   2. 数据源水合：app-data.js 的 replaceInPlace / reindex 是否真的让
 *      统计口径（overview / taskProgress / taskById）跟着变
 *   2b. 场景池热更新（P6）：mergeScenes 必须「按 id 原地更新 + 追加」「不重排、不删除」，
 *      且必须**保持数组与元素引用**（学员端 cur 是下标、SCENES[cur] 到处实时求值）
 *   3. 同步层往返：assets/admin-server-sync.js 在沙箱里对真服务端跑
 *      tasks / learners / records / saveTask / taskStatus / removeTask
 *   3b. 教练端（P5）：辅导记录与质检结论的读写 + 数据范围拦截
 *   3c. 学员端场景池（P6）：AIBOOT.scenes() 匿名取回 → mergeScenes 合并 → 可被判分；
 *      后端不可达时必须返回 null 且不抛错（铁律 9）
 *   3d. 逐轮对话往返（P7）：SYNC.turns() 范围内容 200 且字段集完整、
 *      越范围/不存在/空 id 一律**静默返回 null**、离线时**不抛错**
 *   3e. 逐轮卡片渲染器（P7）：把 esc / scriptTurns / turnDimLine / roundsHtml 的
 *      **真实源码**抠进沙箱、喂**真实逐轮数据**跑一遍，断言渲染结果里逐字出现
 *      学员的每一句作答（正则只能证明"函数存在"）
 *   4. 关键接线断言：页面里必须存在这些调用点（防止后续改动改漏）
 *   5. 学员端整页脚本在沙箱里真跑：发布 → 学员端会话列表 HTML 里真的出现
 *
 * 会创建并删除一条临时任务与一条临时辅导记录，不改动其余数据。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8848';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };
const sec = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 60 - t.length)));

/* ---------------------------------------------------------------- *
 * 1. 语法检查
 * ---------------------------------------------------------------- */
sec('1. 语法检查（页面内联脚本与共享脚本）');
const PAGES = ['index.html', '仿真培训原型-微信风格.html', '管理后台-仿真培训.html', '教练工作台-带教主管.html', '产品规划-新员工培训系统.html'];
PAGES.forEach((f) => {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let bad = null;
  scripts.forEach((s, i) => { try { new vm.Script(s, { filename: f + '#' + i }); } catch (e) { bad = bad || (f + ' 脚本#' + i + ': ' + e.message); } });
  ok(!bad, '内联脚本可解析（' + scripts.length + ' 段）· ' + f + (bad ? ' — ' + bad : ''));
});
['data/app-data.js', 'data/scoring-engine.js', 'assets/ai-bridge.js', 'assets/admin-server-sync.js'].forEach((f) => {
  let bad = null;
  try { new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); } catch (e) { bad = e.message; }
  ok(!bad, '共享脚本可解析 · ' + f + (bad ? ' — ' + bad : ''));
});

/* ---------------------------------------------------------------- *
 * 2. 数据源水合
 * ---------------------------------------------------------------- */
sec('2. app-data.js：replaceInPlace / reindex 是否真的改变统计口径');
const dataCtx = { window: {}, console: { log() {}, warn() {} } };
vm.createContext(dataCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/app-data.js'), 'utf8'), dataCtx, { filename: 'app-data.js' });
const T = dataCtx.window.TRAIN;
const before = T.helpers.overview();
ok(before.learnerCount === 12 && before.totalRecords === T.records.length, '初始：12 名学员 / ' + T.records.length + ' 条成绩');

// 模拟"服务端返回了更小的范围"：2 名学员 + 2 条成绩 + 1 个新任务
const newTask = { id: 'TN_TEST', code: 'RW-TEST-01', title: '水合验证任务', sceneId: 's1', passLine: 70, dueAt: '2026-10-30 18:00', status: 'running', assignees: ['L01', 'L02'], createdAt: '2026-10-06 10:00', createdBy: '自测' };
const liteLearners = T.learners.slice(0, 2).map((l) => Object.assign({}, l));
const liteRecords = [
  { id: 'RS1', taskId: 'TN_TEST', learnerId: 'L01', sceneId: 's1', score: 80, dimScores: { d1: 80, d2: 80, d3: 80, d4: 80, d5: 80 }, passLine: 70, passed: true, finishedAt: '2026-10-06 11:00', minutes: 0, turns: 6, channel: '微信沟通' },
  { id: 'RS2', taskId: 'TN_TEST', learnerId: 'L02', sceneId: 's1', score: 50, dimScores: { d1: 50, d2: 50, d3: 50, d4: 50, d5: 50 }, passLine: 70, passed: false, finishedAt: '2026-10-06 12:00', minutes: 0, turns: 6, channel: '微信沟通' }
];
const changed = T.helpers.replaceInPlace({ learners: liteLearners, tasks: [newTask], records: liteRecords });
ok(changed.learners === 2 && changed.tasks === 1 && changed.records === 2, '返回替换计数 ' + JSON.stringify(changed));

const after = T.helpers.overview();
ok(after.learnerCount === 2, '水合后 overview().learnerCount = ' + after.learnerCount + '（应 2）');
ok(after.totalRecords === 2, '水合后 overview().totalRecords = ' + after.totalRecords + '（应 2）');
ok(after.runningTasks === 1, '水合后 runningTasks = ' + after.runningTasks + '（应 1）');

// 关键：新建的服务端任务必须能被 helpers 的进度口径识别（reindex 生效）
const tp = T.helpers.taskProgress('TN_TEST');
ok(!!tp && tp.total === 2 && tp.finishedCount === 2 && tp.passedCount === 1,
  '新建任务的进度口径可用：' + (tp ? tp.finishedCount + '/' + tp.total + '，达标 ' + tp.passedCount : 'null'));
ok(!!T.taskById('TN_TEST') && T.taskById('TN_TEST').title === '水合验证任务', 'taskById 能按 id 取到新任务（reindex 已生效）');
ok(T.learnerById('L01') && !T.learnerById('L03'), 'learnerById 同步收敛（L03 已不在范围内）');

// 空数组必须照收（数据范围为 0 人不等于"保留旧数据"）
T.helpers.replaceInPlace({ learners: [], tasks: [], records: [] });
ok(T.helpers.overview().learnerCount === 0, '空数组照收：learnerCount = 0（而不是保留旧值）');
// null 表示拉取失败 → 保留本地
T.helpers.replaceInPlace({ learners: null, tasks: null, records: null });
ok(T.helpers.overview().learnerCount === 0, 'null 表示失败：保持现状不覆盖');

/* ---------------------------------------------------------------- *
 * 2b. 场景池热更新（P6）：mergeScenes 的语义必须是「按 id 原地更新 + 追加」
 *
 *   为什么语义不能改：学员端 `cur` 是**数组下标**、`SCENES[cur]` 到处实时求值，
 *   所以合并**绝不能重排**；服务端库可能不全（只播了部分场景），所以**绝不能删**
 *   本地种子。这两条一旦破了，表现是"练着练着场景变了"或"学员没场景可练"，
 *   而且**不会有任何报错**，只能靠这里的断言拦住。
 * ---------------------------------------------------------------- */
sec('2b. app-data.js：mergeScenes 合并语义（P6 场景池热更新）');
const lw = dataCtx.window;
const learnerArrRef = lw.SCENES;               // 学员端数组引用
const learnerFirstRef = lw.SCENES[0];          // 学员端首个元素引用
const srcFirstRef = T.scenes[0];
const n0 = T.scenes.length;
const ids0 = T.scenes.map((s) => s.id).join(',');

// 空 / 无效入参：必须原样返回且完全不动（离线时页面会拿到 null）
const rNull = T.helpers.mergeScenes(null);
const rEmpty = T.helpers.mergeScenes([]);
const rNoId = T.helpers.mergeScenes([{ name: '没有 id 的场景' }]);
ok(rNull.added === 0 && rNull.updated === 0 && rEmpty.added === 0 && rEmpty.updated === 0 &&
  rNoId.added === 0 && rNoId.updated === 0, 'null / [] / 缺 id 入参都不改动场景库');
ok(T.scenes.length === n0 && lw.SCENES.length === n0, '场景数保持 ' + n0 + ' 个');
ok(T.scenes.map((s) => s.id).join(',') === ids0, '场景顺序保持不变');

// 已存在的 id → 原地更新，引用一律不换
const upd = T.helpers.mergeScenes([{ id: T.scenes[0].id, passLine: 88, name: '改名后的首个场景' }]);
ok(upd.updated === 1 && upd.added === 0, '同 id 走「更新」分支 ' + JSON.stringify(upd));
ok(T.scenes[0] === srcFirstRef, '源数组元素引用未替换（idx.scene 还指着它）');
ok(lw.SCENES === learnerArrRef, '学员端数组引用未被替换');
ok(lw.SCENES[0] === learnerFirstRef, '学员端元素引用未被替换（?demo 分支会先抓再回填）');
ok(T.sceneById(T.scenes[0].id).passLine === 88, 'sceneById 读到更新后的 passLine = 88');
ok(lw.SCENES[0].pass === 88 && lw.SCENES[0].name === '改名后的首个场景',
  '学员端旧形状同步刷新（pass = 88，name 已改）');

// 全新 id → 追加到末尾，且绝不重排已有顺序
const newScene = {
  id: 'SC-MERGE-1', code: 'SC-900', name: '合并进来的新场景', subtitle: '服务端新发布',
  avatarText: '新', color: '#5B8FF9', taskName: '合并验证', channel: '微信沟通',
  passLine: 66, objectives: [{ text: '目标一', dim: 'd2' }],
  script: [{ t: '你好', v: 4 }], tips: ['提示'], voicePool: []
};
const add2 = T.helpers.mergeScenes([newScene]);
ok(add2.added === 1 && add2.updated === 0, '全新 id 走「追加」分支 ' + JSON.stringify(add2));
ok(T.scenes.map((s) => s.id).join(',') === ids0 + ',SC-MERGE-1', '原有顺序一字未动，新场景追加在末尾');
ok(T.scenes.length === n0 + 1 && lw.SCENES.length === n0 + 1, '源数组与学员端数组同步增长到 ' + (n0 + 1));
ok(!!T.sceneById('SC-MERGE-1'), 'reindex 生效：新场景能被 sceneById 取到');
ok(lw.SCENES[n0].objDim[0] === T.helpers.dimIndex('d2'),
  '学员端旧形状的 objDim 由 dim 正确换算（' + lw.SCENES[n0].objDim[0] + '）');
ok(T.scenes[0] === srcFirstRef && lw.SCENES === learnerArrRef && lw.SCENES[0] === learnerFirstRef,
  '追加后前面的引用依然未变（不重排的硬证据）');

/* ---------------------------------------------------------------- *
 * 3. 同步层（真 fetch 打真服务端）
 * ---------------------------------------------------------------- */
sec('3. admin-server-sync.js 往返真实服务端');
const store = {};
const ls = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
/* document 桩：ai-bridge.js 末尾会挂状态角标，readyState 停在 'loading'
   就永远走不到 mountBadge（否则沙箱里没有真实 DOM，会抛异常打断整个 harness）。 */
const docStub = { readyState: 'loading', addEventListener() {} };
const win = {
  localStorage: ls,
  location: { search: '', protocol: 'http:', origin: 'http://127.0.0.1:8848', href: BASE + '/x.html' },
  console,
  fetch: fetch, URLSearchParams, setTimeout, clearTimeout, Promise, Date, JSON, Math, Object, Array, String, Number,
  document: docStub
};
vm.createContext(win);
win.window = win;   // 文件末尾是 })(window)，沙箱里也要有 window 指向全局
// 同一个沙箱里把数据源、同步层、AI 适配层都装上：这样第 3c 节能验真实的
// 「AIBOOT 取回服务端场景池 → TRAIN.helpers.mergeScenes 合并」端到端一跳。
vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/app-data.js'), 'utf8'), win, { filename: 'app-data.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/admin-server-sync.js'), 'utf8'), win, { filename: 'admin-server-sync.js' });
const aiBridgeSrc = fs.readFileSync(path.join(ROOT, 'assets/ai-bridge.js'), 'utf8');
vm.runInContext(aiBridgeSrc, win, { filename: 'ai-bridge.js' });
const SYNC = win.ADMIN_SYNC;
const BOOT = win.AIBOOT;
const LT = win.TRAIN;

(async () => {
  const online = await SYNC.probe(true);
  ok(online === true, 'probe 命中 ' + SYNC.base);

  // 未登录（open 模式回落 U-ADMIN）→ 全量
  let ls1 = await SYNC.learners(); let ts1 = await SYNC.tasks(); let rs1 = await SYNC.records();
  ok(Array.isArray(ls1) && Array.isArray(ts1) && Array.isArray(rs1), 'learners/tasks/records 都返回数组（形状修正后不再是裸对象）');
  ok(ls1.length > 0 && ts1.length > 0 && rs1.length > 0, '未登录=全量：' + ls1.length + ' 学员 / ' + ts1.length + ' 任务 / ' + rs1.length + ' 成绩');
  ok(ts1.every((t) => Array.isArray(t.assignees) && t.progress && t.progress.total === t.assignees.length),
    '每个任务都带 assignees 与 progress，且 progress.total 与指派数一致');
  ok(rs1.every((r) => r.minutes !== undefined && r.turns !== undefined), '成绩带 minutes/turns 字段（种子记录的用时不会在水合后丢失）');

  // 学员端方法（匿名）
  const mine = await SYNC.tasksOf('L06');
  ok(Array.isArray(mine) && mine.length > 0, 'tasksOf(L06) = ' + (mine ? mine.length : null) + ' 条');
  ok(mine.every((t) => t.assignees.indexOf('L06') >= 0 && t.status !== 'draft'), 'tasksOf 只返回派给该学员且已下发的任务');

  // 登录切换范围
  const lg = await SYNC.login('limeng', 'op123456');
  ok(lg.ok && lg.user.scopeLabel.indexOf('连锁渠道事业部') >= 0, '登录 李萌 → 范围「' + (lg.user && lg.user.scopeLabel) + '」');
  const ls2 = await SYNC.learners(); const ts2 = await SYNC.tasks(); const rs2 = await SYNC.records();
  ok(ls2.length > 0 && ls2.length < ls1.length, '登录后学员收紧：' + ls2.length + ' / ' + ls1.length);
  ok(ls2.every((l) => l.dept === '连锁渠道事业部'), '可见学员全部属于本部门');
  ok(ts2.length < ts1.length || ts2.every((t) => t.assignees.every((x) => ls2.some((l) => l.id === x))),
    '可见任务的指派人也都在范围内部：' + ts2.length + ' 个任务');
  ok(rs2.length > 0 && rs2.length < rs1.length, '可见成绩收紧：' + rs2.length + ' / ' + rs1.length);

  // 下发 → 可见 → 结束 → 删除（走同步层，形状与页面一致）
  const created = await SYNC.saveTask({
    title: '同步层验证任务', sceneId: 's1', passLine: 68, dueAt: '2026-10-28 18:00',
    assignees: ['L01', 'L02'], status: 'running', note: 'harness'
  });
  ok(created.ok && created.task && created.task.assignees.length === 2, 'saveTask 下发成功 id=' + (created.task && created.task.id));
  const tid = created.task && created.task.id;

  const mineL01 = await SYNC.tasksOf('L01');
  ok(mineL01.some((t) => t.id === tid), '学员端 tasksOf(L01) 能立刻看到新下发的任务（下发→接收闭环）');

  const st = await SYNC.taskStatus(tid, 'finished');
  ok(st.ok && st.task.status === 'finished', 'taskStatus 结束 → ' + st.task.status);
  const rm = await SYNC.removeTask(tid);
  ok(rm.ok && rm.status === 200, 'removeTask 删除 → HTTP ' + rm.status);

  // 越权：教练不能下发
  const lg2 = await SYNC.login('zhoumin', 'coach123');
  ok(lg2.ok && lg2.user.scopeLabel.indexOf('周敏') >= 0, '登录 周敏 → 范围「' + (lg2.user && lg2.user.scopeLabel) + '」');
  const deny = await SYNC.saveTask({ title: 'x', sceneId: 's1', assignees: ['L01'] });
  ok(!deny.ok && deny.status === 403, '教练下发被拒：HTTP ' + deny.status + ' · ' + deny.error);

  const ls3 = await SYNC.learners();
  ok(ls3.length > 0 && ls3.length < ls1.length && ls3.every((l) => l.mentor === '周敏'),
    '教练（带教范围）可见学员 = ' + ls3.length + ' 人，且都是本人带教');

  /* ------------------------------------------------------------ *
   * 3b. 教练端（P5）：辅导记录 / 质检结论 + 数据范围
   *   此时登录身份是周敏（mentor 范围，只带 4 名学员）
   * ------------------------------------------------------------ */
  sec('3b. 教练端：辅导记录与质检（周敏 · 本人带教）');

  const zRecs = await SYNC.records();
  ok(zRecs.every((r) => ls3.some((l) => l.id === r.learnerId)),
    '教练可见成绩全部落在范围内（' + zRecs.length + ' 条）');
  ok(zRecs.every((r) => typeof r.qc === 'string'), '成绩记录带 qc 字段（质检状态由服务端一并返回）');
  ok(zRecs.every((r) => r.mode === 'task' || r.mode === 'free'),
    '成绩记录带 mode 来源字段（task|free，P8 自主练习可见化）');

  const notes0 = await SYNC.coachNotes();
  ok(Array.isArray(notes0), 'coachNotes() 返回数组（' + (notes0 ? notes0.length : null) + ' 条）');
  ok(notes0.every((n) => ls3.some((l) => l.id === n.learnerId)), '只返回范围内学员的辅导记录');

  const addRes = await SYNC.addCoachNote({
    learnerId: ls3[0].id, text: 'harness 临时辅导记录（跑完删除）', type: '一对一辅导'
  });
  ok(addRes.ok && addRes.note && addRes.note.id, 'addCoachNote 写入成功 id=' + (addRes.note && addRes.note.id));
  const nid = addRes.note && addRes.note.id;

  const notesOne = await SYNC.coachNotes(ls3[0].id);
  ok(notesOne.some((n) => n.id === nid), '按学员收窄后能查到刚写的记录');

  // 范围外写记录 → 403
  const outsider = ls1.filter((l) => !ls3.some((x) => x.id === l.id))[0];
  const badNote = await SYNC.addCoachNote({ learnerId: outsider.id, text: '越权尝试' });
  ok(!badNote.ok && badNote.status === 403, '给范围外学员写记录被拒：HTTP ' + badNote.status);

  // 空内容 → 400
  const emptyNote = await SYNC.addCoachNote({ learnerId: ls3[0].id, text: '   ' });
  ok(!emptyNote.ok && emptyNote.status === 400, '空内容被拒：HTTP ' + emptyNote.status);

  // 质检：挑一条还没有结论的记录，避免覆盖演示数据
  const fresh = zRecs.filter((r) => !r.qc)[0] || zRecs[0];
  const qcSet = await SYNC.setQc(fresh.id, 'ok');
  ok(qcSet.ok && qcSet.qc.state === 'ok', 'setQc(' + fresh.id + ', ok) → ' + (qcSet.qc && qcSet.qc.state));

  const qcBad = await SYNC.setQc(fresh.id, 'maybe');
  ok(!qcBad.ok && qcBad.status === 400, '非法质检结论被拒：HTTP ' + qcBad.status);

  const outRec = rs1.filter((r) => !ls3.some((l) => l.id === r.learnerId))[0];
  const qcOut = await SYNC.setQc(outRec.id, 'ok');
  ok(!qcOut.ok && qcOut.status === 403, '给范围外记录做质检被拒：HTTP ' + qcOut.status);

  const qcList1 = await SYNC.qcList();
  ok(Array.isArray(qcList1) && qcList1.some((q) => q.recordId === fresh.id && q.state === 'ok'),
    '质检结论已落库并可回读（当前 ' + (qcList1 ? qcList1.length : 0) + ' 条）');
  ok(qcList1.every((q) => zRecs.some((r) => r.id === q.recordId)), 'qcList 只返回范围内记录的结论');

  // 回读成绩时 qc 字段应已同步
  const zRecs2 = await SYNC.records();
  const hit = zRecs2.filter((r) => r.id === fresh.id)[0];
  ok(!!hit && hit.qc === 'ok', '成绩列表里的 qc 状态已更新为 ok');

  // 清理：撤销质检、删掉临时辅导记录（保持可重复运行）
  const qcClr = await SYNC.clearQc(fresh.id);
  ok(qcClr.ok, 'clearQc 撤销质检结论 → HTTP ' + qcClr.status);
  const rmNote = await SYNC.removeCoachNote(nid);
  ok(rmNote.ok, 'removeCoachNote 删除 → HTTP ' + rmNote.status);
  const notesAfter = await SYNC.coachNotes(ls3[0].id);
  ok(!notesAfter.some((n) => n.id === nid), '删除后按学员查不到该记录');

  /* ------------------------------------------------------------ *
   * 3c. 学员端场景池（P6）：匿名拉取 → 合并进场景库
   *   这是「运营发布场景 → 学员能练到」这条链路的最后一跳。
   *   注意此时登录身份仍是周敏（教练），而这一步**不带任何身份**，
   *   正好验证该接口对匿名可用（学员没登录也要能拿到场景）。
   * ------------------------------------------------------------ */
  sec('3c. 学员端场景池：匿名拉取 + 合并（P6）');

  const pool = await BOOT.scenes();
  ok(Array.isArray(pool) && pool.length >= 3,
    'AIBOOT.scenes() 匿名取到 ' + (Array.isArray(pool) ? pool.length : null) + ' 个已发布场景');
  ok(!!pool && pool.every((s) => Array.isArray(s.script) && Array.isArray(s.objectives) &&
    Array.isArray(s.tips) && Array.isArray(s.voicePool) && typeof s.passLine === 'number'),
    '每个场景都带 script/objectives/tips/voicePool/passLine（可直接进判分）');
  ok(!!pool && pool.every((s) => ['audit', 'versions', 'owner', 'publish', 'status', 'updatedAt', 'brief']
    .every((k) => s[k] === undefined)),
    '池内不含治理字段（audit/versions/owner/publish/status/updatedAt/brief）');

  // 服务端种子场景与本地种子同 id → 必须全部走「更新」而不重复追加
  const idsBefore = LT.scenes.map((s) => s.id).join(',');
  const arrRef = win.SCENES;
  const firstRef0 = win.SCENES[0];
  const m1 = LT.helpers.mergeScenes(pool);
  ok(m1.added === 0 && m1.updated === pool.length,
    '与服务端种子同 id：全部走更新 ' + JSON.stringify(m1));
  ok(LT.scenes.map((s) => s.id).join(',') === idsBefore,
    '合并后 id 序列一字未变（没有重复追加、也没有重排）');
  ok(win.SCENES === arrRef && win.SCENES[0] === firstRef0 && win.SCENES.length === LT.scenes.length,
    '学员端数组与元素引用均未被替换，长度 ' + win.SCENES.length);

  // 模拟「运营新发布了一个本地种子里没有的场景」→ 必须被追加进来并可判分
  const brandNew = Object.assign({}, pool[0], {
    id: 'SC-NEW-PUB', name: '运营新发布的场景', subtitle: '热更新验证',
    objectives: [{ text: '新目标', dim: 'd3' }], passLine: 71
  });
  const m2 = LT.helpers.mergeScenes([brandNew]);
  ok(m2.added === 1 && m2.updated === 0, '全新 id 走追加 ' + JSON.stringify(m2));
  const lastIdx = LT.scenes.length - 1;
  ok(LT.scenes[lastIdx].id === 'SC-NEW-PUB' && win.SCENES[lastIdx].id === 'SC-NEW-PUB',
    '新场景落在末尾，源数组与学员端数组都能读到');
  ok(win.SCENES[lastIdx].pass === 71 && win.SCENES[lastIdx].objDim[0] === LT.helpers.dimIndex('d3'),
    '学员端形状换算正确（pass = 71，objDim 指向需求挖掘）');
  ok(!!LT.sceneById('SC-NEW-PUB'),
    'reindex 生效：新场景能被 sceneById 取到（任务卡片据此解除「场景已下线」）');
  ok(LT.helpers.taskProgress && win.SCENES.length === LT.scenes.length,
    '合并后两套数组长度一致（' + win.SCENES.length + '）');

  // 降级：后端完全不可达时必须返回 null 而不是抛错（铁律 9：绝不阻塞 UI）
  // 用独立沙箱 + 永远失败的 fetch，确保 probe() 的所有候选基址都探不通。
  const offCtx = {
    localStorage: ls,
    location: { search: '', protocol: 'file:', origin: 'null', href: 'file:///x.html' },
    console: { log() {}, warn() {} },
    document: docStub,
    fetch: () => Promise.reject(new Error('ENOTFOUND（自测强制离线）')),
    URLSearchParams, setTimeout, clearTimeout, Promise, Date, JSON, Math, Object, Array, String, Number
  };
  vm.createContext(offCtx);
  offCtx.window = offCtx;
  vm.runInContext(aiBridgeSrc, offCtx, { filename: 'ai-bridge.js(offline)' });
  const offBoot = offCtx.AIBOOT;
  let offThrew = null;
  let offScenes = 'NOT_CALLED';
  try { offScenes = await offBoot.scenes(); } catch (e) { offThrew = e; }
  ok(offThrew === null && offScenes === null,
    '后端不可达时 scenes() 返回 null 且不抛错' + (offThrew ? '（实际抛了：' + offThrew.message + '）' : ''));
  let offTasks = 'NOT_CALLED';
  try { offTasks = await offBoot.tasks('L01'); } catch (e) { offThrew = e; }
  ok(offThrew === null && offTasks === null, '后端不可达时 tasks() 同样返回 null 且不抛错');
  ok(offBoot.status === 'offline', '探测失败后 status = offline（角标据此显示「离线模式」）');

  /* ------------------------------------------------------------ *
   * 3d. 逐轮对话（P7）：同步层按需读取 + 三种结果必须可区分
   *
   *   为什么单独一节：逐轮对话此前**只写不读**（session_turns 有写入口，
   *   没有读接口，也没有页面渲染它），而「对话质检」这个界面看不到对话。
   *   这一节验同步层的 turns()：
   *     有数据 → 数组（字段集完整）
   *     越范围 / 不存在 → null（静默降级，绝不抛错、绝不用空数组骗调用方）
   *   此时登录身份是周敏（mentor 范围，只带 4 名学员），
   *   所以"范围内读得到 / 越范围读不到"两件事可以一起验。
   * ------------------------------------------------------------ */
  sec('3d. 逐轮对话：同步层按需读取（P7）');

  const TURN_FIELDS = ['idx', 'learnerText', 'customerReply', 'emotion', 'score', 'dimScores', 'confidence', 'source', 'at'];
  const mineRecs = (await SYNC.records()) || [];
  const mineT = mineRecs.filter((r) => r.turnCount > 0);
  ok(mineT.length > 0, '周敏可见范围内有逐轮对话的成绩 ' + mineT.length + ' 条');
  ok(mineRecs.every((r) => r.evidence === undefined),
    'records() 不再把对话正文带进列表（只给 turnCount：' +
    [...new Set(mineRecs.map((r) => r.turnCount))].sort().join('/') + ' 轮）');

  const t1 = await SYNC.turns(mineT[0].id);
  ok(Array.isArray(t1) && t1.length > 0,
    'SYNC.turns(' + mineT[0].id + ') 取到 ' + (Array.isArray(t1) ? t1.length : t1) + ' 轮');
  ok(Array.isArray(t1) && t1.every((t) => TURN_FIELDS.every((k) => t[k] !== undefined)),
    '逐轮字段集完整（缺一即静默 undefined）：' + TURN_FIELDS.join('/'));
  ok(Array.isArray(t1) && t1.every((t) => !!t.learnerText && !!t.customerReply),
    '每轮都同时有客户台词与学员作答（这才是"可复盘的对话"）');
  ok(Array.isArray(t1) && t1.every((t) => typeof t.score === 'number' && typeof t.dimScores === 'object'),
    '每轮带本轮得分与五维明细');

  // 越范围 → 服务端 403 → 同步层必须返回 null
  const admTmp = await SYNC.login('admin', 'admin123');
  const allRecs = (await SYNC.records()) || [];
  const allIds = allRecs.map((r) => r.id);
  const mineIds = mineRecs.map((r) => r.id);
  const outsideId = allIds.filter((id) => mineIds.indexOf(id) < 0)[0];
  await SYNC.login('zhoumin', 'coach123');                 // 切回带教范围
  if (outsideId) {
    const tOut = await SYNC.turns(outsideId);
    ok(tOut === null, '越范围读逐轮（' + outsideId + '）返回 null（服务端 403，不泄漏对话）');
  } else {
    ok(false, '无法构造越范围样本（周敏可见全部记录？）');
  }
  ok((await SYNC.turns('R-NO-SUCH-RECORD')) === null, '不存在的成绩返回 null');
  ok((await SYNC.turns('')) === null, '空 id 直接返回 null（不打无意义的请求）');

  // 离线：同步层同样必须静默返回 null（铁律 9：绝不抛错、绝不阻塞页面）
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/admin-server-sync.js'), 'utf8'), offCtx,
    { filename: 'admin-server-sync.js(offline)' });
  let offTurns = 'NOT_CALLED', offTurnsThrew = null;
  try { offTurns = await offCtx.ADMIN_SYNC.turns('R001'); } catch (e) { offTurnsThrew = e; }
  ok(offTurnsThrew === null && offTurns === null,
    '后端不可达时 turns() 返回 null 且不抛错' + (offTurnsThrew ? '（实际抛了：' + offTurnsThrew.message + '）' : ''));

  /* ------------------------------------------------------------ *
   * 3e. 逐轮卡片渲染器：把**真实源码**抠出来在沙箱里跑
   *
   *   静态正则只能证明"函数存在"，证明不了"它把学员的话渲染出来了"。
   *   这里把 esc / scriptTurns / turnDimLine / roundsHtml 的源码原样抠出来，
   *   配真实场景 + 真实逐轮数据跑一遍。断言落点是**渲染结果里逐字出现学员的
   *   每一句作答**，以及"有真实作答时参考表达默认收起"（版面让给学员的话）。
   * ------------------------------------------------------------ */
  sec('3e. 逐轮卡片渲染：真实源码 + 真实数据（P7）');

  const cSrc = fs.readFileSync(path.join(ROOT, '教练工作台-带教主管.html'), 'utf8');
  const take = (from, to) => {
    const a = cSrc.indexOf(from), b = cSrc.indexOf(to, a + from.length);
    return a >= 0 && b > a ? cSrc.slice(a, b) : '';
  };
  const fnSrc = take('function esc(s) {', 'function riskTag(') +
    take('function scriptTurns(sc) {', 'function loadRounds(rec, sc, hostId) {');
  ok(fnSrc.indexOf('function scriptTurns') > 0 && fnSrc.indexOf('function roundsHtml') > 0,
    '从教练台源码中抠出 esc + 逐轮渲染函数（' + fnSrc.length + ' 字符）');

  const rCtx = { T: T, H: T.helpers, console: { log() {}, warn() {} } };
  vm.createContext(rCtx);
  vm.runInContext(fnSrc + '\nthis.__scriptTurns = scriptTurns; this.__roundsHtml = roundsHtml;', rCtx,
    { filename: 'coach-render.js' });

  const demoScene = T.sceneById('s1');
  const skel = rCtx.__scriptTurns(demoScene);
  ok(skel.length === demoScene.script.length && skel.every((t) => t._ref === true),
    '剧本骨架：' + skel.length + ' 轮且每轮都带 _ref 标记');
  const skelHtml = rCtx.__roundsHtml(skel, demoScene);
  ok(skelHtml.indexOf('服务端未提供逐轮明细') >= 0 && skelHtml.indexOf('学员作答：') >= 0,
    '骨架渲染明说"没有学员作答"（绝不伪装成真实作答）');
  ok(skelHtml.indexOf('<details class="refd" open>') >= 0, '骨架模式下参考表达默认展开');
  ok(skelHtml.indexOf('data-note-round="1"') >= 0, '每轮都有「针对这一轮写辅导」入口');

  const recForRender = (await SYNC.records()).filter((r) => r.turnCount > 0)[0];
  const realTurns = await SYNC.turns(recForRender.id);
  const realScene = T.sceneById(recForRender.sceneId);
  const realHtml = rCtx.__roundsHtml(realTurns, realScene);
  const escReal = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // ⚠️ 先把空作答剔掉再比：indexOf('') 恒为 0，留着会变成"永远为真"的假绿
  const nonEmpty = realTurns.filter((t) => !!t.learnerText);
  const shown = nonEmpty.filter((t) => realHtml.indexOf(escReal(t.learnerText)) >= 0).length;
  ok(nonEmpty.length === realTurns.length && shown === realTurns.length,
    '渲染结果逐字出现学员每一句作答（' + shown + '/' + realTurns.length + ' 轮）');
  ok(realHtml.indexOf('本轮 ' + realTurns[0].score + ' 分') >= 0 && realHtml.indexOf('学员作答：') >= 0,
    '每轮同时给出「学员作答」与「本轮得分」');
  ok(realHtml.indexOf('<details class="refd">') >= 0 && realHtml.indexOf('<details class="refd" open>') < 0,
    '有真实作答时参考表达默认收起（把版面让给学员的话）');
  ok(realHtml.indexOf(demoScene.objectives[0].text) >= 0, '每轮带上该轮训练目标');

  /* ------------------------------------------------------------ *
   * 3f. 审计翻页真接口往返（P9）：同步层 auditLog({limit,offset}) →
   *     服务端分页 → total/hasMore 如实回读。用相对断言，任何登录
   *     身份（mentor/dept/all）下都成立。
   * ------------------------------------------------------------ */
  sec('3f. 审计翻页往返（P9）');
  {
    const auA = await SYNC.auditLog({ limit: 30, offset: 0 });
    ok(!!auA && auA.ok && Array.isArray(auA.items),
      'auditLog({limit,offset}) 返回 {ok, items}（不再只是数组）');
    ok(auA && auA.items.length === Math.min(30, auA.total),
      '第一页条数 = min(limit, total)（' + (auA ? auA.items.length : 0) + '/' + (auA ? auA.total : 0) + '）');
    const auB = await SYNC.auditLog({ limit: 30, offset: 30 });
    const ia = (auA && auA.items || []).map((x) => x.id);
    const ib = (auB && auB.items || []).map((x) => x.id);
    ok(ia.length > 0 && ib.every((x) => ia.indexOf(x) < 0),
      '第二页与第一页无重叠（服务端排序稳定）');
    ok(!!auA && typeof auA.total === 'number' && auA.hasMore === (auA.items.length < auA.total),
      'total/hasMore 如实（hasMore=' + (auA ? auA.hasMore : '?') + '）');
  }

  /* ------------------------------------------------------------ *
   * 4. 关键接线断言（防止改漏）
   * ------------------------------------------------------------ */
  sec('4. 关键接线断言');
  const adminSrc = fs.readFileSync(path.join(ROOT, '管理后台-仿真培训.html'), 'utf8');
  const learnSrc = fs.readFileSync(path.join(ROOT, '仿真培训原型-微信风格.html'), 'utf8');
  const check = (src, re, msg) => ok(re.test(src), msg);
  check(adminSrc, /ADMIN_SYNC\.saveTask\(task\)/, '管理端 submitWizard 走服务端 saveTask');
  check(adminSrc, /function hydrateFromServer\(/, '管理端有 hydrateFromServer');
  check(adminSrc, /T\.helpers\.replaceInPlace\(/, '管理端通过数据源水合刷新口径');
  check(adminSrc, /ADMIN_SYNC\.taskStatus\(tid, status\)/, '管理端任务状态操作接服务端');
  check(adminSrc, /ADMIN_SYNC\.removeTask\(tid\)/, '管理端任务删除接服务端');
  check(adminSrc, /data-act="task-status"/, '任务抽屉有状态按钮');
  check(adminSrc, /if \(canSrvWrite\(\)\) \{\s*\n\s*ADMIN_SYNC\.saveTask/, '下发是「服务端优先、离线兜底」');
  check(learnSrc, /const ME = \(function\(\)/, '学员端有学员身份 ME');
  check(learnSrc, /function taskFeed\(\)/, '学员端有「我的任务」过滤');
  check(learnSrc, /assignees \|\| \[\]\)\.indexOf\(ME\) >= 0/, '「我的任务」按 assignees 含本人过滤');
  check(learnSrc, /taskId: curTaskId \|\| '',/, 'AI 轮次带 taskId');
  check(learnSrc, /learnerId: ME,/, 'AI 轮次带 learnerId');
  check(learnSrc, /AIBOOT\.tasks\(ME\)/, '学员端从服务端拉我的任务');
  check(learnSrc, /data-start-task/, '任务卡片有「开始训练」入口');
  check(learnSrc, /const passLine = curTaskPass \|\| curScene\(\)\.pass;/, '达标线支持任务覆盖场景默认值');
  check(fs.readFileSync(path.join(ROOT, 'assets/ai-bridge.js'), 'utf8'), /root\.AIBOOT = \{[\s\S]*?tasks: tasks,/, 'AIBOOT 导出 tasks()');

  /* ---- 学员端场景池热更新（P6） ---- */
  check(learnSrc, /function loadScenes\(\)/, '学员端有场景池热更新入口 loadScenes()');
  check(learnSrc, /AIBOOT\.scenes\(\)/, '学员端从服务端拉「已发布场景池」');
  check(learnSrc, /TRAIN\.helpers\.mergeScenes\(list\)/, '场景池走 mergeScenes 合并（不重排、不删除本地种子）');
  check(learnSrc, /if\(r\.added \|\| r\.updated\)\{[\s\S]{0,120}?initList\(\);[\s\S]{0,120}?renderTasks\(\);/,
    '只有确实有变化时才重渲染会话列表与任务卡');
  check(learnSrc, /^\s*loadScenes\(\);\s*$/m, 'loadScenes() 在页面启动时被调用（与 loadMyTasks 并列）');
  check(learnSrc, /sceneIds: SCENES\.map\(s => s\.id\)/, '无头探针暴露场景 id 序列（供 harness 断言）');
  check(aiBridgeSrc, /root\.AIBOOT = \{[\s\S]*?scenes: scenes,/, 'AIBOOT 导出 scenes()');
  check(aiBridgeSrc, /async function scenes\(\)[\s\S]{0,200}?\/scenes\/published/, 'scenes() 打的是 /scenes/published');
  // ⚠️ 必须用 `async function scenes()` 打头做锚点：tasks() 里有一段**一模一样**的
  //    `catch (e) { /* 静默降级到本地 */ }`，不锚定就会被它满足，变成永远为真的假绿断言
  //    （本断言写完后用"把 scenes() 的 catch 换成 throw"验证过会变红）。
  check(aiBridgeSrc, /async function scenes\(\)[\s\S]{0,600}?catch \(e\) \{ \/\* 静默降级到本地 \*\/ \}[\s\S]{0,80}?return null;/,
    'scenes() 失败时静默返回 null（不向调用方抛错）');
  // 否定断言：绝不允许整体替换 SCENES —— cur 是下标、SCENES[cur] 到处实时求值，
  // 换掉数组会让「当前会话」指向别的场景，而 SCENES[cur] 是本页唯一的场景读取路径。
  ok(!/\bSCENES\s*=/.test(learnSrc), '学员端不存在 SCENES 整体赋值（只能由数据源原地合并）');

  /* ---- 自主练习可见化 + 轻轮询（P8） ---- */
  // 教练台源码此时尚未声明 coachSrc0（P7 段才读），这里自己读一份
  const coachSrcP8 = fs.readFileSync(path.join(ROOT, '教练工作台-带教主管.html'), 'utf8');
  // 任务在身标记：bindTaskForScene（成绩归属）与 initList（列表标记）必须共用同一个
  // 查询口径 taskOfScene —— 两处各写一遍 filter，迟早一处改了另一处没改（硬约定 7 同源问题）。
  check(learnSrc, /function taskOfScene\(sceneId\)/, '学员端有「场景→我的任务」唯一查询口径 taskOfScene()');
  check(learnSrc, /function bindTaskForScene\(sceneId\)\{[\s\S]{0,120}?taskOfScene\(sceneId\)/,
    '成绩归属绑定复用 taskOfScene（口径不漂移）');
  check(learnSrc, /class="pill\$\{tk\?' on-task':''\}">\$\{tk\?'任务在身':'陪练'\}/,
    '会话列表区分「任务在身 / 陪练」标记');
  check(learnSrc, /--wx-taskpill-bg:#07C160; --wx-taskpill-fg:#FFFFFF;/,
    '「任务在身」浅色主题用品牌绿令牌（非散落硬编码）');
  check(learnSrc, /--wx-taskpill-bg:#3EB575; --wx-taskpill-fg:#111111;/,
    '「任务在身」深色主题用品牌绿深色值（手机双层主题都适配）');
  // 任务同步后要重建会话列表：否则运营新下发的任务到了，「任务在身」标记却不变
  check(learnSrc, /function loadMyTasks\(\)[\s\S]{0,500}?initList\(\);/,
    '任务同步成功后重建会话列表（标记随之更新）');
  // 60s 轻轮询：页面开着也能收到新发布场景与新任务，不必刷新；后台标签页不拉
  check(learnSrc, /setInterval\(function\(\)\{[\s\S]{0,160}?visibilityState === 'visible'[\s\S]{0,160}?loadScenes\(\); loadMyTasks\(\);[\s\S]{0,60}?\}, 60000\)/,
    '60s 轮询场景池与任务（仅页面可见时拉取）');
  // 管理端：free 成绩的任务名此前显示**空白**（task 查不到、taskId 是空串）
  check(adminSrc, /esc\(task \? task\.title : '自主练习'\)/,
    '管理端成绩标题对 free 记录显示「自主练习」（不再是空白）');
  check(adminSrc, /r\.mode === 'free' \? '<span class="tag">自主练习<\/span>' : ''/,
    'free 记录带「自主练习」来源 tag');
  check(adminSrc, /mode: r\.mode \|\| \(r\.taskId \? 'task' : 'free'\)/,
    '管理端水合保留服务端 mode（离线种子按同一口径推导）');
  // 教练台：option / 质检表 / 抽屉三处都要能看出这是自主练习
  check(coachSrcP8, /esc\(tk \? tk\.title : '自主练习'\)/,
    '教练台对 free 记录显示「自主练习」');
  check(coachSrcP8, /mode: r\.mode \|\| \(r\.taskId \? 'task' : 'free'\)/,
    '教练台水合保留服务端 mode');
  check(coachSrcP8, /（自主练习）/, '学员动态里标注「（自主练习）」来源');

  /* ---- 列表分页 + 审计翻页（P9） ---- */
  const syncSrcP9 = fs.readFileSync(path.join(ROOT, 'assets/admin-server-sync.js'), 'utf8');
  check(syncSrcP9, /async function auditLog\(query\)/, '同步层 auditLog 改收对象参数（{limit, offset}）');
  check(syncSrcP9, /total: d\.total \| 0, hasMore: !!d\.hasMore/,
    '同步层把服务端分页 meta（total/hasMore）带给调用方');
  check(adminSrc, /var AUDIT = \{ no: 1, size: 40, total: 0 \}/, '管理端有审计翻页状态 AUDIT');
  check(adminSrc, /ADMIN_SYNC\.auditLog\(\{ limit: AUDIT\.size, offset: \(AUDIT\.no - 1\) \* AUDIT\.size \}\)/,
    '审计卡片按页取数（offset = (页码-1)×页大小）');
  check(adminSrc, /data-act="audit-prev"/, '审计卡有「上一页」按钮');
  check(adminSrc, /data-act="audit-next"/, '审计卡有「下一页」按钮');
  check(adminSrc, /if \(AUDIT\.no < Math\.ceil\(AUDIT\.total \/ AUDIT\.size\)\)/,
    '下一页在逻辑层再拦一次越界（与按钮 disabled 双保险）');
  check(adminSrc, /if \(AUDIT\.no > pages\) AUDIT\.no = pages/, '当前页越界时收回最后一页');

  /* ---- P10：金标扩容 / 守护器 / 辅导记录检索 ---- */
  // 金标播种源：结构完整（空库首启播 30 条，新库与演示库同一份事实）
  // ⚠️ ok() 参数顺序是 (cond, msg)——与 selftest.js 相反，传反＝恒真假绿（本轮飞证抓出来的）
  {
    const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/store/goldset-seed.json'), 'utf8'));
    const items = gold.items || [];
    ok(items.length >= 30, '金标播种源 30 条（P10 扩容）——实际 ' + items.length + ' 条');
    const badGold = items.filter((g) => !g.id || !g.sceneId || !g.learnerText ||
      !g.humanScores || Object.keys(g.humanScores).length !== 5 || !g.note).map((g) => g.id || '(无id)');
    ok(badGold.length === 0, '每条金标带 id/场景/作答/五维分/标注理由（缺失：' + (badGold.join(',') || '无') + '）');
    const totals = items.map((g) => g.humanTotal).filter((v) => v != null);
    ok(totals.length === 0, '金标不预置 humanTotal（总分由播种/导入时按权重算，口径只有一处）——预置了 ' + totals.length + ' 条');
  }
  // 守护器：崩溃自动重启的几个关键设计点
  const daemonSrc = fs.readFileSync(path.join(ROOT, 'server/daemon.js'), 'utf8');
  check(daemonSrc, /taskkill \/PID \$\{pid\} \/T \/F/, '--stop 用进程树终止（不残留孤儿子进程）');
  check(daemonSrc, /Math\.min\(backoff \* 2, 30000\)/, '重启退避指数增长且封顶 30s（防崩溃风暴）');
  check(daemonSrc, /if \(code === 0\)/, '子进程正常退出不重启（端口被占的启动失败重启只会死循环）');
  check(daemonSrc, /env: Object\.assign\(\{\}, process\.env\)/, 'PORT/DB_FILE/AUTH_MODE 等环境变量原样透传给子进程');
  // 教练台：辅导记录检索（消费 P9 的 ?q=，服务端优先、本地兜底）
  const coachSrcP10 = fs.readFileSync(path.join(ROOT, '教练工作台-带教主管.html'), 'utf8');
  check(coachSrcP10, /function searchCoachNotes\(\)/, '教练台有跨学员辅导记录检索 searchCoachNotes()');
  check(coachSrcP10, /SYNC\.coachNotes\(\{ q: q \}\)/, '检索走服务端全文接口（P9 能力的真实消费端）');
  // ⚠️ 必须锚定到 then 分支的两行序列：catch 分支里还有一处一模一样的 localHit 调用，
  //    窗口式锚定（[\s\S]{0,140}?）也会被它挤进来满足——注入验证连抓两次。
  check(coachSrcP10, /if \(list\) \{ render\(list, 'server'\); return; \}\s*\n\s*render\(localHit\(\), 'local'\);/,
    '服务端返回 null 时在 then 分支回退本地缓存且如实标注来源');
  check(coachSrcP10, /id="noteSearch"/, '质检页有检索输入框');
  check(coachSrcP10, /if \(e\.key === 'Enter'\) searchCoachNotes\(\)/, '输入框支持回车检索');
  // 同步层：coachNotes 兼容两种参数形态
  check(syncSrcP9, /var o = \(query && typeof query === 'object'\) \? query : \{ learnerId: query \};/,
    'coachNotes 兼容字符串（按学员）与对象（{learnerId,q}）两种参数');
  check(syncSrcP9, /if \(o\.q\) qs\.push\('q=' \+ encodeURIComponent\(o\.q\)\);/, 'q 参数走 encodeURIComponent 并拼进查询串');

  /* ---- P11：本地语音识别（FunASR · SenseVoiceSmall） ---- */
  const aiBridgeP11 = fs.readFileSync(path.join(ROOT, 'assets/ai-bridge.js'), 'utf8');
  const voiceJsP11 = fs.readFileSync(path.join(ROOT, 'server/voice.js'), 'utf8');
  const indexJsP11 = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  // ai-bridge：能力探测三重门 + 三态契约
  check(aiBridgeP11, /function asrAvail\(\)[\s\S]{0,140}?state\.info\.voice\.asrOnline/,
    'ai-bridge 的 asrAvail() 读 /status 缓存的 voice.asrOnline（不是猜的）');
  check(aiBridgeP11, /async function asr\(blob\)[\s\S]{0,700}?catch \(e\) \{ \/\* 静默降级：调用方按 null 处理 \*\/ \}[\s\S]{0,40}?return null;/,
    'asr() 失败静默返回 null（绝不向页面抛错——铁律 8）');
  check(aiBridgeP11, /root\.AIBOOT = \{[\s\S]*?asr: asr, asrAvail: asrAvail,/, 'AIBOOT 导出 asr / asrAvail');
  // 学员端：真语音优先 + 原话术选择兜底（降级路径一个字不改）
  check(learnSrc, /function voiceCapable\(\)/, '学员端有浏览器录音能力探测 voiceCapable()');
  check(learnSrc, /AIBOOT\.asrAvail && AIBOOT\.asrAvail\(\)\)\{[\s\S]{0,60}?startRealVoice\(\);[\s\S]{0,20}?return;[\s\S]{0,30}?openSimSheet\(\)/,
    '「按住说话」真语音优先、原话术选择兜底（三重能力门）');
  check(learnSrc, /catch\(e\)\{[\s\S]{0,80}?toast2\('无法访问麦克风，改用话术选择'\);[\s\S]{0,60}?openSimSheet\(\);/,
    '麦克风被拒时如实提示并回退话术选择');
  check(learnSrc, /const r = await AIBOOT\.asr\(blob\);[\s\S]{0,200}?addMsg\('out', r\.text, \{voice: sec\}\);[\s\S]{0,60}?judge\(r\.text\);/,
    '识别成功按「话术选择」同一语义发出（语音条真实时长 + 判分）');
  check(learnSrc, /toast2\('语音识别失败/, '识别失败如实提示（可切换键盘），不假装成功');
  check(learnSrc, /function stopRealVoice\(\)/, '有 stopRealVoice()（录音浮层点击结束）');
  check(learnSrc, /id="recov" onclick="stopRealVoice\(\)"/, '录音浮层挂了结束事件');
  check(learnSrc, /\.vtoast\{position:fixed/, '语音链路有轻提示样式（不动已验收提示区）');
  // Node 侧：practice 档（学员匿名可用）+ 音频 raw body + 503 如实
  const asrRoute = indexJsP11.slice(indexJsP11.indexOf("on('POST', /^\\/api\\/v1\\/asr"));
  ok(asrRoute.length > 0 && asrRoute.slice(0, 520).indexOf("}, 'practice', { rawBody: true });") >= 0
    && asrRoute.slice(0, 520).indexOf('voice.transcribe') >= 0,
    '/asr 路由为 practice 档、声明 rawBody、走 voice.transcribe（学员没登录也能用语音——核心约束）');
  check(indexJsP11, /const isAudio = r\.rawBody \|\| \/\^audio\\\/\/\.test\(/,
    '音频请求按二进制读（路由声明 rawBody 优先、Content-Type 兜底——不走 JSON 解析）');
  check(voiceJsP11, /ok: false, error: '语音识别服务不可达', status: 503/,
    'ASR 服务不可达如实返回 503（不伪装成「识别为空」）');
  check(voiceJsP11, /asrOnline/, 'voice.js 有健康探测 asrOnline()');
  // MIME 表：缺 .webm 时浏览器 fetch 测试样本拿到 octet-stream、blob.type 丢 audio/ 前缀（真机踩过）
  check(indexJsP11, /'\.webm': 'audio\/webm'/, '静态服务的 MIME 表含 .webm（浏览器录音/测试样本正确下发音频类型）');

  /* ---- 逐轮对话（P7） ---- */
  // 这一节要用到三个页面/脚本源码：adminSrc 上面已读，另两个在下面的分节里才声明，
  // 所以这里单独读一份（同步层的 exportBlock 断言仍在下面用 syncSrc）。
  const syncSrc0 = fs.readFileSync(path.join(ROOT, 'assets/admin-server-sync.js'), 'utf8');
  const coachSrc0 = fs.readFileSync(path.join(ROOT, '教练工作台-带教主管.html'), 'utf8');
  const adminSrc0 = adminSrc;
  // ⚠️ turns() 与 scenes()/tasks() 的 catch 块长得**一模一样**，
  //    不锚定到函数头就会被上面那个满足，变成永远为真的假绿断言
  check(syncSrc0, /async function turns\(recordId\)[\s\S]{0,900}?catch \(e\) \{ \/\* 静默降级：调用方按 null 处理，绝不向调用方抛错 \*\/ \}[\s\S]{0,80}?return null;/,
    'turns() 失败时静默返回 null（不向调用方抛错）');
  check(syncSrc0, /root\.ADMIN_SYNC\s*=\s*\{[\s\S]*?turns: turns,/, '同步层导出 turns()');
  check(syncSrc0, /\/records\/' \+ encodeURIComponent\(id\) \+ '\/turns'/, 'turns() 打的是 /records/:id/turns');
  // 教练台：逐轮复盘必须是"学员真实作答"，不能继续只渲染场景剧本
  check(coachSrc0, /function scriptTurns\(/, '教练台有剧本骨架 scriptTurns()（离线兜底）');
  check(coachSrc0, /function roundsHtml\(turns, sc\)/, '教练台有统一的逐轮卡片渲染 roundsHtml()');
  check(coachSrc0, /function loadRounds\(rec, sc, hostId\)/, '教练台有按需加载 loadRounds()');
  check(coachSrc0, /SYNC\.turns\(rec\.id\)/, '教练台逐轮复盘打服务端逐轮接口');
  check(coachSrc0, /loadRounds\(rec, sc\);/, 'renderCoach 里确实调用了 loadRounds');
  check(coachSrc0, /_ref: true/, '剧本骨架带 _ref 标记（渲染时才能与真实作答区分开）');
  check(coachSrc0, /未连接服务端，下方为<b>场景剧本参考<\/b>，不是学员的真实作答/,
    '离线时明确标注"这是剧本参考、不是学员作答"（不许假装）');
  check(coachSrc0, /这条成绩没有保存逐轮对话/, '服务端明确答复"无逐轮记录"时如实说明（不说成加载失败）');
  check(coachSrc0, /function openQcDrawer\(rid\)/, '对话质检有展开对话的抽屉 openQcDrawer()');
  check(coachSrc0, /data-open-turns=/, '质检表有「看对话」入口');
  check(coachSrc0, /loadRounds\(r, sc, 'qcRounds'\)/, '质检抽屉同样加载真实逐轮明细');
  // 事件委托：loadRounds 是异步的，会整体替换 #coachRounds 的 innerHTML，
  // 渲染时用 forEach 绑的 onclick 会随旧节点丢弃（按钮点了没反应）。
  check(coachSrc0, /var nr = e\.target\.closest\('\[data-note-round\]'\)/, '「针对这一轮写辅导」走事件委托（异步重渲染后仍有效）');
  ok(!/\$\$\('#coachBody \[data-note-round\]'\)/.test(coachSrc0),
    '不再用 forEach 直接绑定 [data-note-round]（会随异步重渲染失效）');
  // 管理端：报告抽屉里能按需展开逐轮对话
  check(adminSrc0, /function toggleTurns\(rid\)/, '管理端有 toggleTurns()');
  check(adminSrc0, /ADMIN_SYNC\.turns\(rid\)/, '管理端打服务端逐轮接口');
  check(adminSrc0, /data-act="turns"/, '学员报告抽屉有「看逐轮对话」入口');
  check(adminSrc0, /id="turns-/, '报告抽屉为每条成绩预留逐轮容器');
  check(adminSrc0, /if \(act === 'turns'\) \{ toggleTurns/, '动作分发器接住了 turns 动作');

  /* ------------------------------------------------------------ *
   * 5. 学员端真实启动：把整页脚本放进沙箱跑一遍
   *
   *   第 3c 节只验到「能取回场景池并合并」；这一节验**最后一跳**——
   *   运营新发布一个场景后，学员端页面启动时会不会真的把它渲染进会话列表。
   *   这是「下发 → 学员练」闭环的终点，前面所有环节绿了但这里断了，
   *   现象就是"运营说发布了，学员就是看不到"。
   *
   *   没有浏览器、也不引入 jsdom：page 的 DOM 面很小（只用到
   *   getElementById / createElement / classList / dataset / innerHTML），
   *   给一组最小元素桩即可真实跑通初始化与渲染路径。
   * ------------------------------------------------------------ */
  sec('5. 学员端真实启动：新发布场景是否真的进会话列表（P6 闭环终点）');

  const PAGE_SCENE_ID = 'SC-HOTPUSH-1';
  const PAGE_SCENE_NAME = '自测临时场景·学员端热更新验证';

  // 先按真实流程把它发布出去：运营新建 → 提交 → 审核通过
  await SYNC.login('wangqian', 'op123456');
  const mk = await SYNC.save({
    id: PAGE_SCENE_ID, name: PAGE_SCENE_NAME, subtitle: '前端 harness 创建，跑完删除',
    avatarText: '热', color: '#5B9DF9', taskName: '热更新验证', channel: '微信文字',
    category: '破冰挖掘', difficulty: '入门', passLine: 62, duration: 8,
    brief: '用于验证学员端场景池热更新。',
    objectives: [{ text: '验证热更新', dim: 'd2' }],
    script: [{ t: '你好，我是新场景的客户。', v: 4 }],
    tips: ['测试提示'], voicePool: [['测试语音']]
  });
  const mkId = (mk.ok && mk.scene && (mk.scene.id || mk.scene.code)) || (mk.data && mk.data.id) || PAGE_SCENE_ID;
  ok(mk.ok, '运营新建场景' + (mk.ok ? '（id ' + mkId + '）' : '失败 · ' + mk.error));
  const sub1 = await SYNC.act(mkId, 'submit');
  ok(sub1.ok, '提交审核 → ' + (sub1.ok ? 'ok' : sub1.error));

  await SYNC.login('zhangtao', 'rev123456');
  const ap1 = await SYNC.act(mkId, 'approve');
  ok(ap1.ok, '审核通过 → ' + (ap1.ok ? 'ok' : ap1.error));

  // 审核后它必须已进入匿名场景池
  const pool3 = await BOOT.scenes();
  ok(!!pool3 && pool3.some((s) => s.id === mkId), '新发布场景已出现在匿名场景池');

  /* ---- 最小 DOM 桩：够跑通初始化与渲染，不做任何真实布局 ---- */
  const elCache = new Map();
  const makeEl = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, hidden: false,
    scrollTop: 0, offsetHeight: 0,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    getAttribute() { return null; }, setAttribute() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}
  });
  const domDoc = {
    readyState: 'complete',
    documentElement: { dataset: {} },
    body: makeEl('body'),
    getElementById(id) { if (!elCache.has(id)) elCache.set(id, makeEl(id)); return elCache.get(id); },
    createElement(tag) { return makeEl('<' + tag + '>'); },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  };

  const pageCtx = {
    localStorage: ls,
    location: { search: '', protocol: 'http:', origin: 'http://127.0.0.1:8848', href: BASE + '/仿真培训原型-微信风格.html' },
    document: domDoc,
    navigator: { userAgent: 'node-harness' },
    console: { log() {}, warn() {}, error() {} },
    fetch, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Promise, Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    alert() {}, confirm() { return true; }
  };
  vm.createContext(pageCtx);
  pageCtx.window = pageCtx;      // 页面脚本直接写 window.XXX，沙箱里要指向全局
  pageCtx.addEventListener = () => {};

  const pageScripts = [...learnSrc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let pageErr = null;
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/app-data.js'), 'utf8'), pageCtx, { filename: 'app-data.js' });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'data/scoring-engine.js'), 'utf8'), pageCtx, { filename: 'scoring-engine.js' });
    vm.runInContext(aiBridgeSrc, pageCtx, { filename: 'ai-bridge.js' });
    pageScripts.forEach((s, i) => vm.runInContext(s, pageCtx, { filename: '学员端#' + i }));
  } catch (e) { pageErr = e; }
  ok(!pageErr, '学员端整页脚本能在沙箱里跑完初始化' + (pageErr ? ' — ' + pageErr.message : ''));

  // loadScenes() 是异步的（页面刻意不 await，避免阻塞首屏），这里等它落地
  await new Promise((r) => setTimeout(r, 1200));

  const probe = pageCtx.window.__LRN;
  const lrn = typeof probe === 'function' ? probe() : null;
  ok(!!lrn, '页面暴露了 __LRN() 探针');
  ok(!!lrn && lrn.sceneIds.indexOf(mkId) !== -1,
    '新发布场景已进入学员端场景库：' + (lrn ? lrn.sceneIds.join(',') : 'n/a'));
  ok(!!lrn && lrn.sceneCount === lrn.sceneIds.length && lrn.sceneCount > 3,
    '场景数由种子 3 个增长到 ' + (lrn ? lrn.sceneCount : 'n/a') + ' 个');
  const listHtml = domDoc.getElementById('convList').innerHTML;
  ok(listHtml.indexOf(PAGE_SCENE_NAME) !== -1,
    '会话列表里渲染出了新场景「' + PAGE_SCENE_NAME + '」');
  ok(listHtml.indexOf('张经理') !== -1, '原有种子场景仍在列表里（热更新没有清掉本地种子）');

  /* P8：任务在身标记 —— L01 的进行中任务（T01→s1、T02→s2）对应场景必须渲染出
   * on-task 实底标记，其余场景保持「陪练」标。断言数关系而不是写死 2，
   * 演示任务怎么改都不影响这条断言的有效性。 */
  const taskScenes = lrn ? Array.from(new Set(lrn.myTaskScenes || [])) : [];
  const onTaskCount = (listHtml.match(/on-task/g) || []).length;
  const pillCount = (listHtml.match(/class="pill/g) || []).length;
  ok(taskScenes.length > 0, 'L01 有进行中任务对应的场景（' + taskScenes.length + ' 个，标记可验证）');
  ok(onTaskCount === taskScenes.length,
    'on-task 标记数 === 有任务场景数（' + onTaskCount + ' vs ' + taskScenes.length + '）');
  ok(pillCount === lrn.sceneCount,
    '每个场景都有来源标记（pill ' + pillCount + ' 个 / 场景 ' + lrn.sceneCount + ' 个）');

  // 收尾：下线并删除临时场景，保证自测可重复运行
  // ⚠️ 下线（offline）走 assertCanReview，运营没有审核权 → 必须用审核员身份；
  //    而删除走 assertCanEdit，运营即可。这是有意的权限分离，别图省事混用。
  const off1 = await SYNC.act(mkId, 'offline');
  ok(off1.ok, '临时场景已下线（审核员身份）→ ' + (off1.ok ? 'ok' : off1.error));
  const pool4 = await BOOT.scenes();
  ok(!!pool4 && !pool4.some((s) => s.id === mkId), '下线后立刻从匿名场景池消失');
  await SYNC.login('wangqian', 'op123456');
  const del1 = await SYNC.remove(mkId);
  ok(del1.ok, '临时场景已删除 → HTTP ' + del1.status);

  /* ---- 教练台（P5） ---- */
  const coachSrc = fs.readFileSync(path.join(ROOT, '教练工作台-带教主管.html'), 'utf8');
  check(coachSrc, /<script src="assets\/admin-server-sync\.js"><\/script>/, '教练台引入了服务端同步层');
  check(coachSrc, /var SYNC = window\.ADMIN_SYNC \|\| null;/, '教练台以可选加载方式取同步层（离线不为空指针）');
  check(coachSrc, /SYNC\.me\(\)/, '教练台读取服务端身份');
  check(coachSrc, /IDENT\.staffName \|\| COACH/, '教练台用「干净姓名」筛选本人带教（不是带前缀的展示名）');
  check(coachSrc, /function hydrateFromServer\(\)/, '教练台有 hydrateFromServer');
  check(coachSrc, /H\.replaceInPlace\(/, '教练台通过数据源水合刷新口径');
  check(coachSrc, /SCOPE_KIND === 'mentor'[\s\S]*?allBtn\.hidden = true/, 'mentor 范围下隐藏「全部学员」档（界面不比权限大）');
  check(coachSrc, /if \(b\.hidden\) return;/, '范围切换再做一次拦截，防止切到未授权的档位');
  check(coachSrc, /SYNC\.coachNotes\(\)/, '教练台从服务端加载辅导记录');
  check(coachSrc, /SYNC\.addCoachNote\(note\)/, '辅导记录写入服务端');
  check(coachSrc, /SYNC\.removeCoachNote\(id\)/, '辅导记录可从服务端删除');
  check(coachSrc, /data-del-note=/, '辅导记录有删除入口');
  check(coachSrc, /SYNC\.qcList\(\)/, '教练台从服务端加载质检结论');
  check(coachSrc, /SYNC\.setQc\(rid, state\)/, '质检结论写入服务端');
  check(coachSrc, /SYNC\.clearQc\(rid\)/, '质检结论可从服务端撤销');
  check(coachSrc, /data-qc-clear=/, '质检表有「撤销」入口');
  check(coachSrc, /TRAIN_COACH_NOTES_V1/, '辅导记录有离线兜底缓存');
  check(coachSrc, /服务端拒绝：/, '服务端拒绝时如实提示（不静默失败）');
  // 否定断言：check() 要的是 RegExp，这里直接判布尔（否则 re.test 不是函数）
  ok(!/记录只保存在本次会话/.test(coachSrc), '「只保存在本次会话」的旧提示已移除');
  ok(!/by: '周敏'/.test(coachSrc), '辅导记录不再硬编码记录人');

  // 契约断言：页面调用的每个 SYNC.xxx 都必须在同步层的导出块里真的存在。
  // 这是"同类对象跨文件流转必须锁死字段集"的落地 —— 页面里只写方法名字符串，
  // 拼错了语法检查查不出来，要等运行时才炸。
  // ⚠️ 本文件的 ok 是 (cond, msg)，与 selftest.js 的 (name, cond) 参数顺序相反，
  //    传反了会变成"永远为真"的假绿断言。
  const syncSrc = fs.readFileSync(path.join(ROOT, 'assets/admin-server-sync.js'), 'utf8');
  const exportBlock = (syncSrc.match(/root\.ADMIN_SYNC\s*=\s*\{[\s\S]*?\};/) || [''])[0];
  [['教练台', coachSrc], ['管理端', adminSrc]].forEach(([who, src]) => {
    const called = [...new Set([...src.matchAll(/SYNC\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))];
    const missing = called.filter((n) => !new RegExp('(^|[^A-Za-z0-9_])' + n + '\\s*[:,]').test(exportBlock));
    ok(called.length > 0 && missing.length === 0,
      who + '调用的 ' + called.length + ' 个同步方法都在导出块里（缺失：' + (missing.join(',') || '无') + '）');
  });

  console.log('\n' + '='.repeat(72));
  console.log('P7 前端接入验证：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
