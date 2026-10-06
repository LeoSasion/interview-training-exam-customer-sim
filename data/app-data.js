/* ============================================================================
 * 新员工培训系统 · 共享数据源（Single Source of Truth）
 * ----------------------------------------------------------------------------
 * 学员端（仿真培训原型-微信风格.html）与管理后台（管理后台-仿真培训.html）
 * 均通过 <script src="data/app-data.js"></script> 读取本文件，
 * 保证两端看到的是同一份场景、同一份学员、同一份成绩。
 *
 * 设计约束：
 *   1. 只用 window.XXX 挂载，不声明顶层 const/let，避免与其他脚本重名冲突。
 *   2. 不依赖任何外部资源，file:// 双击可直接打开。
 *   3. 生产环境把 window.TRAIN 换成后端接口返回的 JSON 即可，字段名不变。
 * ==========================================================================*/
(function (w) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 组织与元信息
   * ------------------------------------------------------------------ */
  var META = {
    org: 'XX食品 · 连锁渠道事业部',
    product: '新员工仿真培训系统',
    version: 'v0.2 原型',
    updatedAt: '2026-10-05',
    owner: '培训运营组'
  };

  /* ------------------------------------------------------------------ *
   * 2. 能力维度（Rubric 骨架）
   *    所有评分、报告、看板都以此为唯一口径。
   * ------------------------------------------------------------------ */
  var DIMS = [
    { id: 'd1', name: '开场与礼貌', desc: '自我介绍是否清晰、是否尊重客户、开场是否啰嗦', weight: 15 },
    { id: 'd2', name: '需求挖掘', desc: '能否通过提问问出客户的真实顾虑与用量规模', weight: 25 },
    { id: 'd3', name: '异议处理', desc: '面对压价、质量质疑、情绪投诉时是否先接情绪再解决', weight: 25 },
    { id: 'd4', name: '方案讲解', desc: '是否用案例、数据、标准而非形容词来支撑观点', weight: 20 },
    { id: 'd5', name: '促成推进', desc: '是否把下一步动作（发方案/寄样/约时间）说死', weight: 15 }
  ];

  /* 关键词命中表（原型阶段的打分代理，接入大模型后由模型评分替代） */
  var KW = {
    d1: ['你好', '您好', '早上好', '下午好', '感谢', '谢谢', '张经理', '王姐', '李总', '打扰', '方便', '抱歉', '不好意思', '我是'],
    d2: ['请问', '想了解', '您目前', '您现在', '具体', '预算', '用量', '多少', '什么顾虑', '哪方面', '主要是', '为什么', '怎么回事', '什么情况', '多久', '几次'],
    d3: ['理解', '我明白', '确实', '您说得对', '不好意思', '我们的问题', '给您添麻烦', '不过', '可以这样', '算下来', '长期', '性价比', '成本', '对比一下', '我帮您', '马上', '立刻', '先', '售后', '承诺', '补货', '退', '换货', '处理'],
    d4: ['案例', '数据', '门店', '实际', '质检', '标准', '认证', '批次', '参数', '规格', '保质期', '配方', '我们做过', '同类型', '客户反馈', '第三方', '报告', '专人'],
    d5: ['方案', '报价', '发您', '寄', '样品', '安排', '下一步', '什么时候', '约个', '明天', '今天下午', '您看', '确认', '试试', '先发', '留一批', '资料']
  };

  /* 分数 -> 等级 */
  var LEVELS = [
    { min: 75, key: 'good', label: '良好' },
    { min: 60, key: 'mid', label: '基本达标' },
    { min: 0, key: 'bad', label: '偏弱' }
  ];

  /* ------------------------------------------------------------------ *
   * 3. 场景库（剧本）
   *    objectives[].dim 指向 DIMS[].id —— 这是"训练目标"与"评分维度"的
   *    正式映射，替代原型里写死的 objDim 数组。
   * ------------------------------------------------------------------ */
  var SCENES = [
    {
      id: 's1',
      code: 'SC-001',
      name: '张经理',
      subtitle: '连锁餐饮 · 采购负责人',
      avatarText: '张',
      color: '#5B8FF9',
      last: '你们这个价格，比我们现在用的高不少…',
      time: '17:32',
      unread: 3,
      taskName: '客户异议处理',
      channel: '微信沟通',
      category: '客户异议',
      difficulty: '中',
      passLine: 60,
      duration: 8,
      status: 'active',
      owner: '培训运营组',
      updatedAt: '2026-09-28',
      brief: '客户已看过报价单，认为价格偏高。考察学员能否先问清顾虑（价格/质量/售后），再用案例与承诺推动下一步。',
      script: [
        { t: '你好，报价单我看了，你们这个价格比我们现在合作的供应商高不少啊。', v: 9 },
        { t: '我们一年采购量不小，这个价我没法跟老板交代。你们最低能给到多少？', v: 7 },
        { t: '便宜是便宜，但便宜的东西我们以前吃过亏。你凭什么让我信你们质量？', v: 11 },
        { t: '售后呢？万一货出问题，你们多久能处理？', v: 6 },
        { t: '行吧，那你先发一份详细方案和报价过来，我拿去跟领导汇报一下。', v: 8 },
        { t: '对了，有样品的话寄两份过来，我们后厨先试试。', v: 5 }
      ],
      tips: [
        '第一步别急着解释价格——先用提问把客户真正的顾虑问出来。',
        '客户在压价。别直接降，先把「用量大」这个点接住，再引导到整体成本。',
        '客户质疑质量。用具体案例或数据说话，比形容词管用得多。',
        '售后是决策关键。给一个明确到「小时」的响应承诺。',
        '客户已经松口了，立刻把下一步动作定死：发什么、什么时候、谁来对接。',
        '客户主动要样品，这是推进信号，马上承接并确认收货信息。'
      ],
      objectives: [
        { text: '主动自我介绍并说明来意', dim: 'd1' },
        { text: '问清客户真正的顾虑（价格 / 质量 / 售后）', dim: 'd2' },
        { text: '用真实案例或数据回应质疑', dim: 'd4' },
        { text: '给出明确的售后响应承诺', dim: 'd3' },
        { text: '推动下一步动作（发方案 / 寄样品）', dim: 'd5' }
      ],
      voicePool: [
        ['您好张经理，我是XX食品的小陈，上次给您发的报价单您看到啦？', '您方便的话，我想先了解一下您现在主要担心的是价格还是品质？', '理解理解，您先说说具体哪块儿您觉得不合适，我好帮您对一下。'],
        ['我们一年给连锁餐饮供货三千多万，这个价位在行业里确实不算高。', '您一年用量大概在什么量级？我按量给您重新算一版。', '价格我一会儿单独跟您说，先看东西对不对得上需求。'],
        ['上个月我们刚给同城另一家连锁供了一批，可以安排您去看看。', '我们有第三方质检报告，每批次都能查，一会儿发您。', '您可以先拿两箱试试，好不好用一次就知道。'],
        ['售后我们承诺同城 4 小时到场，出问题先补货、后对账。', '这个我做不了主，但我可以马上帮您申请一个专属服务通道。', '我把售后条款单独列一份发您，白纸黑字更放心。'],
        ['我下午 5 点前把方案和报价一起发到您微信上。', '那我明天上午跟您确认一下领导那边的反馈，方便吗？', '样品我今天就安排寄，您把收货地址和联系人说一下。']
      ]
    },
    {
      id: 's2',
      code: 'SC-002',
      name: '王姐',
      subtitle: '连锁商超 · 门店店长',
      avatarText: '王',
      color: '#F2994A',
      last: '小陈啊，上次那批货有两箱漏液了…',
      time: '昨天',
      unread: 1,
      taskName: '客诉安抚与二次转化',
      channel: '微信沟通',
      category: '客户投诉',
      difficulty: '高',
      passLine: 65,
      duration: 10,
      status: 'active',
      owner: '培训运营组',
      updatedAt: '2026-09-30',
      brief: '客户遇到二次质量问题，情绪明显。考察学员能否先接情绪、主动认责，并在处理完客诉后自然承接新品转化。',
      script: [
        { t: '小陈啊，上次那批货有两箱到店就漏液了，店长那边意见很大。', v: 8 },
        { t: '你们物流怎么回事？这都第二次了。', v: 4 },
        { t: '我要的不是道歉，我要的是下次别再出这种事。', v: 5 },
        { t: '你说吧，这批货怎么处理？', v: 4 },
        { t: '行，那就这样，钱按你说的退。下次再出问题我可就直接换供应商了。', v: 9 },
        { t: '哎对了，你们新出的那个系列，给我报个价呗。', v: 5 }
      ],
      tips: [
        '先接情绪，不要解释、不要争辩。第一句一定要让客户觉得「你在」。',
        '客户提到「第二次」，说明是重复问题。这时候要少辩解、多追问。',
        '客户要的不是道歉而是改进。给一个具体到动作的整改承诺。',
        '主动给出处理方案，别让客户提。退、补、还是换，先给一版。',
        '客户在给最后机会，这时候要把「改进措施」落成文字留痕。',
        '客户主动问新品，说明关系没断。抓住机会自然承接。'
      ],
      objectives: [
        { text: '先安抚情绪，不与客户争辩', dim: 'd3' },
        { text: '追问具体情况（批次 / 数量 / 影响）', dim: 'd2' },
        { text: '主动承认问题并给出补救方案', dim: 'd3' },
        { text: '承诺可落地的改进措施', dim: 'd4' },
        { text: '把握时机推动新品二次转化', dim: 'd5' }
      ],
      voicePool: [
        ['王姐您别急，我马上处理，这事儿我盯着。', '实在不好意思王姐，给您和店里添麻烦了。', '您先跟我说说，一共几箱、哪一批的？'],
        ['我这就去查物流和批次记录，今天给您回话。', '是哪个环节出的问题，我查清楚第一时间同步您。', '我先看下出库记录，再跟仓储对一下。'],
        ['王姐，我想给您三个动作：换货、补差、加一层防护包装。', '这个我认，是我们的问题，整改方案我明天给您书面版。', '您看这样行不行，我先安排人过去把货换了。'],
        ['我们把外箱加固改成双瓦楞，运输途中加垫板，避免再出问题。', '我申请把您这家店列成重点保障门店，出库单独复核。', '整改我做成一份书面说明，盖章后发您。'],
        ['这个款我下午就走流程退给您。', '王姐，新系列我先给您留一批，价格我按老客户的政策报。', '我把新品资料和报价一起发您，您先看看。']
      ]
    },
    {
      id: 's3',
      code: 'SC-003',
      name: '李总',
      subtitle: '区域经销商（潜在客户）',
      avatarText: '李',
      color: '#27AE60',
      last: '你先加我微信吧，有需要再联系',
      time: '昨天',
      unread: 0,
      taskName: '破冰与需求挖掘',
      channel: '微信沟通',
      category: '新客开发',
      difficulty: '中',
      passLine: 60,
      duration: 8,
      status: 'active',
      owner: '培训运营组',
      updatedAt: '2026-09-30',
      brief: '客户在忙、无更换意愿。考察学员能否极简开场、快速问出痛点，并用差异化优势争取明确的下一步。',
      script: [
        { t: '你是？我这边在忙，有事说事。', v: 5 },
        { t: '我们现在有供应商，暂时没打算换。', v: 6 },
        { t: '你们和现在这家比，优势在哪？', v: 7 },
        { t: '听着还行。不过你们规模是不是有点小？', v: 6 },
        { t: '这样吧，你把资料发我看看，合适再说。', v: 7 },
        { t: '嗯，微信上说就行。', v: 3 }
      ],
      tips: [
        '客户在忙。第一句必须极短：我是谁、做什么、为什么找你。',
        '客户没打算换，别硬推。先问当下的痛点和不满。',
        '客户开始比较了，这是好信号。用差异化，不要罗列参数。',
        '被质疑规模，正面回应 + 用交付能力证明，不要回避。',
        '客户要资料，说明有兴趣。这时候一定要约定一个具体的跟进时间。',
        '收尾。把下次沟通的时间点钉死。'
      ],
      objectives: [
        { text: '简短自报家门，不啰嗦', dim: 'd1' },
        { text: '快速切入对方关心的问题', dim: 'd2' },
        { text: '问出当前供应商与痛点', dim: 'd2' },
        { text: '用差异化优势回应质疑', dim: 'd4' },
        { text: '争取明确的下一步与跟进时间', dim: 'd5' }
      ],
      voicePool: [
        ['李总您好，我是XX食品的小陈，做连锁餐饮供应链的，打扰您两分钟。', '您好李总，之前展会上加的微信，我们是做食品供应的。', '李总好，我是小陈，XX食品的区域负责人。'],
        ['您现在这家合作得怎么样？有没有哪里不太顺手的？', '我不聊换不换，就想先了解一下您现在最头疼的是什么。', '您这边一年大概走多少量？我先心里有个数。'],
        ['我们的优势是响应快，同城 4 小时，能做到的同行不多。', '我们单量没他们大，但我们给每家客户配专人对接。', '价格上我们不一定最低，但缺货率我们敢承诺。'],
        ['我们规模确实不算最大，但给连锁客户供了五年，没断过货。', '您要的是稳定供应，这一点上我们比大厂更容易协调。', '我给您看几个同类型客户的合作情况。'],
        ['资料我现在就发您，您看完我周三上午跟您聊十分钟行吗？', '我先把方案发您，方便的话我们约明天下午电话聊。', '您先看，我这周四再来跟您确认一下。']
      ]
    }
  ];

  /* ------------------------------------------------------------------ *
   * 4. 学员名册
   * ------------------------------------------------------------------ */
  var LEARNERS = [
    { id: 'L01', name: '陈晓', avatarText: '陈', color: '#5B8FF9', dept: '连锁渠道事业部', position: '客户经理', mentor: '周敏', joinDate: '2026-09-15' },
    { id: 'L02', name: '林可', avatarText: '林', color: '#F2994A', dept: '连锁渠道事业部', position: '销售代表', mentor: '周敏', joinDate: '2026-09-15' },
    { id: 'L03', name: '吴迪', avatarText: '吴', color: '#27AE60', dept: '华东大区', position: '销售代表', mentor: '赵磊', joinDate: '2026-09-16' },
    { id: 'L04', name: '郑楠', avatarText: '郑', color: '#BB6BD9', dept: '华东大区', position: '客户经理', mentor: '赵磊', joinDate: '2026-09-16' },
    { id: 'L05', name: '何静', avatarText: '何', color: '#56CCF2', dept: '连锁渠道事业部', position: '销售代表', mentor: '周敏', joinDate: '2026-09-18' },
    { id: 'L06', name: '周子昂', avatarText: '周', color: '#EB5757', dept: '华南大区', position: '销售代表', mentor: '赵磊', joinDate: '2026-09-18' },
    { id: 'L07', name: '徐宁', avatarText: '徐', color: '#2D9CDB', dept: '华南大区', position: '客户经理', mentor: '孙迁', joinDate: '2026-09-20' },
    { id: 'L08', name: '马莉', avatarText: '马', color: '#F2C94C', dept: '华南大区', position: '销售代表', mentor: '孙迁', joinDate: '2026-09-20' },
    { id: 'L09', name: '高阳', avatarText: '高', color: '#6FCF97', dept: '华东大区', position: '销售代表', mentor: '孙迁', joinDate: '2026-09-22' },
    { id: 'L10', name: '曹雪', avatarText: '曹', color: '#9B51E0', dept: '连锁渠道事业部', position: '客户经理', mentor: '周敏', joinDate: '2026-09-22' },
    { id: 'L11', name: '田昊', avatarText: '田', color: '#F2994A', dept: '华东大区', position: '销售代表', mentor: '赵磊', joinDate: '2026-09-25' },
    { id: 'L12', name: '沈一鸣', avatarText: '沈', color: '#5B8FF9', dept: '华南大区', position: '销售代表', mentor: '孙迁', joinDate: '2026-09-25' }
  ];

  /* ------------------------------------------------------------------ *
   * 5. 任务（对应管理后台截图里的「任务下发 / 任务列表」）
   *    passLine 可在下发时覆盖场景默认达标线。
   * ------------------------------------------------------------------ */
  var TASKS = [
    {
      id: 'T01', code: 'RW-20261005-01',
      title: '价格异议应对专项',
      sceneId: 's1',
      passLine: 60,
      assignees: ['L01', 'L02', 'L03', 'L04', 'L05', 'L06', 'L07', 'L08', 'L09', 'L10', 'L11', 'L12'],
      dueAt: '2026-10-08 18:00',
      startAt: '2026-10-01 09:00',
      createdAt: '2026-09-30 16:20',
      createdBy: '培训运营组 · 王倩',
      requireAll: true,
      status: 'running',
      note: '新员工入职必修，未达标需在 3 天内复训一次。'
    },
    {
      id: 'T02', code: 'RW-20261005-02',
      title: '客诉安抚与二次转化',
      sceneId: 's2',
      passLine: 65,
      assignees: ['L01', 'L02', 'L05', 'L06', 'L09', 'L10'],
      dueAt: '2026-10-10 18:00',
      startAt: '2026-10-03 09:00',
      createdAt: '2026-10-02 11:05',
      createdBy: '培训运营组 · 王倩',
      requireAll: false,
      status: 'running',
      note: '面向已接手门店客户的老学员，难度较高。'
    },
    {
      id: 'T03', code: 'RW-20261005-03',
      title: '新客破冰与需求挖掘',
      sceneId: 's3',
      passLine: 60,
      assignees: ['L03', 'L04', 'L07', 'L08', 'L11', 'L12'],
      dueAt: '2026-10-06 18:00',
      startAt: '2026-10-04 09:00',
      createdAt: '2026-10-03 15:40',
      createdBy: '华东大区 · 赵磊',
      requireAll: true,
      status: 'running',
      note: '本周内完成，培训主管会抽查对话记录。'
    },
    {
      id: 'T04', code: 'RW-20260928-01',
      title: '异议处理阶段复训',
      sceneId: 's1',
      passLine: 65,
      assignees: ['L02', 'L05', 'L06', 'L09', 'L11', 'L12'],
      dueAt: '2026-09-30 18:00',
      startAt: '2026-09-26 09:00',
      createdAt: '2026-09-25 10:00',
      createdBy: '培训运营组 · 王倩',
      requireAll: true,
      status: 'finished',
      note: '针对首次考核未达标学员的加练任务，已结束。'
    },
    {
      id: 'T05', code: 'RW-20261005-04',
      title: '服务承诺话术统一演练',
      sceneId: 's2',
      passLine: 70,
      assignees: ['L03', 'L04', 'L07', 'L08'],
      dueAt: '2026-10-15 18:00',
      startAt: '2026-10-12 09:00',
      createdAt: '2026-10-05 09:30',
      createdBy: '培训运营组 · 王倩',
      requireAll: true,
      status: 'draft',
      note: '待客服部确认新版服务承诺口径后再下发。'
    }
  ];

  /* ------------------------------------------------------------------ *
   * 6. 练习记录（成绩档案）
   *    紧凑写法：[taskId, learnerId, sceneId, 综合分, [d1..d5], 提交时间, 用时分钟, 对话轮次]
   * ------------------------------------------------------------------ */
  var RAW_RECORDS = [
    ['T04', 'L02', 's1', 58, [62, 55, 52, 60, 61], '2026-09-27 10:12', 9, 6],
    ['T04', 'L05', 's1', 71, [80, 68, 66, 74, 70], '2026-09-27 14:35', 8, 6],
    ['T04', 'L06', 's1', 54, [60, 48, 52, 55, 58], '2026-09-28 09:40', 11, 6],
    ['T04', 'L09', 's1', 63, [72, 60, 58, 66, 62], '2026-09-28 16:02', 9, 6],
    ['T04', 'L11', 's1', 49, [55, 44, 46, 52, 50], '2026-09-29 11:20', 12, 6],
    ['T04', 'L12', 's1', 66, [70, 64, 62, 68, 66], '2026-09-29 17:45', 8, 6],

    ['T01', 'L01', 's1', 82, [88, 80, 76, 85, 81], '2026-10-01 10:20', 7, 6],
    ['T01', 'L02', 's1', 67, [74, 62, 64, 70, 66], '2026-10-01 15:30', 9, 6],
    ['T01', 'L03', 's1', 74, [80, 70, 68, 78, 74], '2026-10-02 09:15', 8, 6],
    ['T01', 'L04', 's1', 88, [92, 86, 84, 90, 88], '2026-10-02 11:40', 7, 6],
    ['T01', 'L05', 's1', 79, [84, 76, 74, 82, 79], '2026-10-02 16:50', 8, 6],
    ['T01', 'L06', 's1', 61, [68, 56, 58, 64, 60], '2026-10-03 10:05', 10, 6],
    ['T01', 'L07', 's1', 85, [88, 82, 80, 88, 86], '2026-10-03 14:25', 7, 6],
    ['T01', 'L08', 's1', 56, [62, 50, 52, 58, 57], '2026-10-03 17:10', 11, 5],
    ['T01', 'L09', 's1', 72, [78, 68, 66, 76, 72], '2026-10-04 09:35', 8, 6],
    ['T01', 'L10', 's1', 90, [94, 88, 86, 92, 90], '2026-10-04 11:15', 7, 6],
    ['T01', 'L11', 's1', 52, [58, 46, 48, 55, 53], '2026-10-04 15:40', 12, 5],
    ['T01', 'L12', 's1', 69, [76, 64, 62, 72, 68], '2026-10-04 18:20', 9, 6],

    ['T02', 'L01', 's2', 76, [78, 74, 76, 76, 76], '2026-10-03 10:50', 10, 6],
    ['T02', 'L02', 's2', 61, [66, 58, 60, 62, 60], '2026-10-03 15:05', 11, 6],
    ['T02', 'L05', 's2', 73, [76, 70, 72, 74, 73], '2026-10-04 10:30', 10, 6],
    ['T02', 'L06', 's2', 55, [60, 50, 54, 56, 55], '2026-10-04 14:15', 13, 5],
    ['T02', 'L09', 's2', 68, [72, 64, 66, 70, 68], '2026-10-04 16:40', 11, 6],

    ['T03', 'L03', 's3', 78, [82, 76, 74, 80, 78], '2026-10-04 10:10', 8, 6],
    ['T03', 'L04', 's3', 84, [88, 82, 80, 86, 84], '2026-10-04 13:30', 7, 6],
    ['T03', 'L07', 's3', 81, [84, 78, 78, 83, 81], '2026-10-05 09:20', 8, 6],
    ['T03', 'L11', 's3', 58, [64, 52, 54, 60, 58], '2026-10-05 11:05', 12, 5],
    ['T03', 'L12', 's3', 70, [74, 66, 68, 72, 70], '2026-10-05 14:50', 9, 6]
  ];

  var RECORDS = RAW_RECORDS.map(function (r, i) {
    var scene = SCENES.filter(function (s) { return s.id === r[2]; })[0];
    var task = TASKS.filter(function (t) { return t.id === r[0]; })[0];
    var passLine = task ? task.passLine : scene.passLine;
    var dimScores = {};
    DIMS.forEach(function (d, k) { dimScores[d.id] = r[4][k]; });
    return {
      id: 'R' + String(i + 1).padStart(3, '0'),
      taskId: r[0],
      learnerId: r[1],
      sceneId: r[2],
      score: r[3],
      dimScores: dimScores,
      passLine: passLine,
      passed: r[3] >= passLine,
      finishedAt: r[5],
      minutes: r[6],
      turns: r[7],
      channel: '微信沟通'
    };
  });

  /* ------------------------------------------------------------------ *
   * 7. 风险分层规则
   * ------------------------------------------------------------------ */
  var RISK_RULES = {
    red: { key: 'red', label: '高风险', color: '#FA5151', desc: '最近一次未达标，且历史均分低于 65' },
    yellow: { key: 'yellow', label: '需关注', color: '#F2A93B', desc: '存在未达标记录或均分 65–74' },
    green: { key: 'green', label: '正常', color: '#07C160', desc: '最近一次达标且均分不低于 75' }
  };

  /* ------------------------------------------------------------------ *
   * 8. 查询与统计辅助（两端共用，避免各写一套口径）
   * ------------------------------------------------------------------ */
  var idx = {};
  ['scene', 'learner', 'task'].forEach(function (k) { idx[k] = {}; });
  SCENES.forEach(function (s) { idx.scene[s.id] = s; });
  LEARNERS.forEach(function (l) { idx.learner[l.id] = l; });
  TASKS.forEach(function (t) { idx.task[t.id] = t; });

  var H = {
    dimIndex: function (dimId) {
      for (var i = 0; i < DIMS.length; i++) if (DIMS[i].id === dimId) return i;
      return 0;
    },
    level: function (score) {
      for (var i = 0; i < LEVELS.length; i++) if (score >= LEVELS[i].min) return LEVELS[i];
      return LEVELS[LEVELS.length - 1];
    },
    recordsOf: function (learnerId) {
      return RECORDS.filter(function (r) { return r.learnerId === learnerId; })
        .sort(function (a, b) { return a.finishedAt < b.finishedAt ? -1 : 1; });
    },
    avg: function (arr) {
      if (!arr.length) return 0;
      return Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length);
    },
    statsOf: function (learnerId) {
      var rs = H.recordsOf(learnerId);
      var scores = rs.map(function (r) { return r.score; });
      return {
        count: rs.length,
        avg: H.avg(scores),
        best: scores.length ? Math.max.apply(null, scores) : 0,
        last: rs.length ? rs[rs.length - 1] : null,
        passCount: rs.filter(function (r) { return r.passed; }).length,
        failCount: rs.filter(function (r) { return !r.passed; }).length
      };
    },
    riskOf: function (learnerId) {
      var st = H.statsOf(learnerId);
      if (!st.count) return 'yellow';
      var lastFailed = st.last && !st.last.passed;
      if (lastFailed && st.avg < 65) return 'red';
      if (lastFailed || st.failCount > 0 || st.avg < 75) return 'yellow';
      return 'green';
    },
    taskProgress: function (taskId) {
      var t = idx.task[taskId];
      if (!t) return null;
      var done = t.assignees.map(function (lid) {
        return RECORDS.filter(function (r) { return r.taskId === taskId && r.learnerId === lid; })
          .sort(function (a, b) { return a.finishedAt < b.finishedAt ? -1 : 1; }).pop() || null;
      });
      var finished = done.filter(Boolean);
      var passed = finished.filter(function (r) { return r.passed; });
      var due = new Date(String(t.dueAt).replace(/-/g, '/'));
      return {
        task: t,
        total: t.assignees.length,
        finishedCount: finished.length,
        passedCount: passed.length,
        overdueCount: done.filter(function (r, i) {
          return !r && Date.now() > due.getTime();
        }).length,
        avgScore: H.avg(finished.map(function (r) { return r.score; })),
        rate: t.assignees.length ? Math.round(finished.length / t.assignees.length * 100) : 0,
        passRate: finished.length ? Math.round(passed.length / finished.length * 100) : 0,
        records: done
      };
    },
    overview: function () {
      var running = TASKS.filter(function (t) { return t.status === 'running'; });
      var allScores = RECORDS.map(function (r) { return r.score; });
      var risk = { red: 0, yellow: 0, green: 0 };
      LEARNERS.forEach(function (l) { risk[H.riskOf(l.id)]++; });
      var dimAvg = DIMS.map(function (d) {
        var vals = RECORDS.map(function (r) { return r.dimScores[d.id]; });
        return { id: d.id, name: d.name, avg: H.avg(vals) };
      });
      return {
        learnerCount: LEARNERS.length,
        runningTasks: running.length,
        totalRecords: RECORDS.length,
        avgScore: H.avg(allScores),
        passRate: Math.round(RECORDS.filter(function (r) { return r.passed; }).length / RECORDS.length * 100),
        risk: risk,
        dimAvg: dimAvg,
        weakest: dimAvg.slice().sort(function (a, b) { return a.avg - b.avg; })[0]
      };
    }
  };

  /* ------------------------------------------------------------------ *
   * 8b. 数据水合（服务端优先 / 离线兜底）
   *   服务端在线时，管理后台用服务端返回的学员 / 任务 / 成绩替换本地快照，
   *   这样「学员练习后服务端落库的成绩」才会出现在看板与任务进度里。
   *
   *   ⚠️ 必须**原地替换数组元素**（arr.length = 0 后 push），不能换掉数组引用：
   *      helpers 在闭包里持有 RECORDS/LEARNERS/TASKS，换引用会让所有既有统计
   *      继续读旧数据（且表现为"静默不生效"）。
   *   ⚠️ 空数组要照收（例如数据范围为 0 人时就是空），只有 null 才代表失败。
   * ------------------------------------------------------------------ */
  H.reindex = function () {
    idx.scene = {}; idx.learner = {}; idx.task = {};
    SCENES.forEach(function (s) { idx.scene[s.id] = s; });
    LEARNERS.forEach(function (l) { idx.learner[l.id] = l; });
    TASKS.forEach(function (t) { idx.task[t.id] = t; });
  };

  H.replaceInPlace = function (snap) {
    var changed = {};
    function swap(arr, items, key) {
      if (!items) return;                 // null = 拉取失败，保留本地
      arr.length = 0;
      items.forEach(function (x) { arr.push(x); });
      changed[key] = items.length;
    }
    snap = snap || {};
    swap(LEARNERS, snap.learners, 'learners');
    swap(TASKS, snap.tasks, 'tasks');
    swap(RECORDS, snap.records, 'records');
    H.reindex();
    return changed;
  };

  /**
   * 合并「服务端已发布场景池」（P6）。
   *
   * 语义刻意是 **按 id 原地更新 + 新增追加**，既不重排也不删除：
   *   - 不重排：学员端 `cur` 是下标，重排会让「当前会话」指向别的场景，
   *     而 `SCENES[cur]` 是在无数处实时求值的；
   *   - 不删除：服务端库可能不全（刚换库 / 只跑了部分播种），
   *     把本地种子一并清掉会让学员直接没场景可练。场景下线的收口在服务端
   *     （`publish!=='published'` 就查不到），本地残留刷新页面即复位。
   *
   * 离线 / 拉取失败时**不要调用它** —— 保持种子原样就等于旧行为。
   */
  H.mergeScenes = function (list) {
    if (!list || !list.length) return { added: 0, updated: 0 };
    var added = 0, updated = 0;
    list.forEach(function (incoming) {
      if (!incoming || !incoming.id) return;
      var hit = idx.scene[incoming.id];
      if (hit) {
        // ⚠️ 原地赋值：idx.scene 持有的就是这个对象，换成新对象会让 sceneById() 失联
        Object.keys(incoming).forEach(function (k) { hit[k] = incoming[k]; });
        updated++;
      } else {
        SCENES.push(Object.assign({}, incoming));
        added++;
      }
    });
    H.reindex();              // 重建 idx.scene —— 新场景要能被 sceneById() 取到
    rebuildLearnerScenes();   // 同步刷新学员端读的旧形状（w.SCENES）
    return { added: added, updated: updated };
  };

  /* ------------------------------------------------------------------ *
   * 9. 导出
   * ------------------------------------------------------------------ */
  w.TRAIN = {
    meta: META,
    dims: DIMS,
    kw: KW,
    levels: LEVELS,
    scenes: SCENES,
    learners: LEARNERS,
    tasks: TASKS,
    records: RECORDS,
    riskRules: RISK_RULES,
    sceneById: function (id) { return idx.scene[id]; },
    learnerById: function (id) { return idx.learner[id]; },
    taskById: function (id) { return idx.task[id]; },
    helpers: H
  };

  /* ------------------------------------------------------------------ *
   * 10. 兼容层：学员端沿用的旧数据形状
   *     学员端只需引用 SCENES / DIMS / KW，无需改动其余逻辑。
   * ------------------------------------------------------------------ */
  w.DIMS = DIMS.map(function (d) { return d.name; });
  w.KW = (function () {
    var o = {};
    DIMS.forEach(function (d) { o[d.name] = KW[d.id]; });
    return o;
  })();
  w.OBJ_DIM_DEFAULT = DIMS.map(function (_, i) { return i; });

  /* 源形状 → 学员端旧形状。
     ⚠️ 必须只有这一份：初始化（w.SCENES）与热更新（rebuildLearnerScenes）
     都走它，否则两处各写一遍，迟早漂移。 */
  function toLearnerScene(s) {
    return {
      id: s.id,
      name: s.name,
      sub: s.subtitle,
      ava: s.avatarText,
      color: s.color,
      last: s.last,
      time: s.time,
      unread: s.unread,
      task: s.taskName,
      scene: s.channel,
      pass: s.passLine,
      script: s.script || [],
      tips: s.tips || [],
      obj: (s.objectives || []).map(function (o) { return o.text; }),
      objDim: (s.objectives || []).map(function (o) { return H.dimIndex(o.dim); }),
      voicePool: s.voicePool || []
    };
  }

  /* ⚠️ 原地重建（不换数组引用、也尽量不换元素引用）：
     - 数组：学员端 `const curScene = () => SCENES[cur]` 是在调用时求值的，
       但 `w.SCENES` 的引用仍可能在别处被先捕获，换掉整个数组不稳妥；
     - 元素：`?demo=chat` 那条演示分支会在 setTimeout 里先抓 `SCENES[0]` 再回填内容，
       换掉元素对象会让它拿到"另一个对象"。
     顺序永不改变（mergeScenes 只追加、只原地改），所以按下标对齐是安全的；
     仍比对 id 作为保险。 */
  function rebuildLearnerScenes() {
    SCENES.forEach(function (s, i) {
      var next = toLearnerScene(s);
      var prev = w.SCENES[i];
      if (prev && prev.id === next.id) {
        Object.keys(next).forEach(function (k) { prev[k] = next[k]; });
      } else {
        w.SCENES[i] = next;
      }
    });
    w.SCENES.length = SCENES.length;   // 截掉多余（当前只会增长，防御性写法）
  }

  w.SCENES = SCENES.map(toLearnerScene);

  if (typeof console !== 'undefined') {
    console.log('[TRAIN] 数据源已加载：' + SCENES.length + ' 个场景 / ' + LEARNERS.length + ' 名学员 / ' +
      TASKS.length + ' 个任务 / ' + RECORDS.length + ' 条成绩');
  }
})(window);
