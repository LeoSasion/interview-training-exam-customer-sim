#!/usr/bin/env node
'use strict';
/**
 * 软著申请：用户手册生成器（P25）
 *
 * 版权中心对用户手册的要求：
 *   - 前 30 页 + 后 30 页（不足 60 页则全部提交，实务上 15~25 页更常见）
 *   - 页眉：软件名称 + 版本号
 *   - 内容：软件概述、运行环境、安装步骤、功能操作说明（配界面截图）
 *
 * 产出：docs/软著/用户手册.pdf
 *
 *   node tools/gen-copyright-manual.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', '软著');
const SHOTS = path.join(OUT_DIR, 'shots');
const NAME = '新员工仿真培训系统';
const VERSION = 'V1.0';

const shot = (f) => {
  const p = path.join(SHOTS, f);
  if (!fs.existsSync(p)) return '';
  // 转成 data URI，避免 Chrome 打印时相对路径失效
  const b64 = fs.readFileSync(p).toString('base64');
  return '<figure><img src="data:image/png;base64,' + b64 + '"><figcaption>' + f.replace(/^\d+-/, '').replace(/\.png$/, '') + '</figcaption></figure>';
};

const H = (n, t) => '<h2>' + n + '　' + t + '</h2>';
const h3 = (n, t) => '<h3>' + n + '　' + t + '</h3>';
const p = (t) => '<p>' + t + '</p>';
const ul = (items) => '<ul>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>';
const table = (rows) => '<table>' + rows.map((r, i) => '<tr>' + r.map((c) => (i === 0 ? '<th>' + c + '</th>' : '<td>' + c + '</td>')).join('') + '</tr>').join('') + '</table>';

const content = `
<!-- 封面 -->
<section class="cover">
  <div class="cv-kicker">计算机软件著作权登记 · 用户手册</div>
  <h1>${NAME}</h1>
  <div class="cv-ver">${VERSION}</div>
  <div class="cv-rule"></div>
  <dl class="cv-meta">
    <dt>软件名称</dt><dd>${NAME}</dd>
    <dt>版本号</dt><dd>${VERSION}</dd>
    <dt>文档名称</dt><dd>用户操作手册</dd>
    <dt>著作权人</dt><dd>____________________（请填写单位全称，须与营业执照一致）</dd>
    <dt>编制日期</dt><dd>____________________</dd>
  </dl>
</section>

<!-- 目录 -->
<section class="toc">
  <h1 class="toc-t">目　录</h1>
  <ol>
    <li>软件概述<span>1</span></li>
    <li>运行环境<span>2</span></li>
    <li>安装与启动<span>3</span></li>
    <li>学员端功能说明<span>4</span></li>
    <li>教练工作台功能说明<span>8</span></li>
    <li>运营管理后台功能说明<span>12</span></li>
    <li>常见问题<span>18</span></li>
  </ol>
</section>

<!-- 一 -->
<section>
  ${H('一、', '软件概述')}
  ${h3('1.1', '用途')}
  ${p('本软件面向连锁零售企业的新员工入职培训场景，以「微信聊天式人机对练」的方式训练销售话术：学员在仿真的微信对话界面中应对由 AI 扮演的刁难客户，系统对每一轮回复实时评分，训练结束后生成五维能力报告，供学员自查、带教主管辅导与运营部门统计。')}
  ${p('相比集中授课与角色扮演，本软件的价值在于：练习可无限次重复、评分口径统一、过程数据可留存，带教主管不必到场即可看到每位新人的短板。')}

  ${h3('1.2', '适用对象')}
  ${ul([
    '新入职销售人员：完成入职培训的话术对练任务；',
    '带教主管 / 店长：查看本组学员进度与短板，撰写辅导记录、做对话质检；',
    '运营 / 培训部门：下发训练任务、维护训练场景、统计整体达标情况。'
  ])}

  ${h3('1.3', '主要功能')}
  ${table([
    ['功能模块', '说明'],
    ['场景陪练', 'AI 扮演客户，按预设剧本逐轮发难；学员可打字或按住说话（语音在本机转文字）'],
    ['实时评分', '每轮回复从五个维度打分，并标注是否命中本轮考察点，给出参考话术'],
    ['训练报告', '综合得分、五维能力、逐句点评、与上一场同场景对比、下一步练习建议'],
    ['任务下发', '运营选择场景与学员批量下发，可设达标线与截止时间，学员端即时收到'],
    ['场景库', '场景的增删改、版本留痕、提交审核、审批发布、下线；仅已发布场景可下发'],
    ['辅导与质检', '带教主管撰写辅导记录（学员端可见）、标记对话质检结论、手工修正分数'],
    ['数据分析', '练习场次、平均分、达标率、风险分层、部门对比，支持按人员范围隔离']
  ])}

  ${h3('1.4', '系统角色与数据可见范围')}
  ${table([
    ['角色', '可做操作', '数据范围'],
    ['学员', '练习、查看本人报告与带教留言', '仅本人'],
    ['带教主管（教练）', '查看本组学员、辅导、质检', '本人带教的学员'],
    ['部门主管', '查看本部门学员与统计', '本部门'],
    ['运营管理员', '场景维护、任务下发、全局统计', '全部'],
    ['系统管理员', '账号与权限、审计日志', '全部']
  ])}
</section>

<!-- 二 -->
<section>
  ${H('二、', '运行环境')}
  ${h3('2.1', '服务端')}
  ${table([
    ['项目', '要求'],
    ['操作系统', 'Windows 10/11、macOS 12+、主流 Linux 发行版'],
    ['运行环境', 'Node.js 22 及以上（内置 SQLite 驱动，无需另装数据库）'],
    ['内存', '建议 2 GB 以上；100 人规模实测占用约 200 MB'],
    ['磁盘', '程序约 5 MB，数据库随练习量增长（每条成绩约 2 KB）'],
    ['网络', '局域网即可；如需外部访问建议部署在 HTTPS 之后']
  ])}
  ${h3('2.2', '客户端')}
  ${p('学员端与后台均为纯网页，无需安装客户端。推荐使用 Chrome、Edge 或任何支持 ES2020 的现代浏览器；移动端可直接用手机浏览器访问，界面按手机尺寸自适应。')}
  ${p('语音输入依赖浏览器录音权限，需在首次使用时允许麦克风访问；不建议使用 IE 及已停止维护的旧版浏览器。')}
</section>

<!-- 三 -->
<section>
  ${H('三、', '安装与启动')}
  ${h3('3.1', '安装')}
  ${p('本软件为绿色部署：解压即用，无安装程序、无外部依赖（数据库、Web 服务均已内置）。')}
  ${ul([
    '将程序包解压至任意目录（路径中不建议包含空格）；',
    '确认已安装 Node.js 22 或以上版本（命令行执行 node -v 可查看版本）；',
    '无需执行依赖安装命令，程序不含第三方运行库。'
  ])}

  ${h3('3.2', '启动服务')}
  ${p('在程序目录下双击 start-server.bat（Windows）或在终端执行 node server/index.js，看到以下提示即启动成功：')}
  ${p('<code>服务已启动 · http://127.0.0.1:8848</code>')}
  ${p('如需同时启用语音识别与模拟评分服务，可双击 start-all.bat 一次性启动全部组件。')}

  ${h3('3.3', '访问地址')}
  ${table([
    ['入口', '地址', '说明'],
    ['产品总览', 'http://127.0.0.1:8848/', '各端入口与说明'],
    ['学员端', 'http://127.0.0.1:8848/仿真培训原型-微信风格.html', '学员练习界面'],
    ['教练工作台', 'http://127.0.0.1:8848/教练工作台-带教主管.html', '带教主管使用'],
    ['运营后台', 'http://127.0.0.1:8848/管理后台-仿真培训.html', '运营 / 培训部门使用']
  ])}
  ${p('首次使用需在后台登录。演示环境预置账号：管理员 admin，初始密码见部署说明，正式使用前请立即修改。')}
</section>

<!-- 四 -->
<section>
  ${H('四、', '学员端功能说明')}
  ${p('学员端采用微信风格的对话界面，学员无需学习即可上手。页面分为三栏：左侧为本次训练任务与训练目标，中间为手机样式的微信对话区，右侧为「我的任务」与能力评分。')}
  ${shot('01-学员端-会话列表.png')}

  ${h3('4.1', '开始一次练习')}
  ${ul([
    '在左侧「本次训练任务」卡片查看任务名称、对应场景、达标线与截止时间；',
    '点击卡片下方的「开始练习」按钮，系统直接进入该任务对应的客户会话；',
    '也可在中间会话列表中选择任意客户进行自主练习（会话右侧标注「任务在身」或「陪练」）。'
  ])}

  ${h3('4.2', '对话练习')}
  ${p('进入会话后，AI 客户按预设剧本逐轮发起对话。学员可采取两种方式回复：')}
  ${ul([
    '文字回复：在底部输入框输入内容后点击发送；',
    '语音回复：按住话筒按钮说话，松开后录音在本机完成转写并填入输入框，确认后发送（录音不上传服务器）。'
  ])}
  ${p('每轮回复提交后，系统即时给出该轮的维度得分与「是否命中本轮考察点」的判断，并提示参考表达。左侧「训练目标」清单会随命中情况自动打勾。')}
  ${shot('02-学员端-对话练习.png')}

  ${h3('4.3', '查看训练报告')}
  ${p('完成全部轮次后自动生成报告，包含：')}
  ${ul([
    '综合得分与是否达到达标线；',
    '五维能力得分（开场与礼貌、需求挖掘、异议处理、方案讲解、促成推进）与逐维评语；',
    '与上一场同一场景的对比，标示各维度上升、持平或下降；',
    '逐句点评：列出客户原话、你的回复，并说明本轮考察点是什么、对应哪项能力；',
    '能力画像雷达图与全部练习均分，虚线为团队均值；',
    '下一步练习建议。'
  ])}
  ${shot('03-学员端-训练报告.png')}

  ${h3('4.4', '带教留言与我的成长')}
  ${p('右侧「带教留言」展示带教主管撰写的辅导记录（按时间倒序，最多三条）。「我的成长」按入职天数推算当前所处阶段、该阶段的重点能力与目标分，并给出一句下一步建议。两项内容均随练习与辅导实时更新。')}
</section>

<!-- 五 -->
<section>
  ${H('五、', '教练工作台功能说明')}
  ${p('带教主管登录后进入工作台，只能看到自己带教的学员（部门主管看本部门、管理员看全部），避免越权查看。')}
  ${shot('04-教练台-工作总览.png')}

  ${h3('5.1', '工作总览')}
  ${p('首页按「今天该做什么」组织信息：')}
  ${ul([
    '今日待办：逾期未提交、临近截止、高风险学员，每条都写明原因与涉及人员；',
    '关键指标：本组达标率、平均分、待辅导人数、本周练习场次；',
    '风险分层：按红/黄/绿三档列出学员，红色为连续低分或长期未练；',
    '成长阶段分布：本组学员当前处于第几周 / 第几月，便于安排辅导重点。'
  ])}

  ${h3('5.2', '学员清单与辅导')}
  ${p('「学员清单」可按姓名搜索、按风险筛选。每行显示部门岗位、带教人、练习次数、平均分、最近趋势与操作入口。点击任意一行打开学员抽屉。')}
  ${shot('05-教练台-学员清单.png')}
  ${p('抽屉内含：能力雷达与历史成绩曲线、逐轮对话回看、成长阶段与重点维度、带教留言撰写框。撰写的辅导记录会同步到学员端的「带教留言」，形成辅导闭环。')}
  ${p('对于判断有偏差的自动评分，主管可在对话回看中手工修正分数，系统保留原分与修正原因，可随时撤销。')}

  ${h3('5.3', '对话质检')}
  ${p('质检用于发现「AI 客服话术或评分规则不合理」的问题：主管可把某条成绩标记为正常或异常并附说明，标记为异常的对话会进入「待建场景池」，由运营认领后补充为新训练场景。')}
</section>

<!-- 六 -->
<section>
  ${H('六、', '运营管理后台功能说明')}
  ${p('运营 / 培训部门使用后台完成「场景 → 任务 → 统计」的日常闭环。')}
  ${shot('06-运营端-数据看板.png')}

  ${h3('6.1', '数据看板')}
  ${p('看板给出整体练习量、平均分、达标率、高风险人数，并为每项指标附「本周 vs 上周」的对照，避免孤立数字无法判断好坏。下方按部门与风险分布展示，可直接点入对应明细。')}

  ${h3('6.2', '任务下发')}
  ${p('下发采用四步向导：选择训练场景 → 勾选学员 → 填写任务名称 / 达标线 / 截止时间 → 确认下发。系统会记住上一次的场景与参数，例行下发时无需重复填写。')}
  ${shot('07-运营端-任务下发.png')}
  ${p('注意：只有「已发布」状态的场景才可下发。已发布的场景一旦被修改，会自动退回待审核状态，需重新审批后方能再次下发。')}

  ${h3('6.3', '场景库与场景编辑')}
  ${p('场景库列出全部训练场景及其训练目标、剧本轮次、审批状态与版本号，支持新建、复制、下线与删除。场景内容包含：客户人设、逐轮剧本、每轮考察点（对应能力维度）、参考话术。')}
  ${shot('08-运营端-场景库.png')}
  ${p('场景修改保存后自动生成新版本，可随时回滚到历史版本。内容治理规则：编辑者提交审核，审核人不能是提交人本人，审批通过后才发布。')}

  ${h3('6.4', '学员报告与名单管理')}
  ${p('学员报告按成绩明细列出每位学员每场练习的分数、达标情况、场景与时间，可按部门、风险、关键词筛选，并支持导出。')}
  ${shot('09-运营端-学员报告.png')}
  ${p('学员名单支持 CSV 批量导入（姓名、部门、岗位、带教人为必填），同名同部门自动跳过；删除学员时若已有成绩将拒绝删除，避免产生无主数据。')}
</section>

<!-- 七 -->
<section>
  ${H('七、', '常见问题')}
  ${h3('7.1', '页面能打开，但点击按钮没有反应')}
  ${p('多为浏览器拦截了弹窗或脚本未加载完成。请刷新页面后重试；若在第三方预览器（如某些文档阅读器的内嵌网页）中打开，建议改用独立浏览器窗口访问。')}

  ${h3('7.2', '语音按钮无法使用')}
  ${p('请确认已允许浏览器使用麦克风，且语音识别服务已启动（start-all.bat）。若服务未启动，系统会自动降级为文字输入，练习不受影响。')}

  ${h3('7.3', '评分与人工判断不一致')}
  ${p('当前评分可通过两种通道完成：接入大模型时为 AI 评分，未接入时使用内置关键词引擎。带教主管可在对话回看中手工修正分数并说明原因，修正记录会保留原分，可撤销。')}

  ${h3('7.4', '服务重启后数据是否还在')}
  ${p('所有场景、任务、成绩、辅导记录均保存在程序目录下的 SQLite 数据文件中，重启不会丢失。建议定期备份该文件。')}

  ${h3('7.5', '多名学员同时练习是否卡顿')}
  ${p('系统采用单进程轻量架构，练习过程以本地交互为主，服务器仅承担数据存取。百人规模内的日常使用无明显压力；如需更大并发，建议将数据文件迁移至独立数据库并增加进程数。')}
</section>
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${NAME} ${VERSION} 用户手册</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #fff; color: #1a1a1a;
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 10.5pt; line-height: 1.75;
  }
  section { padding: 20mm 20mm 22mm; page-break-after: always; position: relative; }
  section:last-child { page-break-after: auto; }
  /* 页眉页码：用每个 section 的伪元素近似（Chrome 打印不支持 @page 页码计数器） */
  section::before {
    content: "${NAME} ${VERSION}  用户手册";
    position: absolute; top: 9mm; left: 0; right: 0; text-align: center;
    font-size: 8.5pt; color: #888; letter-spacing: .02em;
  }
  h1 { font-size: 20pt; font-weight: 600; margin: 0 0 6mm; letter-spacing: -.01em; }
  h2 { font-size: 14pt; font-weight: 600; margin: 0 0 5mm; padding-bottom: 2.5mm;
       border-bottom: 1.2pt solid #07C160; color: #111; }
  h3 { font-size: 11.5pt; font-weight: 600; margin: 6mm 0 2.5mm; color: #222; }
  p { margin: 0 0 3mm; text-align: justify; }
  ul { margin: 0 0 3mm; padding-left: 5mm; }
  li { margin-bottom: 1.6mm; }
  table { width: 100%; border-collapse: collapse; margin: 3mm 0 4mm; font-size: 9.5pt; }
  th, td { border: .6pt solid #d0d0d0; padding: 2mm 2.5mm; text-align: left; vertical-align: top; }
  th { background: #f4f6f5; font-weight: 600; }
  code { background: #f2f2f2; padding: .4mm 1.4mm; border-radius: 1mm; font-size: 9.5pt;
         font-family: Consolas, monospace; }
  figure { margin: 3mm 0 4mm; text-align: center; page-break-inside: avoid; }
  figure img { width: 100%; border: .6pt solid #ddd; border-radius: 1.5mm; }
  figcaption { font-size: 8.5pt; color: #888; margin-top: 1.5mm; }

  /* 封面 */
  .cover { display: flex; flex-direction: column; justify-content: center; padding: 42mm 24mm; }
  .cover::before { content: none; }
  .cv-kicker { font-size: 9.5pt; color: #07C160; letter-spacing: .18em; margin-bottom: 8mm; }
  .cover h1 { font-size: 30pt; line-height: 1.25; margin: 0 0 4mm; }
  .cv-ver { font-size: 15pt; color: #666; letter-spacing: .06em; }
  .cv-rule { width: 26mm; height: 1.4mm; background: #07C160; margin: 10mm 0; border-radius: 1mm; }
  .cv-meta { display: grid; grid-template-columns: 30mm 1fr; gap: 3mm 4mm; font-size: 10pt; margin: 0; }
  .cv-meta dt { color: #888; }
  .cv-meta dd { margin: 0; }

  /* 目录 */
  .toc::before { content: none; }
  .toc-t { font-size: 18pt; text-align: center; margin-bottom: 10mm; }
  .toc ol { list-style: none; counter-reset: t; padding: 0; margin: 0; font-size: 11pt; }
  .toc li {
    counter-increment: t; display: flex; align-items: baseline;
    padding: 3.6mm 0; border-bottom: .5pt dotted #ccc;
  }
  .toc li::before { content: counter(t) "、"; color: #07C160; margin-right: 3mm; font-weight: 600; }
  .toc li span { margin-left: auto; color: #888; font-size: 9.5pt; }
</style></head>
<body>
${content}
</body></html>`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const htmlPath = path.join(OUT_DIR, '用户手册.html');
fs.writeFileSync(htmlPath, html, 'utf8');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const pdfPath = path.join(OUT_DIR, '用户手册.pdf');
let ok = false;
try {
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
    '--print-to-pdf=' + pdfPath.replace(/\\/g, '/'),
    'file:///' + htmlPath.replace(/\\/g, '/')
  ], { stdio: 'ignore', timeout: 180000 });
  ok = fs.existsSync(pdfPath);
} catch (e) {
  console.log('  PDF 生成失败：' + e.message);
}

let pages = 0;
if (ok) {
  const raw = fs.readFileSync(pdfPath);
  pages = (raw.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

console.log('');
console.log('  软著 · 用户手册');
console.log('  ─────────────────────────────────────────');
console.log('  软件名称    ' + NAME + ' ' + VERSION);
console.log('  章节        7 章（概述 / 环境 / 安装 / 学员端 / 教练台 / 运营端 / FAQ）');
console.log('  界面截图    ' + (fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')).length) + ' 张');
console.log('  HTML        ' + path.relative(ROOT, htmlPath));
console.log('  PDF         ' + (ok ? path.relative(ROOT, pdfPath) + '（' + pages + ' 页）' : '未生成'));
console.log('  ─────────────────────────────────────────');
console.log('');
