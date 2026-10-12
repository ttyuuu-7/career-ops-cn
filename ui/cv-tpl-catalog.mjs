// ui/cv-tpl-catalog.mjs — 预置简历模板清单
//
// 2026-10-09：**清单已清空**（用户要求删掉这 100 套 docx 模板）。
// 原 100 套（art/live/lcov/steady/simple 五个系列，来自 D:/桌面/模板 批量生成）
// 全是 Word 文件：预览要走 Word COM 合成 → 转 PDF → 页图进 Shadow DOM，
// 本质是**图片**；改一个字要等服务端重合成十几秒、首屏空白、文字不能选中。
// 「我的简历」页的实时预览 2026-10-09 已改为纯 HTML 渲染，这 100 套与新的
// 预览机制是两套并存的路径，留着只会让用户在两种体验之间莫名切换。
//
// 现在模板库只剩 4 套**代码定义**的 HTML 模板：
//   模板1/2/3（base 1/2/3，style.css 的 .cvp-tplN 三档）
//   双栏黄·图文简历（base 4，ui/cv-tpl-dual.mjs）
//
// 恢复办法：从备份目录（D:/桌面/backup-tpl-100docx-*）拷回本文件与
// data/tpl-catalog、data/tpl-catalog-pdf 即可 —— 清单是纯数据，没有副作用。
//
// 保留本文件（而不是删掉）：cv-templates.mjs 仍在 import 它的导出，
// 删文件会让整条模块图断掉。留一个空数组最省事，也留下这段说明。
export const CV_TPL_CATALOG = [];
