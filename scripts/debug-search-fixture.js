/**
 * 调试搜索 fixture 的收集结果：打印实际收集到的单元与噪声。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../tests/fixtures-search.html'), 'utf8');
const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only' });
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.NodeFilter = dom.window.NodeFilter;
global.MutationObserver = dom.window.MutationObserver;

const { collectTextNodes, findContentContainers } = await import('../src/core/dom.js');
const domModule = await import('../src/core/dom.js');

const report = findContentContainers({ fallbackAllowed: false, useSearchSelectors: true });
console.log('=== report ===');
console.log('容器数:', report.elements.length);
console.log('命中:', report.matchedSelectors.map((m) => m.selector + 'x' + m.count).join(', '));
console.log('exclude 含 TopicLabel:', /TopicLabel/.test(report.excludeSelector));
console.log('exclude 含 Footer-module:', /Footer-module/.test(report.excludeSelector));
console.log('exclude 含 em:', /(^|,)em(,|$)/.test(report.excludeSelector));

const units = collectTextNodes({ report });
console.log('\n=== 收集到的单元 (' + units.length + ') ===');
for (const u of units) {
  console.log(`  [${u.nodes.length}节点] "${u.text}"`);
  for (const n of u.nodes) {
    const p = n.parentElement;
    console.log(`      ← <${p.tagName}> cls="${String(p.className || '').slice(0, 55)}"`);
  }
}

console.log('\n=== 页面里的 footer 元素 ===');
const footers = document.querySelectorAll('[class*="Footer-module"]');
console.log('数量:', footers.length);
for (const f of footers) {
  console.log(`  <${f.tagName}> cls="${f.className}"  子文本="${f.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
}
