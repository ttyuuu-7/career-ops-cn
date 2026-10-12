#!/usr/bin/env node
// ui/check-eval-parse.mjs — 初筛输出解析的回归测试
//
// 为什么需要它：模型输出的措辞完全不受控，而解析坏掉时是**静默降级**
// （分数正常显示、档位和理由悄悄消失），不会抛错、控制台也干净。
// 靠人手点一遍根本发现不了，所以把真实观察到的几套输出固化成用例。
//
// 下面每个用例的「标签」都不是编的，是实跑中真出现过的措辞。
//
// 用法：node ui/check-eval-parse.mjs      退出码 0 = 全过

import { parseTriage } from './eval-parse.mjs';

const CASES = [
  {
    name: '分级（第一次实跑）',
    input: '评分：4.2/5\n结论：通过\n分级：值得投递\n评估理由：硬门槛全部通过，届次学历专业均符合。',
    want: { score: 4.2, verdict: 'PASS', tier: '值得投递' },
  },
  {
    name: '评级（第二次实跑）',
    input: '分数：4.2/5\n结论：通过\n评级：值得投递\n原因：硬门槛全部通过，届次学历专业均符合。',
    want: { score: 4.2, verdict: 'PASS', tier: '值得投递' },
  },
  {
    name: '等级（第三次实跑）',
    input: '评分：4.6/5\n结论：通过\n等级：强匹配\n原因：直接命中后端开发方向，技术栈完全一致。',
    want: { score: 4.6, verdict: 'PASS', tier: '强匹配' },
  },
  {
    name: '层级（第四次实跑）',
    input: '评分：4.5/5\n结论：通过\n层级：强匹配\n原因：硬门槛全过，技术栈与方向完全契合。',
    want: { score: 4.5, verdict: 'PASS', tier: '强匹配' },
  },
  {
    name: '完全没见过的标签（考结构解析）',
    input: '得分：3.8/5\n判断：通过\n归类：补投位\n说明：门槛都过了，但技术栈只对上一半。',
    want: { score: 3.8, verdict: 'PASS', tier: '补投位' },
  },
  {
    name: '英文标签（prompt 字面要求的那套）',
    input: 'SCORE: 3.2/5\nVERDICT: PASS\nTIER: 补投位\nWHY: 门槛通过但匹配度一般。',
    want: { score: 3.2, verdict: 'PASS', tier: '补投位' },
  },
  {
    name: '结论为否定 —— 否定必须优先匹配',
    input: '评分：2.5/5\n结论：未通过\n档位：不建议投递\n理由：JD 要求 2026 届，届次不符。',
    want: { score: 2.5, verdict: 'FAIL', tier: '不建议投递' },
  },
  {
    name: 'AI 在前面加了一段客套话',
    input: '好的，我来做初筛。\n\n评分：4.0/5\n结论：通过\n分级：值得投递\n评估理由：五条硬门槛全部通过。',
    want: { score: 4.0, verdict: 'PASS', tier: '值得投递' },
  },
  {
    name: 'markdown 加粗包裹',
    input: '**评分：** 4.4/5\n**结论：** 通过\n**分级：** 值得投递\n**评估理由：** 硬门槛通过。',
    want: { score: 4.4, verdict: 'PASS', tier: '值得投递' },
  },
];

let fail = 0;
console.log('\n初筛解析回归 — ' + CASES.length + ' 个用例（标签均取自实跑输出）\n');

for (const c of CASES) {
  const r = parseTriage(c.input);
  const bad = [];
  for (const [k, v] of Object.entries(c.want)) {
    if (k === 'score' ? r.score !== v : r[k] !== v) bad.push(k + ' 期望 ' + v + ' 实际 ' + r[k]);
  }
  // 理由必须非空，且不能和档位重复
  if (!r.why) bad.push('why 为空');
  if (r.tier && r.tier === r.why) bad.push('tier 与 why 重复');

  if (bad.length) { fail += 1; console.log('  ✗ ' + c.name + '\n      ' + bad.join('\n      ')); }
  else console.log('  ✓ ' + c.name + ' → ' + r.score + '/5 · ' + r.verdict + ' · ' + r.tier);
}

// 兜底：空输入不能炸
const e = parseTriage('');
if (e.score !== null || e.why !== '') { fail += 1; console.log('  ✗ 空输入未安全返回'); }
else console.log('  ✓ 空输入安全返回');

console.log('\n结果：' + (fail ? '✗ ' + fail + ' 个用例失败' : '全部通过'));
// 用 exitCode 而不是 process.exit()：管道下 stdout 是异步的，
// process.exit() 会在缓冲区刷出去之前就终止进程，报告直接丢掉。
process.exitCode = fail ? 1 : 0;
