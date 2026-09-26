/**
 * DOM 层测试（jsdom）。
 *
 * 【为什么这个测试最重要】
 * 我无法在真实浏览器里点按钮，所以"输入框绝不被碰"这个承诺不能只靠我说。
 * 这个测试从 fixtures.html 加载一份模拟的 GitHub DOM，调用真实的 collectTextNodes()，
 * 然后做两件事：
 *   1. 正向断言：该被翻译的文本确实被收集到了。
 *   2. 反向断言（更关键）：扫描每一条被收集文本节点的完整父链，
 *      证明其中没有任何一条位于 INPUT / TEXTAREA / contenteditable / PRE / CODE 之下。
 *
 * 第 2 条是"结构性证明"，比逐条举例强得多 —— 它覆盖所有节点，而不是抽样。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));

/** 每次都用一个全新的 DOM，避免测试之间互相污染 */
function loadDom(fixture = 'fixtures.html') {
  const html = readFileSync(join(here, fixture), 'utf8');
  const dom = new JSDOM(html, { pretendToBeVisual: true });

  // 把 jsdom 的全局对象挂到 Node 全局上，供 dom.js 使用
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.NodeFilter = dom.window.NodeFilter;
  global.MutationObserver = dom.window.MutationObserver;

  return dom;
}

/**
 * 模块只导入一次。
 * 它只在被调用时读取 document，所以换 DOM 之后重新调用即可 ——
 * 反复 import 会命中 ESM 缓存，反而拿不到新的模块状态。
 */
const {
  collectTextNodes,
  findContentContainers,
  getLastReport,
  injectTranslation,
  applyMode,
  removeAllTranslations,
  countInjected,
} = await import('../src/core/dom.js');

const { injectStyles } = await import('../src/core/styles.js');

/* ================================================================== */
/* 主流程：模拟的 GitHub 页面                                          */
/* ================================================================== */

test('collectTextNodes 在模拟 GitHub DOM 上能正常返回（不抛错）', () => {
  loadDom();
  const entries = collectTextNodes();
  assert.ok(Array.isArray(entries), '应返回数组');
  assert.ok(entries.length > 0, `应收集到文本，实际 ${entries.length} 条`);
  for (const entry of entries) {
    assert.ok(Array.isArray(entry.nodes) && entry.nodes.length > 0, '每条都应带 nodes 数组');
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.trim().length > 0, '不应有空白文本');
  }
});

test('★ 结构性证明：没有任何被收集的文本位于输入控件或代码标签之下', () => {
  loadDom();
  const entries = collectTextNodes();

  const FORBIDDEN = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'PRE', 'CODE', 'SCRIPT', 'STYLE']);

  const violations = [];
  for (const entry of entries) {
    // 一个单元可能包含多个文本节点，逐个都要检查
    for (const node of entry.nodes) {
      let current = node.parentElement;
      while (current) {
        if (FORBIDDEN.has(current.tagName)) {
          violations.push(`${current.tagName} > "${entry.text.slice(0, 40)}"`);
        }
        if (current.isContentEditable) {
          violations.push(`contenteditable > "${entry.text.slice(0, 40)}"`);
        }
        current = current.parentElement;
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `发现 ${violations.length} 条违规（译文会被注入到输入控件或代码里）：\n${violations.join('\n')}`
  );
});

test('★ 输入框的 value 与 placeholder 都未进入收集结果', () => {
  loadDom();
  const entries = collectTextNodes();
  const texts = entries.map((e) => e.text);
  const joined = texts.join(' || ');

  assert.ok(!texts.includes('react hooks'), '搜索框 value 被收集了');
  assert.ok(!texts.includes('useState<T>'), '代码搜索框 value 被收集了');
  assert.ok(
    !joined.includes('This PR fixes the memory leak in useEffect'),
    'textarea value 被收集了'
  );
  assert.ok(
    !joined.includes('editable rich text with English words'),
    'contenteditable 内容被收集了'
  );
  assert.ok(!joined.includes('Search or jump to'), 'placeholder 被收集了');
  assert.ok(!joined.includes('Search code'), 'placeholder 被收集了');
  assert.ok(!joined.includes('Leave a comment'), 'textarea placeholder 被收集了');
});

test('代码块、diff 表格与代码注释被跳过', () => {
  loadDom();
  const entries = collectTextNodes();
  const joined = entries.map((e) => e.text).join(' || ');

  assert.ok(!joined.includes('npm install'), '围栏代码块被翻译了');
  assert.ok(!joined.includes('npm run build'), '构建命令被翻译了');
  assert.ok(!joined.includes('fix: resolve the memory leak'), 'commit 信息被翻译了');
  assert.ok(!joined.includes('this comment must not be translated'), '代码注释被翻译了');
  assert.ok(!joined.includes('oldValue'), 'diff 表格被翻译了');
  assert.ok(!joined.includes('process.env.API_KEY'), '代码内容被翻译了');
});

test('正文内容确实被收集（不能"全都跳过"导致毫无效果）', () => {
  loadDom();
  const entries = collectTextNodes();
  const texts = entries.map((e) => e.text);
  const joined = texts.join(' || ');

  // 注意：断言用 includes 而不是精确相等 ——
  // 聚合功能会把同一段里的行内碎片合并成完整句子
  // （例如 "See the" + "official documentation" + "for more details." 变成一句），
  // 所以精确匹配会误判为"未收集"。
  assert.ok(joined.includes('Awesome Project'), 'README 标题未收集');
  assert.ok(
    texts.some((t) => t.startsWith('Run the following command')),
    'README 段落未收集'
  );
  assert.ok(
    texts.some((t) => t.startsWith('The application crashes')),
    'Issue 描述未收集'
  );
  assert.ok(
    texts.some((t) => t.startsWith('I can reproduce this')),
    '评论正文未收集'
  );
  assert.ok(
    texts.includes('But this nested paragraph should still be translated.'),
    '嵌套在白名单容器内的正文被误杀（过度排除）'
  );
  assert.ok(joined.includes('Enable verbose logging output'), '表格单元格未收集');
  assert.ok(joined.includes('official documentation'), '链接文字未收集');

  // 聚合功能的正向验证：链接所在的那句话应当是完整的一句，
  // 而不是被拆成 "See the" / "official documentation" / "for more details." 三段
  assert.ok(
    texts.some((t) => t.includes('See the') && t.includes('official documentation')),
    '链接所在句子未被聚合成完整句 —— 逐节点翻译会产生碎片'
  );
});

test('标识符类短串不被当作可翻译文本', () => {
  loadDom();
  const entries = collectTextNodes();
  const texts = entries.map((e) => e.text);

  assert.ok(!texts.includes('v2.3.1'), '版本号应被跳过');
  assert.ok(!texts.includes('--verbose'), '命令行选项应被跳过');
  assert.ok(!texts.includes('GITHUB_TOKEN'), '环境变量名应被跳过');
});

test('注入译文不会破坏原文，且可完整复原', () => {
  loadDom();

  const inputBefore = document.getElementById('repoSearch').value;
  const entries = collectTextNodes();
  const target = entries.find((e) => e.text === 'Awesome Project');
  assert.ok(target, '应能找到 README 标题节点');

  injectTranslation(target.nodes, '超棒的项目');
  applyMode('bilingual');

  const readme = document.getElementById('readme');
  assert.ok(readme.textContent.includes('Awesome Project'), '原文被破坏了');
  assert.ok(readme.textContent.includes('超棒的项目'), '译文未注入');
  assert.equal(countInjected(), 1, '应恰好注入 1 条');

  assert.equal(
    document.getElementById('repoSearch').value,
    inputBefore,
    '注入译文后输入框 value 被改动了'
  );

  removeAllTranslations();
  assert.equal(countInjected(), 0, '复原后不应残留译文');
  assert.ok(readme.textContent.includes('Awesome Project'));
  assert.ok(!readme.textContent.includes('超棒的项目'));
});

test('重复注入同一节点不会产生重复译文', () => {
  loadDom();
  const entries = collectTextNodes();
  const target = entries.find((e) => e.text === 'Awesome Project');

  injectTranslation(target.nodes, '第一次');
  injectTranslation(target.nodes, '第二次');
  assert.equal(countInjected(), 1, '同一节点重复注入应更新而不是新增');
  assert.ok(document.getElementById('readme').textContent.includes('第二次'));

  removeAllTranslations();
});

test('已注入译文的节点不会被再次收集（天然增量，不会重复计费）', () => {
  loadDom();
  const first = collectTextNodes();
  const target = first.find((e) => e.text === 'Awesome Project');
  injectTranslation(target.nodes, '超棒的项目');

  const second = collectTextNodes();
  assert.equal(
    second.find((e) => e.text === 'Awesome Project'),
    undefined,
    '已翻译的原文节点被重复收集了 —— 会导致重复付费'
  );

  removeAllTranslations();
});

/* ================================================================== */
/* 选择器健壮性：诊断报告与降级兜底                                    */
/* ================================================================== */

test('findContentContainers 返回可读的诊断报告', () => {
  loadDom();
  const report = findContentContainers();

  assert.ok(Array.isArray(report.matchedSelectors), 'matchedSelectors 应为数组');
  assert.ok(report.elements.length > 0, '应找到内容容器');
  assert.equal(report.usedFallback, false, '主选择器能命中时不应降级');

  // 报告里必须能看出是哪个选择器命中的 —— 这是 GitHub 改版时的排查依据
  for (const m of report.matchedSelectors) {
    assert.equal(typeof m.selector, 'string');
    assert.ok(m.count > 0, '命中的选择器计数应大于 0');
  }
  assert.ok(
    report.matchedSelectors.some((m) => m.selector.includes('markdown-body')),
    '报告中应包含 markdown-body 的命中记录'
  );
});

test('collectTextNodes 写入了 lastReport，供 popup 诊断使用', () => {
  loadDom();
  collectTextNodes();
  const report = getLastReport();

  assert.ok(report, '应写入诊断报告');
  assert.ok(report.containerCount > 0);
  assert.ok(report.textNodeCount > 0);
  assert.ok(Array.isArray(report.sample) && report.sample.length > 0, '样本不应为空');
  assert.ok(report.sample[0].length <= 80, '样本应被截断，避免报告过长');
});

test('★ 主选择器全部失效时自动降级到兜底，而不是静默什么都不翻', () => {
  loadDom('fixtures-fallback.html');
  const report = findContentContainers();
  const entries = collectTextNodes({ report });
  const texts = entries.map((e) => e.text);

  assert.equal(report.usedFallback, true, '没有任何 markdown-body 时应标记为降级模式');
  assert.ok(entries.length > 0, '降级模式下仍应能翻到正文');

  // 正文段落要翻到
  assert.ok(
    texts.some((t) => t.startsWith('This paragraph lives inside a plain main element')),
    '兜底未收集到 main 里的段落'
  );
  assert.ok(
    texts.some((t) => t.startsWith('A list item that should also be collected')),
    '兜底未收集到列表项'
  );

  // 界面外壳必须被排除 —— 这是兜底最容易出错的地方
  assert.ok(!texts.some((t) => t.includes('Pull requests')), '兜底翻到了导航栏');
  assert.ok(!texts.some((t) => t.includes('Watch') && t.includes('Fork')), '兜底翻到了仓库头部');
  assert.ok(!texts.some((t) => t.includes('Terms of Service')), '兜底翻到了页脚');
  assert.ok(!texts.some((t) => t.includes('const leaked')), '兜底翻到了代码块');
});

test('★ 降级模式下仍不触碰输入控件（兜底不能成为安全漏洞）', () => {
  loadDom('fixtures-fallback.html');
  const report = findContentContainers();
  const entries = collectTextNodes({ report });

  // 结构性证明在降级模式下同样成立
  const FORBIDDEN = new Set(['INPUT', 'TEXTAREA', 'PRE', 'CODE', 'SELECT']);
  const violations = [];
  for (const entry of entries) {
    for (const node of entry.nodes) {
      let current = node.parentElement;
      while (current) {
        if (FORBIDDEN.has(current.tagName)) violations.push(current.tagName);
        if (current.isContentEditable) violations.push('contenteditable');
        current = current.parentElement;
      }
    }
  }
  assert.deepEqual(violations, [], '降级模式下出现了违规收集');

  const joined = entries.map((e) => e.text).join(' || ');
  assert.ok(!joined.includes('fallback search value'), '降级模式下搜索框 value 被收集了');
  assert.ok(!joined.includes('Search or jump to'), '降级模式下 placeholder 被收集了');
});

test('复原后同样的文本可以重新被收集（processedNodes 被正确重置）', () => {
  loadDom();
  const first = collectTextNodes();
  for (const entry of first) injectTranslation(entry.nodes, '译文');
  assert.equal(collectTextNodes().length, 0, '全部翻译后不应再收集到任何节点');

  removeAllTranslations();
  const after = collectTextNodes();
  assert.ok(after.length > 0, '复原后应能重新收集（否则重置翻译会失效）');
});

test('★ fallbackAllowed=false 时禁用兜底（目录页/代码页不该被乱翻）', () => {
  loadDom('fixtures-fallback.html');

  // 同一个页面：允许兜底时会翻到东西
  const allowed = findContentContainers({ fallbackAllowed: true });
  assert.equal(allowed.usedFallback, true);
  assert.ok(collectTextNodes({ report: allowed }).length > 0, '允许兜底时应有结果');

  // 禁用兜底后：一个都不翻
  const blocked = findContentContainers({ fallbackAllowed: false });
  assert.equal(blocked.usedFallback, false, '不应标记为降级');
  assert.equal(blocked.fallbackBlocked, true, '应标记为"兜底被禁止"');
  assert.equal(blocked.elements.length, 0, '禁用兜底后不应有任何容器');

  const entries = collectTextNodes({ report: blocked });
  assert.equal(entries.length, 0, '禁用兜底后不应收集任何文本');
});

test('isFallbackAllowedForPage 对无正文页面返回 false', async () => {
  const { isFallbackAllowedForPage } = await import('../src/shared/github-context.js');

  // 本来就没有正文的页面
  assert.equal(isFallbackAllowedForPage('directory'), false, '目录页');
  assert.equal(isFallbackAllowedForPage('file_view'), false, '源码文件页');
  assert.equal(isFallbackAllowedForPage('commit'), false, '提交详情页');
  assert.equal(isFallbackAllowedForPage('releases_list'), false, '发行版列表页');

  // 有正文的页面
  assert.equal(isFallbackAllowedForPage('repository_home'), true, '仓库首页');
  assert.equal(isFallbackAllowedForPage('issue'), true, 'Issue 页');
  assert.equal(isFallbackAllowedForPage('pull_request'), true, 'PR 页');
  assert.equal(isFallbackAllowedForPage('discussion'), true, 'Discussion 页');
  assert.equal(isFallbackAllowedForPage('release'), true, 'Release 页');
  // 未知类型要保守地允许（宁可能翻，也不要静默失效）
  assert.equal(isFallbackAllowedForPage('other'), true, '未知类型');
  assert.equal(isFallbackAllowedForPage(undefined), true, '未定义类型');
});

/* ================================================================== */
/* 纯中文模式与聚合（2026-09-22 真机暴露的功能缺失）                    */
/* ================================================================== */

test('★ 注入时会把原文包进可隐藏的 wrapper（纯中文模式的前提）', () => {
  loadDom();
  const entries = collectTextNodes();
  const target = entries.find((e) => e.text.includes('Awesome Project'));
  assert.ok(target, '应找到 README 标题单元');

  injectTranslation(target.nodes, '超棒的项目');

  // 这是纯中文模式能生效的关键：必须存在一个承载"原文"语义的元素
  const wrapper = document.querySelector('[data-ghst-role="original"]');
  assert.ok(wrapper, '原文没有被包进 wrapper —— 纯中文模式将无法隐藏原文');
  assert.ok(
    wrapper.textContent.includes('Awesome Project'),
    'wrapper 里应当包含原文'
  );

  const translation = document.querySelector('[data-ghst-role="translation"]');
  assert.ok(translation, '译文元素缺失');
  assert.equal(translation.textContent, '超棒的项目');

  removeAllTranslations();
});

test('★ 纯中文模式：CSS 规则能命中原文 wrapper（曾经是死代码）', () => {
  loadDom();
  injectStyles();

  const entries = collectTextNodes();
  const target = entries.find((e) => e.text.includes('Awesome Project'));
  injectTranslation(target.nodes, '超棒的项目');
  applyMode('zh');

  // 1) html 上的模式标记必须写上
  assert.equal(
    document.documentElement.getAttribute('data-ghst-mode'),
    'zh',
    'html 上未写入 data-ghst-mode'
  );

  // 2) 样式表里必须存在针对 [data-ghst-role="original"] 的隐藏规则
  const style = document.getElementById('ghst-style');
  assert.ok(style, '样式表未注入');
  assert.ok(
    /\[data-ghst-role="original"\]\s*\{[^}]*display:\s*none/.test(style.textContent),
    '样式表里缺少隐藏原文的规则 —— 这正是当初「纯中文无效果」的根因'
  );

  removeAllTranslations();
});

test('★ 聚合：同一块里的行内碎片应合并成一个翻译单元', () => {
  loadDom();
  const entries = collectTextNodes();

  const unitsWithMultipleNodes = entries.filter((e) => e.nodes.length > 1);
  assert.ok(
    unitsWithMultipleNodes.length > 0,
    '没有任何多节点单元 —— 聚合功能没有生效，译文仍会是碎片'
  );

  // fixtures 里 "See the <a>official documentation</a> for more details."
  // 应当被合并成一个单元，而不是三个碎片
  const sentence = entries.find(
    (e) => e.text.includes('See the') && e.text.includes('official documentation')
  );
  assert.ok(sentence, '含链接的句子没有被聚合');
  assert.ok(
    sentence.nodes.length >= 2,
    `含链接的句子应覆盖多个文本节点，实际 ${sentence.nodes.length} 个`
  );
  assert.ok(
    sentence.text.includes('for more details'),
    '聚合后应包含句尾，说明整句都被覆盖'
  );
});

test('聚合不会把代码块内容并进句子', () => {
  loadDom();
  const entries = collectTextNodes();
  const joined = entries.map((e) => e.text).join(' || ');

  // fixtures 里 <pre><code> 紧跟在含 GITHUB_TOKEN 的段落之后，
  // 聚合只能在同一块内进行，绝不能跨块把代码吃进来
  assert.ok(!joined.includes('npm install'), '聚合把代码块内容并进来了');
  assert.ok(!joined.includes('npm run build'), '聚合把构建命令并进来了');
  assert.ok(!joined.includes('process.env.API_KEY'), '聚合把代码并进来了');
});

test('聚合后仍不触碰输入控件（安全边界不能被聚合绕过）', () => {
  loadDom();
  const entries = collectTextNodes();

  const FORBIDDEN = new Set(['INPUT', 'TEXTAREA', 'PRE', 'CODE']);
  for (const entry of entries) {
    for (const node of entry.nodes) {
      let current = node.parentElement;
      while (current) {
        assert.ok(
          !FORBIDDEN.has(current.tagName),
          `聚合后出现违规：${current.tagName} 里的文本被收集`
        );
        current = current.parentElement;
      }
    }
  }
});
