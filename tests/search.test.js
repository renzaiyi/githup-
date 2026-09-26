/**
 * 搜索结果页测试。
 *
 * 用 fixtures-search.html（依 2026-09-22 真机实测结构还原）验证：
 *   1. 搜索页用专用选择器，不误用仓库正文选择器
 *   2. 界面噪音（语言/星数/时间/话题标签/按钮）不被收集
 *   3. 仓库描述被收集，且被高亮词切断的句子能重新聚合完整
 *   4. 安全边界依然成立（输入框不被碰）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));

function loadSearchDom() {
  const html = readFileSync(join(here, 'fixtures-search.html'), 'utf8');
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.NodeFilter = dom.window.NodeFilter;
  global.MutationObserver = dom.window.MutationObserver;
  return dom;
}

const { collectTextNodes, findContentContainers } = await import('../src/core/dom.js');

/** 按搜索页策略收集 */
function collectSearch() {
  const report = findContentContainers({
    fallbackAllowed: false,
    useSearchSelectors: true,
  });
  return { report, units: collectTextNodes({ report }) };
}

/* ------------------------------------------------------------------ */

test('搜索页：用专用容器，且不误命中仓库正文选择器', () => {
  loadSearchDom();
  const { report } = collectSearch();

  assert.equal(report.usedSearchSelectors, true, '应标记为使用搜索选择器');
  assert.equal(report.elements.length, 1, `应只认一个外层容器，实际 ${report.elements.length}`);
  assert.equal(
    report.matchedSelectors[0].selector,
    '[data-testid="results-list"]',
    '应命中 results-list'
  );
  // 专用排除规则必须真的带进 report（否则收集阶段拿不到）
  assert.match(
    String(report.excludeSelector),
    /TopicLabel/,
    'report 里必须带搜索专用排除规则'
  );
});

test('★ 搜索页：界面噪音不被收集（真机曾收集到 158 条垃圾）', () => {
  loadSearchDom();
  const { units } = collectSearch();
  const texts = units.map((u) => u.text);
  const joined = texts.join(' || ');

  // 注意用**精确匹配**而不是 includes ——
  // "JavaScript" / "TypeScript" 作为编程语言是噪音，
  // 但它们完全可能合法地出现在仓库描述正文里（例如
  // "Cheatsheets ... getting started with TypeScript"），
  // 用 includes 会把正常描述误判为噪音（这个误报已在本测试中修正过）。
  assert.ok(!texts.includes('JavaScript'), '编程语言标签被单独收集了');
  assert.ok(!texts.includes('TypeScript'), '编程语言标签被单独收集了');
  assert.ok(!texts.includes('251k'), '星数被收集了');
  assert.ok(!texts.includes('Updated'), '更新时间被收集了');
  assert.ok(!texts.includes('yesterday'), '相对时间被收集了');
  assert.ok(!texts.includes('Updated 16 days ago'), '相对时间被收集了');
  assert.ok(!texts.includes('javascript'), '话题标签被收集了');
  assert.ok(!texts.includes('Star'), 'Star 按钮被收集了');

  // 侧栏筛选界面：整个区域都该被排除
  assert.ok(!joined.includes('Filter by'), '侧栏被收集了');
  assert.ok(!joined.includes('Advanced search'), '侧栏被收集了');
  assert.ok(!joined.includes('Languages'), '侧栏被收集了');

  // 更强的整体断言：收集到的单元应当**只有**两条仓库描述
  assert.equal(
    units.length,
    2,
    `搜索页应只收集 2 条仓库描述，实际 ${units.length} 条：\n` +
      texts.map((t) => `  · ${t}`).join('\n')
  );
});

test('★ 搜索页：孤立的高亮词不被单独收集', () => {
  loadSearchDom();
  const { units } = collectSearch();
  const texts = units.map((u) => u.text);

  // <em>react</em> 这类高亮标记不应成为独立的翻译单元
  assert.ok(!texts.includes('react'), '孤立高亮词 "react" 被单独收集了');
  assert.ok(!texts.includes('React'), '孤立高亮词 "React" 被单独收集了');
});

test('★ 搜索页：被高亮词切断的描述应重新聚合为完整句子', () => {
  loadSearchDom();
  const { units } = collectSearch();
  const texts = units.map((u) => u.text);

  // fixture 里描述是 "The library for web and native" + <em>react</em> + "user interfaces."
  // 内层两个 span 的深度大于父 div，早期实现会让它们各自成句，
  // 导致描述被永久切成两段（实测现象）。现在应聚合为一句。
  const desc = texts.find((t) => t.startsWith('The library for web'));
  assert.ok(desc, '仓库描述未被收集');
  assert.ok(
    desc.includes('user interfaces'),
    `描述没有被聚合完整，实际只拿到："${desc}" —— 说明聚合没跨过高亮元素`
  );

  // 反向断言：不应存在被切开的残片
  assert.ok(
    !texts.includes('The library for web and native'),
    '描述前半段被当成了独立单元（聚合失效）'
  );
  assert.ok(
    !texts.includes('user interfaces.'),
    '描述后半段被当成了独立单元（聚合失效）'
  );

  // 聚合单元应确实覆盖多个文本节点
  const descUnit = units.find((u) => u.text.startsWith('The library for web'));
  assert.ok(
    descUnit.nodes.length >= 2,
    `聚合单元应覆盖多个文本节点，实际 ${descUnit.nodes.length} 个`
  );
});

test('搜索页：无高亮的普通描述也能完整收集', () => {
  loadSearchDom();
  const { units } = collectSearch();
  const joined = units.map((u) => u.text).join(' || ');

  assert.ok(
    joined.includes('Cheatsheets for experienced React developers getting started with TypeScript'),
    '完整描述未被收集'
  );
});

test('搜索页：不收集仓库名（应被标识符判定挡住）', () => {
  loadSearchDom();
  const { units } = collectSearch();
  const texts = units.map((u) => u.text);

  assert.ok(!texts.includes('facebook/'), '仓库名被收集了');
  assert.ok(!texts.includes('typescript-cheatsheets/'), '仓库名被收集了');
});

test('★ 搜索页：安全边界依然成立（输入框不被碰）', () => {
  loadSearchDom();
  const { units } = collectSearch();

  const FORBIDDEN = new Set(['INPUT', 'TEXTAREA', 'PRE', 'CODE']);
  for (const unit of units) {
    for (const node of unit.nodes) {
      let cur = node.parentElement;
      while (cur) {
        assert.ok(
          !FORBIDDEN.has(cur.tagName),
          `违规：${cur.tagName} 里的文本被收集`
        );
        assert.ok(!cur.isContentEditable, '违规：可编辑区域被收集');
        cur = cur.parentElement;
      }
    }
  }

  const joined = units.map((u) => u.text).join(' || ');
  assert.ok(!joined.includes('react hooks'), '搜索框 value 被收集了');
  assert.ok(!joined.includes('Search or jump to'), '搜索框 placeholder 被收集了');
});
