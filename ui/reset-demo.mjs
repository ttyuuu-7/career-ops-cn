#!/usr/bin/env node
/**
 * 清空演示数据，把项目恢复到「未初始化」的干净状态。
 *
 * 背景：首次搭建控制台时，为了验证各条链路（简历保存、PDF 渲染、台账改写、
 * 报告解析）能用，我写入了一份演示数据。这些数据不是你本人的信息，
 * 直接拿去做岗位评估会得出完全错误的结论，所以在正式使用前建议清空。
 *
 * 用法：
 *   node ui/reset-demo.mjs          # 交互确认
 *   node ui/reset-demo.mjs --yes    # 跳过确认
 *   node ui/reset-demo.mjs --keep-profile   # 保留 config/profile.yml 不清
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const SKIP_CONFIRM = args.has('--yes') || args.has('-y');
const KEEP_PROFILE = args.has('--keep-profile');

const J = (...p) => path.join(ROOT, ...p);

const TRACKER_HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '',
].join('\n');

const PIPELINE_EMPTY = ['# Job Pipeline', '', '## Pending', '', '## Processed', ''].join('\n');

/** 演示数据留下的简历文件名。 */
const DEMO_REPORTS = ['2026-09-16-example-company.md'];

function buildPlan() {
  const plan = [];
  // 不存在的东西不列入计划，否则每次都会虚报条数、「已经是干净状态」分支永远命中不了
  const rm = (rel, label) => { if (fs.existsSync(J(rel))) plan.push({ rel, kind: 'remove', label }); };
  const write = (rel, content, label) => plan.push({ rel, kind: 'write', content, label });
  const copy = (from, to, label) => plan.push({ rel: to, kind: 'copy', from, label });

  /** 内容已一致就不必列进计划——否则「已经是干净状态」这条分支永远不会命中。 */
  const differs = (rel, expected) => {
    try { return fs.readFileSync(J(rel), 'utf8') !== expected; } catch { return true; }
  };

  rm('cv.md', '你的简历（演示内容，非你本人）');
  rm(path.join('data', 'cv-form.json'), '简历表单缓存');

  // 备份文件是保存简历时自动生成的，一并清掉
  const dataDir = J('data');
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (/^cv\.backup-.*\.md$/.test(f)) plan.push({ rel: path.join('data', f), kind: 'remove', label: '简历自动备份' });
    }
  }

  if (differs(path.join('data', 'applications.md'), TRACKER_HEADER)) {
    write(path.join('data', 'applications.md'), TRACKER_HEADER, '投递台账 → 重置为表头');
  }
  if (differs(path.join('data', 'pipeline.md'), PIPELINE_EMPTY)) {
    write(path.join('data', 'pipeline.md'), PIPELINE_EMPTY, '岗位链接池 → 清空');
  }

  for (const f of DEMO_REPORTS) {
    if (fs.existsSync(J('reports', f))) plan.push({ rel: path.join('reports', f), kind: 'remove', label: '示例评估报告' });
  }

  const outDir = J('output');
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (/\.(pdf|html)$/i.test(f)) plan.push({ rel: path.join('output', f), kind: 'remove', label: '生成的简历文件' });
      // PDF 生成脚本会留下中间载荷文件，简历删了它就是孤儿
      else if (/^\.cv-payload-.*\.json$/.test(f)) plan.push({ rel: path.join('output', f), kind: 'remove', label: 'PDF 生成中间文件' });
    }
  }

  if (!KEEP_PROFILE) {
    const from = path.join('config', 'profile.example.yml');
    const to = path.join('config', 'profile.yml');
    let same = false;
    try { same = fs.readFileSync(J(from), 'utf8') === fs.readFileSync(J(to), 'utf8'); } catch { same = false; }
    if (!same) copy(from, to, '求职画像 → 恢复为官方示例');
  }
  return plan;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

async function main() {
  const plan = buildPlan();

  if (!plan.length) {
    console.log('\n已经是干净状态，无需清理。\n');
    return;
  }

  console.log('\n将要执行以下操作：\n');
  for (const [i, p] of plan.entries()) {
    const verb = p.kind === 'remove' ? '删除  ' : p.kind === 'copy' ? '替换  ' : '重置  ';
    console.log(`  ${String(i + 1).padStart(2)}. ${verb} ${p.rel}    (${p.label})`);
  }
  console.log('\n注意：以上都是搭建控制台时写入的演示数据，删除后不可恢复。');
  console.log('      你自己的真实简历/画像不会受影响（那些文件还没创建）。\n');

  if (!SKIP_CONFIRM) {
    const a = await ask('确认执行？输入 yes 继续，其它任意键取消: ');
    if (a !== 'yes' && a !== 'y') { console.log('\n已取消，未改动任何文件。\n'); return; }
  }

  let done = 0;
  for (const p of plan) {
    const full = J(p.rel);
    try {
      if (p.kind === 'remove') {
        fs.rmSync(full, { force: true });
      } else if (p.kind === 'write') {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, p.content, 'utf8');
      } else if (p.kind === 'copy') {
        if (!fs.existsSync(J(p.from))) throw new Error('示例文件不存在：' + p.from);
        fs.copyFileSync(J(p.from), full);
      }
      console.log('  ✔ ' + p.rel);
      done++;
    } catch (e) {
      console.log('  ✖ ' + p.rel + ' — ' + e.message);
    }
  }

  console.log(`\n完成：${done}/${plan.length} 项。`);
  console.log('\n接下来在界面的「我的简历」里填入你自己的信息即可开始使用。\n');
}

main().catch((e) => { console.error('出错了：' + e.message); process.exit(1); });
