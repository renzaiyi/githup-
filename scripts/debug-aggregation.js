/**
 * 调试聚合循环：为什么 content div 的关键词没被聚合？
 * 直接复刻 dom.js 的聚合判定，逐块打印结果。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  SKIP_TAGS, CONTENT_SELECTORS, SEARCH_CONTENT_SELECTORS, SEARCH_EXCLUDE_SELECTORS,
  EXCLUDE_SELECTORS, NS,
} from '../src/shared/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../tests/fixtures-search.html'), 'utf8');
const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;

// 与 dom.js 保持一致的定义
const AGGREGATABLE_TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','TD','TH','DD','DT','SUMMARY','FIGCAPTION']);
const INLINE_TAGS = new Set(['A','SPAN','STRONG','EM','B','I','U','S','SMALL','SUB','SUP','FONT','MARK','ABBR','CITE','Q','TIME','LABEL','BDI','BDO','WBR','CODE','KBD','SAMP','VAR','IMG','PICTURE','BR']);
const CONTAINER_LIKE_TAGS = new Set(['DIV','SPAN','SECTION','ARTICLE','TD','TH']);
const MAX_CONTAINER_DIV_LENGTH = 1500;
const SEARCH_EXCLUDE_SELECTOR = [...EXCLUDE_SELECTORS, ...SEARCH_EXCLUDE_SELECTORS].join(',');

const container = document.querySelector('[data-testid="results-list"]');
console.log('容器:', container.tagName, container.getAttribute('data-testid'));

const blocks = Array.from(
  container.querySelectorAll([...AGGREGATABLE_TAGS, ...CONTAINER_LIKE_TAGS].join(','))
);
console.log('\n候选块总数:', blocks.length);

const depthOf = (el) => {
  let d = 0, cur = el.parentElement;
  while (cur && cur !== container) { d++; cur = cur.parentElement; }
  return d;
};
blocks.sort((a, b) => depthOf(b) - depthOf(a));

const isInlineDisplayed = (el) => {
  try { return window.getComputedStyle(el).display.startsWith('inline'); } catch { return false; }
};
const isVisible = (el) => {
  try {
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  } catch { return true; }
};

console.log('\n=== 逐块判定 ===');
for (const el of blocks) {
  const isSemantic = AGGREGATABLE_TAGS.has(el.tagName);
  const isContainerLike = CONTAINER_LIKE_TAGS.has(el.tagName);
  const ownText = (el.textContent || '').trim();
  const reasons = [];
  if (!isSemantic && !isContainerLike) reasons.push('非语义块也非容器标签');
  if (!isSemantic) {
    if (ownText.length === 0) reasons.push('自身文本为空');
    if (ownText.length > MAX_CONTAINER_DIV_LENGTH) reasons.push('自身文本过长 ' + ownText.length);
  }
  for (const child of el.children) {
    if (!INLINE_TAGS.has(child.tagName) && !isInlineDisplayed(child)) {
      reasons.push('含嵌套块子元素 <' + child.tagName + '>');
      break;
    }
  }
  if (!isVisible(el)) reasons.push('不可见');
  if (el.closest(SEARCH_EXCLUDE_SELECTOR)) reasons.push('命中排除规则');

  const verdict = reasons.length === 0 ? '\x1b[32m可聚合\x1b[0m' : '\x1b[31m跳过\x1b[0m: ' + reasons.join('; ');
  console.log(`  [d=${depthOf(el)}] <${el.tagName}> cls="${String(el.className || '').slice(0, 40)}"`);
  console.log(`       文本="${ownText.slice(0, 45)}"  → ${verdict}`);
}
