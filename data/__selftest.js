/* ------------------------------------------------------------------ *
 * 评分引擎单元测试（node 直跑，无依赖）
 *   node data/__selftest.js
 * 覆盖：基础命中 / 单维上限 / 目标加成 / 通话路径补差 /
 *       detectHits / scoreSession / suggestionsFor 形状 / compareWithHistory
 * ------------------------------------------------------------------ */
'use strict';

var w = {}; w.window = w; global.window = w;
require('./app-data.js');
var S = require('./scoring-engine.js');
var TRAIN = w.TRAIN;

var pass = 0, fail = 0, failures = [];
function eq(name, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; failures.push(name + ' → got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}
function ok(name, cond) { eq(name, !!cond, true); }

function fresh() { return { d1: 42, d2: 42, d3: 42, d4: 42, d5: 42 }; }
var KW = TRAIN.kw, DIMS = TRAIN.dims;
// 能命中「开场与礼貌 d1」的一句
var D1_TEXT = '您好，很荣幸为您服务';

/* 1. 基础：命中一维 +13 */
var st = fresh();
S.scoreTurn(D1_TEXT, { state: st, kw: KW, dims: DIMS });
eq('基础命中 d1 = 42+13', st.d1, 55);
eq('未命中维度不变', st.d2, 42);

/* 2. 单维上限 97 */
st = fresh(); st.d1 = 90;
S.scoreTurn(D1_TEXT, { state: st, kw: KW, dims: DIMS });
eq('d1 触顶 97', st.d1, 97);

/* 3. 目标达成 +6（且必须命中该目标维度） */
st = fresh();
var r = S.scoreTurn(D1_TEXT, { state: st, kw: KW, dims: DIMS, objectiveDim: 'd1' });
eq('objectiveMet 为真', r.objectiveMet, true);
eq('目标加成后 d1 = 42+13+6', st.d1, 61);

st = fresh();
r = S.scoreTurn('这句话跟任何关键词都不沾边', { state: st, kw: KW, dims: DIMS, objectiveDim: 'd1' });
eq('未命中则目标不达成', r.objectiveMet, false);
eq('未命中不加分', st.d1, 42);

/* 3b. noObjectiveBonus 关闭加成 */
st = fresh();
S.scoreTurn(D1_TEXT, { state: st, kw: KW, dims: DIMS, objectiveDim: 'd1', noObjectiveBonus: true });
eq('noObjectiveBonus 时不加 6', st.d1, 55);

/* 4. 通话路径：+9 替代 +13（补差，非叠加） */
st = fresh();
S.scoreTurn(D1_TEXT, { state: st, kw: KW, dims: DIMS, inCall: true, noObjectiveBonus: true });
eq('通话路径 d1 = 42+9 = 51', st.d1, 51);

/* 4b. 已在 55 的维度在通话里补到 51？——不应倒退，取 max */
st = fresh(); st.d1 = 55;
S.scoreTurn(D1_TEXT, { state: st, kw: KW, dims: DIMS, inCall: true, noObjectiveBonus: true });
ok('通话路径不使已有分倒退', st.d1 >= 55);

/* 5. detectHits */
ok('detectHits 命中 d1', S.detectHits(D1_TEXT, KW, ['d1']).indexOf('d1') !== -1);
eq('detectHits 无命中返回空数组', S.detectHits('毫不相关的句子', KW, ['d1']), []);

/* 6. scoreSession 全流程 */
var sess = {
  scenes: null,
  turns: [
    { text: D1_TEXT, objectiveDim: 'd1' },
    { text: '您好，很荣幸为您服务', objectiveDim: 'd1' }
  ],
  kw: KW, dims: DIMS
};
var sr = S.scoreSession(sess);
ok('scoreSession 返回 dimScores', !!(sr && sr.dimScores && typeof sr.dimScores.d1 === 'number'));
ok('scoreSession 返回 score', typeof sr.score === 'number');
ok('scoreSession.metCount 为数字', typeof sr.metCount === 'number');
ok('scoreSession.turns 计数正确', sr.turns === 2);

/* 7. suggestionsFor 形状与鲁棒性（关键：入参放宽、出参恒定） */
var weak = S.scoreSession({
  turns: [{ text: '毫不相关', objectiveDim: 'd2' }],
  kw: KW, dims: DIMS
}).weakDims;
var sugg = S.suggestionsFor(weak, DIMS);
ok('suggestionsFor 非空', sugg.length > 0);
ok('suggestionsFor[0].tip 非空', !!(sugg[0] && sugg[0].tip));
ok('suggestionsFor[0].name 非空', !!(sugg[0] && sugg[0].name));
ok('suggestionsFor[0].dimId 非空', !!(sugg[0] && sugg[0].dimId));
eq('suggestionsFor 出参字段集恒定',
   Object.keys(sugg[0]).sort(), ['dim', 'dimId', 'name', 'score', 'tip']);

// 直接喂 {dim:'需求挖掘'} 这种只有名称的形状，也应能解出 tip
var suggByName = S.suggestionsFor([{ dim: '需求挖掘', score: 50 }], DIMS);
ok('suggestionsFor 支持按名称入参', !!(suggByName[0] && suggByName[0].tip));
eq('suggestionsFor 按名称也能解出 dimId', suggByName[0].dimId, 'd2');

// 空输入不炸
eq('suggestionsFor 空输入返回空数组', S.suggestionsFor([], DIMS), []);
eq('suggestionsFor undefined 不报错', S.suggestionsFor(undefined, DIMS), []);

/* 8. compareWithHistory */
var c0 = S.compareWithHistory({ score: 70 }, []);
eq('首次练习 trend=first', c0.trend, 'first');
var c1 = S.compareWithHistory({ score: 80 }, [60, 70]);
eq('进步 trend=up', c1.trend, 'up');
ok('进步 delta > 0', c1.delta > 0);
var c2 = S.compareWithHistory({ score: 50 }, [60, 70]);
eq('退步 trend=down', c2.trend, 'down');
ok('退步 delta < 0', c2.delta < 0);

/* 9. 常量存在性 */
ok('导出 DEFAULTS', !!(S.DEFAULTS && S.DEFAULTS.base === 42));
ok('导出 DIM_ORDER', Array.isArray(S.DIM_ORDER) && S.DIM_ORDER.length === 5);
ok('DEFAULTS.hitBonus=13', S.DEFAULTS.hitBonus === 13);
ok('DEFAULTS.objectiveBonus=6', S.DEFAULTS.objectiveBonus === 6);
ok('DEFAULTS.callBonus=9', S.DEFAULTS.callBonus === 9);

/* 输出 */
console.log('评分引擎自测：PASS ' + pass + ' / FAIL ' + fail);
if (fail) {
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('  ✓ 全部通过');
