/**
 * 注入到页面里的样式。
 * 以 CSS 字符串 + <style> 注入，而不是 <link> 引用外部文件：
 * 避免异步加载导致的样式闪烁（FOUC），也少一处可能的加载失败点。
 *
 * 结构约定（见 core/dom.js 的 injectTranslation）：
 *   原文被包进  <span class="ghst-original" data-ghst-role="original">
 *   译文是      <span class="ghst-translation" data-ghst-role="translation">
 *   显示模式挂在 <html data-ghst-mode="zh|bilingual">
 */
export const STYLE_ID = 'ghst-style';

export const CSS = `
/* ------------------------------------------------------------------
 * 原文块：默认可见。双语模式下与译文并列显示。
 * ------------------------------------------------------------------ */
.ghst-original {
  /* 原文保持原样，不加任何视觉改动 —— 避免干扰阅读 */
}

/* ------------------------------------------------------------------
 * 译文块：独立成段，左侧蓝色竖条标识"这是译文"
 * ------------------------------------------------------------------ */
.ghst-translation {
  display: block;
  margin: 4px 0 8px 0;
  padding-left: 10px;
  border-left: 3px solid rgba(56, 139, 253, 0.45);
  color: inherit;
  opacity: 0.96;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ------------------------------------------------------------------
 * 行内场景：译文不要独立成块，与原文并排、用细竖条分隔。
 * 覆盖链接、加粗、标题、列表项、表格单元格等"本身是行内语义"的容器。
 * ------------------------------------------------------------------ */
a > .ghst-translation,
span > .ghst-translation,
strong > .ghst-translation,
em > .ghst-translation,
b > .ghst-translation,
i > .ghst-translation,
small > .ghst-translation,
h1 > .ghst-translation,
h2 > .ghst-translation,
h3 > .ghst-translation,
h4 > .ghst-translation,
h5 > .ghst-translation,
h6 > .ghst-translation,
p > .ghst-translation,
li > .ghst-translation {
  display: inline;
  margin: 0 0 0 6px;
  padding-left: 6px;
  border-left: 2px solid rgba(56, 139, 253, 0.4);
}

/* ------------------------------------------------------------------
 * 纯中文模式：隐藏原文，只留译文。
 *
 * 【这是本文件曾经失效的地方】
 * 早期版本写了 .ghst-original-hidden 的隐藏规则，但代码从未给任何元素
 * 加上那个类名 —— 规则等于死代码，所以切到「纯中文」毫无效果。
 * 现在原文统一包在 [data-ghst-role="original"] 里，隐藏才有目标。
 * ------------------------------------------------------------------ */
html[data-ghst-mode="zh"] [data-ghst-role="original"] {
  display: none !important;
}

/* 纯中文模式下译文不需要竖条（没有原文作对比了） */
html[data-ghst-mode="zh"] .ghst-translation {
  border-left: none;
  padding-left: 0;
  margin-left: 0;
}
html[data-ghst-mode="zh"] a > .ghst-translation,
html[data-ghst-mode="zh"] span > .ghst-translation,
html[data-ghst-mode="zh"] strong > .ghst-translation,
html[data-ghst-mode="zh"] em > .ghst-translation,
html[data-ghst-mode="zh"] b > .ghst-translation,
html[data-ghst-mode="zh"] i > .ghst-translation,
html[data-ghst-mode="zh"] small > .ghst-translation,
html[data-ghst-mode="zh"] h1 > .ghst-translation,
html[data-ghst-mode="zh"] h2 > .ghst-translation,
html[data-ghst-mode="zh"] h3 > .ghst-translation,
html[data-ghst-mode="zh"] h4 > .ghst-translation,
html[data-ghst-mode="zh"] h5 > .ghst-translation,
html[data-ghst-mode="zh"] h6 > .ghst-translation,
html[data-ghst-mode="zh"] p > .ghst-translation,
html[data-ghst-mode="zh"] li > .ghst-translation {
  display: inline;
  margin: 0;
  padding-left: 0;
  border-left: none;
}

/* 表格里不要把布局挤坏 */
td .ghst-translation,
th .ghst-translation {
  display: block;
  margin: 2px 0;
}

/* 深色模式适配 */
@media (prefers-color-scheme: dark) {
  .ghst-translation {
    border-left-color: rgba(88, 166, 255, 0.5);
  }
}

/* ------------------------------------------------------------------
 * 页面提示条
 * ------------------------------------------------------------------ */
.ghst-toast {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  max-width: 460px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.5;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #fff;
  background: #1f6feb;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease;
  white-space: pre-wrap;
}

.ghst-toast[data-visible="1"] {
  opacity: 1;
  transform: translateY(0);
}

.ghst-toast[data-level="success"] { background: #1a7f37; }
.ghst-toast[data-level="warning"] { background: #9a6700; }
.ghst-toast[data-level="error"]   { background: #cf222e; }
.ghst-toast[data-level="info"]    { background: #1f6feb; }
`;

/** 把样式注入到页面（幂等） */
export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}
