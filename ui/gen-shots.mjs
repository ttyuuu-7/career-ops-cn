#!/usr/bin/env node
// ui/gen-shots.mjs — 生成界面截图（ui/screenshots/）
//
// 用途：界面改版后重新出一套截图，给使用指南/README 用。
// 顺序**严格按顶部导航的栏序**（NAV_GROUPS），不按页面新旧——否则截图集和导航对不上。
//
// 用法：
//   node ui/gen-shots.mjs                        # 只截静态页面（01–14）
//   node ui/gen-shots.mjs --with-eval            # 加跑一次真实初筛，截「初筛结果」态（15，约 40 秒）
//   node ui/gen-shots.mjs --with-cv              # 加点几条简历条目，截「添加条目」态（16，秒级）
//
// 15 / 16 是「状态」截图，**编号写死**、不吃静态页面的序号。
// 否则单跑某个 flag 时它会顶替前面的号，两次生成的文件名就对不上了。
//
// 前置：控制台已在 127.0.0.1:7317 跑着。

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.CAREER_OPS_UI || 'http://127.0.0.1:7317/';
// 必须用 fileURLToPath：项目路径含中文（D:\桌面），
// import.meta.url 的 .pathname 会给出 %E6%A1%8C%E9%9D%A2 这种百分号编码，直接拼路径必 ENOENT。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'screenshots');
const WITH_EVAL = process.argv.includes('--with-eval');
const WITH_CV = process.argv.includes('--with-cv');

// 与 app.js 的 NAV_GROUPS 保持一致（栏目顺序即分组顺序）：
// 总览 → 做简历（我的简历 / 简历工具）→ 评岗位（评估岗位 / 评估报告）→ 分析（面试备考建议）→ 系统（求职配置 / 全部脚本 / 使用帮助）。
// 注意这里是**功能项**的顺序（9 个），不是一级栏目（5 个）。
// ⚠ 改这个顺序会让 01–09 的编号与截图内容错位，要重出就整批重跑，别混着用。
const PAGES = [
  ['home', '网站首页'],
  ['cv', '我的简历'],
  ['cvkit', '简历工具'],
  ['profile', '求职配置'],
  ['evaluate', '评估岗位'],
  ['reports', '评估报告'],
  ['prep', '面试备考建议'],
  ['tools', '全部脚本'],
  ['help', '使用帮助'],
  // 自动投递**追加在末尾**（编号 10），不插到「使用帮助」前面：插进去会把
  // 原来的 09-help.png 顶成 10，已出过的那套截图文件名就全对不上了。
  // 代价是这里不再严格等于导航栏序，但截图文件名稳定更重要。
  ['autoapply', '自动投递'],
  // security 同理追加（编号 11）：账号安全中心，从身份胶囊的「系统设置」菜单进入。
  ['security', '账号安全中心'],
  // templates 同理追加（编号 12）：简历模板库，从「我的简历」的「选择模板」进入。
  ['templates', '简历模板库'],
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(240000);

const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

const pad = (n) => String(n).padStart(2, '0');
const shot = async (name) => {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  console.log('  ✓ ' + name + '.png');
};

// 页面内容由 VIEWS 异步渲染，等 #view 里真的长出东西再截
const settle = async () => {
  await page.waitForFunction(() => {
    const v = document.querySelector('#view');
    return v && v.innerHTML.trim().length > 400;
  }, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(700);
};

console.log('\n生成界面截图 → ' + OUT);

let i = 0;
for (const [id, label] of PAGES) {
  i += 1;
  await page.goto(BASE + '#' + id, { waitUntil: 'domcontentloaded' });
  await settle();
  // 评估页的示例填充只用于展示静态外观，避免截图里是空白输入框
  if (id === 'evaluate' && !WITH_EVAL) {
    await page.click('#evDemo').catch(() => {});
    await page.waitForTimeout(300);
  }
  await shot(pad(i) + '-' + label);
}

// 组件画廊是独立静态页（不是导航页）
await page.goto(BASE + 'design-system.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await shot(pad(++i) + '-组件画廊');

// 顶部导航的「下拉展开」态：这一版导航收成 4 栏 + 下拉，必须留一张证据图，
// 否则截图上只有 4 个栏目名，看不出里面还藏着 8 个入口。
await page.goto(BASE + '#cv', { waitUntil: 'domcontentloaded' });
await settle();
await page.click('.nav-col:nth-child(1) .nav-col-head');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, pad(++i) + '-顶部导航-下拉展开.png') });
console.log('  ✓ ' + pad(i) + '-顶部导航-下拉展开.png');

// 移动端两态
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
await mob.goto(BASE + '#evaluate', { waitUntil: 'domcontentloaded' });
await mob.waitForTimeout(1500);
await mob.screenshot({ path: path.join(OUT, pad(++i) + '-移动端-390.png'), fullPage: true });
console.log('  ✓ ' + pad(i) + '-移动端-390.png');

await mob.click('#navToggle').catch(() => {});
await mob.waitForTimeout(600);
await mob.screenshot({ path: path.join(OUT, pad(++i) + '-移动端-抽屉导航.png') });
console.log('  ✓ ' + pad(i) + '-移动端-抽屉导航.png');
await mob.close();

const staticCount = i;

// 可选「初筛结果」态（15）：跑一次真实初筛，展示分数条与两阶段按钮
if (WITH_EVAL) {
  console.log('\n跑一次真实初筛（约 40 秒）…');
  await page.goto(BASE + '#evaluate', { waitUntil: 'domcontentloaded' });
  await settle();
  await page.click('#evDemo');
  await page.click('#evGo');
  await page.waitForFunction(() => {
    const s = document.querySelector('#evState');
    return s && /初筛完成|未完成|失败/.test(s.textContent);
  }, null, { timeout: 300000 });
  await page.waitForTimeout(500);
  await shot('15-评估岗位-初筛结果');
}

// 可选「添加条目」态（16）：展示教育背景 / 证书 / 奖项都已加成条目。
// 只动内存草稿、**绝不点保存**，所以不会写 cv-form.json 或 cv.md。
if (WITH_CV) {
  console.log('\n加几条简历条目（不保存）…');
  await page.goto(BASE + '#cv', { waitUntil: 'domcontentloaded' });
  await settle();
  await page.waitForSelector('[data-add="education"]');
  for (const kind of ['education', 'certifications', 'awards']) {
    await page.click('[data-add="' + kind + '"]');
    await page.waitForTimeout(800);
  }
  await page.evaluate(() => {
    document.querySelector('[data-add="education"]')
      .closest('.card').scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(400);
  // 这里不用 shot()：简历页整体很长，fullPage 会截出一张没法看的巨图，
  // 所以只截当前视口，并且比静态页略高一点以便同时看到「保存并生成 cv.md（有未保存改动）」
  const file = path.join(OUT, '16-简历编辑器-添加条目.png');
  await page.screenshot({ path: file });
  console.log('  ✓ 16-简历编辑器-添加条目.png');
}

await browser.close();

console.log('\n控制台错误：' + (problems.length ? problems.slice(0, 3).join(' | ') : '0 个'));
console.log('静态 ' + staticCount + ' 张'
  + (WITH_EVAL ? ' + 初筛结果' : '')
  + (WITH_CV ? ' + 简历添加' : '') + '。');
// 用 exitCode 而不是 process.exit()：管道下 stdout 异步，process.exit() 会丢输出
process.exitCode = problems.length ? 1 : 0;
