#!/usr/bin/env node
// ui/check-batch-jd.mjs — 批量初筛纯函数的自检
//
// 为什么必须有：批量初筛是**前端编排**（循环调用 /api/eval），切块和排序
// 全在浏览器里做。这块逻辑出错的方式很安静 —— 少切一条只是列表里少一行，
// 排序不稳只是表格每次重绘都在跳，界面上一律正常。
// 所以把纯函数抽到 ui/batch-jd.mjs，在这里逐条钉住。
//
// 纯函数测试：不起服务、不开浏览器、不花 token。
// 用法：node ui/check-batch-jd.mjs
import {
  splitBatchJds, rowFromTriage, sortBatchRows, batchRowsToMarkdown,
  verdictZh, BATCH_MAX, JD_MAX,
} from './batch-jd.mjs';

const fails = [];
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails.push(msg);
};
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）');

console.log('\n── 1. 用 --- 切块 ──');
{
  const text = [
    '字节跳动 · 后端开发工程师',
    '职责：负责服务端开发。',
    '要求：熟悉 Java。',
    '---',
    '腾讯 · 后台开发',
    '职责：参与平台建设。',
  ].join('\n');
  const r = splitBatchJds(text);
  eq(r.items.length, 2, '切出 2 个岗位');
  eq(r.items[0].label, '字节跳动 · 后端开发工程师', '标签取首行');
  ok(r.items[0].jd.includes('熟悉 Java'), '第一条 JD 含正文');
  // 首行是「公司名 + 岗位名」，评估就靠它判方向、命名报告 —— 必须留在 JD 里
  ok(r.items[0].jd.includes('字节跳动'), 'JD 保留首行（公司名不能丢）');
  ok(!r.items[0].jd.includes('腾讯'), 'JD 里不含别的岗位（切块干净）');
  eq(r.items[1].label, '腾讯 · 后台开发', '第二条标签正确');
  eq(r.truncated, false, '未超上限');
  eq(r.total, 2, 'total 与切出的块数一致');
}

console.log('\n── 2. === / *** 也认，空块丢掉 ──');
{
  const text = '甲\nJD 甲\n=====\n\n\n===\n乙\nJD 乙\n***\n\n';
  const r = splitBatchJds(text);
  eq(r.items.length, 2, '连续分隔线产生的空块被丢弃');
  eq(r.items[0].label, '甲', '第一条标签');
  eq(r.items[1].label, '乙', '第二条标签');
}

console.log('\n── 3. 标签剥 Markdown 标题记号 + 截断 ──');
{
  // 长度用 repeat 生成，别手数汉字 —— 手写的「很长」实际只有 36 字，
  // 断言会假红（这条踩过）。
  const long = '超长岗位标题'.repeat(8);
  const r = splitBatchJds('### ' + long + '\nJD 正文');
  eq(r.items[0].label.length, 41, '超长标签截断到 40 字 + 省略号');
  ok(!r.items[0].label.startsWith('#'), '标题记号已剥掉');
  ok(r.items[0].label.endsWith('…'), '截断处有省略号');
  const short = splitBatchJds('### 短标题\nJD');
  eq(short.items[0].label, '短标题', '未超长时不加省略号');
}

console.log('\n── 4. 单行块（只粘了标题）也保留 ──');
{
  const r = splitBatchJds('只有一个标题');
  eq(r.items.length, 1, '单行块保留 1 条');
  eq(r.items[0].jd, '只有一个标题', 'JD 退化用标题本身');
}

console.log('\n── 5. 首行有空格的块，正文不能被吞 ──');
{
  const r = splitBatchJds('   公司名\n   正文第一行\n   正文第二行');
  ok(r.items[0].jd.includes('正文第一行') && r.items[0].jd.includes('正文第二行'),
    '前导空格不影响正文提取');
}

console.log('\n── 6. 超长 JD 标记 tooLong（不拦截，标出来让界面跳过）──');
{
  const longBlock = '某公司\n' + 'x'.repeat(JD_MAX + 10);
  const r = splitBatchJds(longBlock);
  eq(r.items[0].tooLong, true, '超过 3 万字符标为 tooLong');
  eq(r.items[0].chars, longBlock.length, 'chars 记录整块的真实长度');
  const r2 = splitBatchJds('某公司\n' + 'x'.repeat(100));
  eq(r2.items[0].tooLong, false, '正常长度不标 tooLong');
}

console.log('\n── 7. 超过上限截断并如实报告 ──');
{
  const text = Array.from({ length: BATCH_MAX + 3 }, (_, i) => '岗位' + (i + 1) + '\nJD' + (i + 1)).join('\n---\n');
  const r = splitBatchJds(text);
  eq(r.items.length, BATCH_MAX, '最多收 ' + BATCH_MAX + ' 条');
  eq(r.truncated, true, 'truncated 为 true');
  eq(r.total, BATCH_MAX + 3, 'total 如实反映切出多少块');
}

console.log('\n── 8. 空输入不炸 ──');
{
  for (const v of ['', '   ', '\n\n\n', null, undefined]) {
    const r = splitBatchJds(v);
    eq(r.items.length, 0, '空输入 → 0 条（' + JSON.stringify(v) + '）');
  }
  const onlySep = splitBatchJds('---\n---');
  eq(onlySep.items.length, 0, '只有分隔线 → 0 条');
}

console.log('\n── 9. 响应 → 表格行 ──');
{
  const item = { index: 1, label: '甲公司', jd: 'JD', chars: 2, tooLong: false };
  const good = rowFromTriage(item, {
    ok: true, ms: 21000, triage: { score: 4.5, verdict: 'PASS', tier: '强匹配', why: '门槛全过' },
  });
  eq(good.ok, true, '成功行 ok=true');
  eq(good.score, 4.5, '分数归一为数字');
  eq(good.verdict, 'PASS', '结论透传');
  eq(good.error, '', '成功行没有错误文案');

  const strScore = rowFromTriage(item, { ok: true, triage: { score: '4.5/5', verdict: 'pass' } });
  eq(strScore.score, 4.5, '字符串分数 "4.5/5" 也能解析');

  const bad = rowFromTriage(item, { ok: false, code: -2, friendly: '初筛超时' });
  eq(bad.ok, false, '失败行 ok=false');
  eq(bad.score, null, '失败行没有分数');
  eq(bad.error, '初筛超时', '失败行带服务端友好文案');

  const noTriage = rowFromTriage(item, { ok: true, triage: null });
  eq(noTriage.score, null, '没有 triage 字段时分数为 null，不抛错');

  const tooLong = rowFromTriage({ ...item, tooLong: true, chars: 99999 }, null);
  eq(tooLong.skipped, true, '超长条目标 skipped');
  ok(/上限 3 万/.test(tooLong.error), '超长条目给出可操作的文案');
}

console.log('\n── 10. 结论中文化 ──');
{
  eq(verdictZh('PASS'), '通过', 'PASS → 通过');
  eq(verdictZh('fail'), '未通过', 'fail（小写）→ 未通过');
  eq(verdictZh(''), '', '空结论 → 空字符串');
  eq(verdictZh(undefined), '', 'undefined 不炸');
}

console.log('\n── 11. 排序：分数降序、无分沉底、同分按原序 ──');
{
  const rows = [
    { index: 1, score: 3.2 }, { index: 2, score: 4.8 },
    { index: 3, score: null }, { index: 4, score: 4.8 }, { index: 5, score: 2.1 },
  ];
  const byScore = sortBatchRows(rows, 'score').map((r) => r.index);
  eq(byScore.join(','), '2,4,1,5,3', '降序且 null 沉底，同分保持原序');
  const byOrder = sortBatchRows(rows, 'order').map((r) => r.index);
  eq(byOrder.join(','), '1,2,3,4,5', 'order 模式回到粘贴顺序');
  eq(sortBatchRows(rows, 'score').length, 5, '排序不丢行');
  const stable = sortBatchRows(rows, 'score').map((r) => r.index).join(',');
  eq(sortBatchRows(rows, 'score').map((r) => r.index).join(','), stable, '重复排序结果一致（稳定）');
}

console.log('\n── 12. 复制用的 Markdown ──');
{
  const rows = [
    rowFromTriage({ index: 1, label: '甲公司', tooLong: false }, {
      ok: true, triage: { score: 4.5, verdict: 'PASS', tier: '强匹配', why: '门槛全过' },
    }),
    rowFromTriage({ index: 2, label: '乙 | 公司', tooLong: false }, { ok: false, code: 1, friendly: '空返回' }),
  ];
  const md = batchRowsToMarkdown(rows, { threshold: 3 });
  ok(md.includes('| # | 岗位 | 分数 | 结论 | 档位 | 理由 |'), '含表头');
  ok(md.includes('| 1 | 甲公司 | 4.5 ✓ | 通过 | 强匹配 | 门槛全过 |'), '成功行格式正确且带过线标记');
  ok(md.includes('｜'), '单元格里的竖线换成全角，不截断表格');
  ok(/\| 2 \| 乙 ｜ 公司 \| — \|/.test(md), '失败行分数显示为—');
  ok(md.trim().split('\n').length === 4, '两行数据 + 表头 + 分隔行');
}

console.log('\n────────────────────────────');
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项：\n  - ' + fails.join('\n  - '));
} else {
  console.log('✓ 批量初筛纯函数自检全部通过');
}
process.exitCode = fails.length ? 1 : 0;
