/**
 * 纯逻辑单元测试。运行：node --test tests/
 *
 * 这些测试覆盖无法靠肉眼检查的部分：
 * 文本筛选规则、缓存键、上下文识别、模型输出解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashString,
  cacheKey,
  normalizeText,
  hasTranslatableContent,
  looksLikeChinese,
  looksLikeIdentifier,
  chunk,
  mapWithConcurrency,
} from '../src/shared/util.js';

import { parseModelOutput, alignToItems, TranslateError } from '../src/core/parse.js';
import { parseGlossary, buildSystemPrompt, buildUserPrompt } from '../src/shared/prompts.js';
import { parseRepoFromUrl, detectPageType, isFallbackAllowedForPage, getContentStrategy, buildPageContext } from '../src/shared/github-context.js';

/* ------------------------------------------------------------------ */
/* 文本筛选：这些规则决定了"什么会被翻"。错一条就会翻坏页面。            */
/* ------------------------------------------------------------------ */

test('normalizeText 折叠空白', () => {
  assert.equal(normalizeText('  hello   world \n\t! '), 'hello world !');
});

test('hasTranslatableContent 需要至少两个连续字母', () => {
  assert.equal(hasTranslatableContent('Hello'), true);
  assert.equal(hasTranslatableContent('v1.2.3'), false, '版本号不该被认为可翻译');
  assert.equal(hasTranslatableContent('12345'), false);
  assert.equal(hasTranslatableContent('!@#$%'), false);
});

test('looksLikeChinese 识别已有中文', () => {
  assert.equal(looksLikeChinese('这是一个中文句子'), true);
  assert.equal(looksLikeChinese('This is English'), false);
  // 中英混排且英文占比不低 → 判为"需要翻译"（CJK 占比约 33%，低于 35% 阈值）
  assert.equal(looksLikeChinese('混合 mixed 内容 content'), false);
  // 中文为主、只夹一个英文专名 → 不该重复翻译
  assert.equal(looksLikeChinese('这是一个非常长的中文句子，里面提到了 GitHub 这个平台'), true);
  // 纯符号/数字不应崩
  assert.equal(looksLikeChinese('12345'), false);
  assert.equal(looksLikeChinese(''), false);
});

test('looksLikeIdentifier 挡住不该翻的短串', () => {
  // 应该挡住
  assert.equal(looksLikeIdentifier('https://example.com/a/b'), true, 'URL');
  assert.equal(looksLikeIdentifier('src/utils/host/filter.ts'), true, '文件路径');
  assert.equal(looksLikeIdentifier('v1.2.3'), true, '版本号');
  assert.equal(looksLikeIdentifier('1.2.3-beta.1'), true, '语义化版本');
  assert.equal(looksLikeIdentifier('getUserById'), true, 'camelCase');
  assert.equal(looksLikeIdentifier('GITHUB_TOKEN'), true, 'SCREAMING_SNAKE');
  assert.equal(looksLikeIdentifier('foo_bar_baz'), true, 'snake_case');
  assert.equal(looksLikeIdentifier('foo()'), true, '函数调用');
  assert.equal(looksLikeIdentifier('Foo::bar'), true, 'Rust 路径');
  assert.equal(looksLikeIdentifier('@scope/package'), true, 'npm 包名');

  // 不该挡住（这些是真正的自然语言）
  assert.equal(looksLikeIdentifier('Install dependencies'), false, '正常英文句子');
  assert.equal(looksLikeIdentifier('Hello world'), false);
  assert.equal(looksLikeIdentifier('Run the tests'), false);
});

/* ------------------------------------------------------------------ */
/* 缓存键：决定"省钱"是否真的生效，以及改提示词后缓存是否失效            */
/* ------------------------------------------------------------------ */

test('hashString 稳定且对不同输入产生不同结果', () => {
  assert.equal(hashString('abc'), hashString('abc'), '同输入必须同输出');
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.match(hashString('anything'), /^[0-9a-f]{8}$/);
  // 长文本不应溢出或抛错
  assert.match(hashString('x'.repeat(50000)), /^[0-9a-f]{8}$/);
});

test('cacheKey 对不同维度都敏感', () => {
  const base = {
    text: 'Hello',
    contextKey: 'vuejs/core:repository_home',
    targetLang: 'zh-CN',
    promptVersion: 'p1',
    model: 'deepseek-flash',
  };
  const k = (patch) => cacheKey({ ...base, ...patch });

  assert.equal(k({}), k({}), '同参数必须命中同一键');
  assert.notEqual(k({}), k({ text: 'Hello!' }), '文本变化');
  assert.notEqual(k({}), k({ contextKey: 'other/repo:issue' }), '页面上下文变化');
  assert.notEqual(k({}), k({ promptVersion: 'p2' }), '提示词版本变化 → 旧缓存必须失效');
  assert.notEqual(k({}), k({ model: 'deepseek-v4-pro' }), '换模型');
});

/* ------------------------------------------------------------------ */
/* 模型输出解析：模型不听话时的容错                                    */
/* ------------------------------------------------------------------ */

test('parseModelOutput 解析标准输出', () => {
  const out = parseModelOutput('{"translations":[{"i":0,"t":"你好"},{"i":1,"t":"世界"}]}');
  assert.equal(out.get(0), '你好');
  assert.equal(out.get(1), '世界');
});

test('parseModelOutput 容忍 ```json 围栏', () => {
  const out = parseModelOutput('```json\n{"translations":[{"i":0,"t":"你好"}]}\n```');
  assert.equal(out.get(0), '你好');
});

test('parseModelOutput 容忍前后多余文字', () => {
  const out = parseModelOutput('好的，以下是译文：{"translations":[{"i":0,"t":"你好"}]} 完成。');
  assert.equal(out.get(0), '你好');
});

test('parseModelOutput 容忍直接返回数组', () => {
  const out = parseModelOutput('[{"i":0,"t":"你好"}]');
  assert.equal(out.get(0), '你好');
});

test('parseModelOutput 对垃圾输入抛出可重试错误', () => {
  assert.throws(() => parseModelOutput('这不是 JSON'), (e) => {
    assert.ok(e instanceof TranslateError);
    assert.equal(e.retriable, true, '格式错误应该可重试');
    return true;
  });
  assert.throws(() => parseModelOutput(''), TranslateError);
  assert.throws(() => parseModelOutput('{"foo":1}'), TranslateError);
  assert.throws(() => parseModelOutput(null), TranslateError);
});

test('alignToItems 缺项时回退原文，绝不错位', () => {
  const items = [
    { i: 0, text: 'one' },
    { i: 1, text: 'two' },
    { i: 2, text: 'three' },
  ];
  // 模型只返回了 0 和 2，漏掉了 1
  const byIndex = new Map([
    [0, '一'],
    [2, '三'],
  ]);
  const aligned = alignToItems(byIndex, items);
  assert.equal(aligned.get(0), '一');
  assert.equal(aligned.get(1), 'two', '缺项必须回退为原文，而不是 undefined');
  assert.equal(aligned.get(2), '三');
  assert.equal(aligned.size, 3);
});

test('alignToItems 拒绝空字符串译文', () => {
  const items = [{ i: 0, text: 'original' }];
  const aligned = alignToItems(new Map([[0, '   ']]), items);
  assert.equal(aligned.get(0), 'original', '空白译文应回退原文');
});

/* ------------------------------------------------------------------ */
/* 提示词与术语表                                                      */
/* ------------------------------------------------------------------ */

test('parseGlossary 解析多种分隔符', () => {
  const g = parseGlossary(
    [
      '# 这是注释，应被忽略',
      'repository => 仓库',
      'pull request = 拉取请求',
      'issue：议题',
      '',
      '  fork : 复刻  ',
    ].join('\n')
  );
  const map = new Map(g);
  assert.equal(map.get('repository'), '仓库');
  assert.equal(map.get('pull request'), '拉取请求');
  assert.equal(map.get('issue'), '议题');
  assert.equal(map.get('fork'), '复刻');
  assert.equal(g.length, 4, '注释与空行不计入');
  assert.equal(map.has('# 这是注释，应被忽略'), false);
});

test('parseGlossary 空输入不抛错', () => {
  assert.deepEqual(parseGlossary(''), []);
  assert.deepEqual(parseGlossary(null), []);
  assert.deepEqual(parseGlossary('   \n  '), []);
});

test('buildSystemPrompt 包含关键约束', () => {
  const prompt = buildSystemPrompt({
    pageContext: { description: '当前页面：仓库首页\n所属仓库：vuejs/core' },
    glossary: 'repository => 仓库',
  });
  // 必须包含红线
  assert.match(prompt, /一律原样保留/);
  assert.match(prompt, /代码/);
  assert.match(prompt, /URL/);
  // 必须包含上下文
  assert.match(prompt, /vuejs\/core/);
  // 必须包含术语表
  assert.match(prompt, /repository => 仓库/);
  // 必须包含产品名保留清单
  assert.match(prompt, /Copilot/);
  // 必须包含 JSON 输出格式约束
  assert.match(prompt, /translations/);
  // 必须包含正反例
  assert.match(prompt, /差：|好：/);
  // 没有术语表时也要有兜底文案，不能出现 undefined
  const noGlossary = buildSystemPrompt({ pageContext: {}, glossary: '' });
  assert.doesNotMatch(noGlossary, /undefined/);
});

test('buildUserPrompt 保持 i 索引一一对应', () => {
  const items = [
    { i: 0, text: 'Hello' },
    { i: 1, text: 'World' },
  ];
  const parsed = JSON.parse(buildUserPrompt(items));
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].i, 0);
  assert.equal(parsed.segments[0].text, 'Hello');
  assert.equal(parsed.segments[1].i, 1);
});

/* ------------------------------------------------------------------ */
/* GitHub 上下文识别                                                   */
/* ------------------------------------------------------------------ */

test('parseRepoFromUrl 正确识别仓库', () => {
  assert.equal(
    parseRepoFromUrl('https://github.com/vuejs/core').fullName,
    'vuejs/core'
  );
  assert.equal(
    parseRepoFromUrl('https://github.com/vuejs/core/blob/main/README.md').fullName,
    'vuejs/core'
  );
  assert.equal(
    parseRepoFromUrl('https://github.com/microsoft/vscode/issues/123').fullName,
    'microsoft/vscode'
  );
});

test('parseRepoFromUrl 拒绝保留路径与站外地址', () => {
  assert.equal(parseRepoFromUrl('https://github.com/settings/profile'), null, 'settings 不是仓库');
  assert.equal(parseRepoFromUrl('https://github.com/notifications'), null);
  assert.equal(parseRepoFromUrl('https://github.com/search?q=test'), null);
  assert.equal(parseRepoFromUrl('https://github.com/topics/javascript'), null);
  assert.equal(parseRepoFromUrl('https://example.com/foo/bar'), null, '站外地址');
  assert.equal(parseRepoFromUrl('https://github.com'), null, '首页');
});

test('★ 应用页（Dashboard 等）必须识别为 app_page 并禁止兜底', () => {
  const full = (u) => detectPageType(u);

  // 真机实测：github.com/dashboard 曾被误判为 profile，
  // 导致兜底命中 main 却收集到 0 条正文，用户看到令人困惑的提示。
  assert.equal(full('https://github.com/dashboard'), 'app_page');
  assert.equal(full('https://github.com/notifications'), 'app_page');
  assert.equal(full('https://github.com/settings/profile'), 'app_page');
  assert.equal(full('https://github.com/codespaces'), 'app_page');
  assert.equal(full('https://github.com/marketplace'), 'app_page');
  assert.equal(full('https://github.com/explore'), 'app_page');
  assert.equal(full('https://github.com/topics/javascript'), 'app_page');
  assert.equal(full('https://github.com/orgs/vuejs/dashboard'), 'app_page');
  // 无 q 参数的 /search 只是个空搜索页，仍算应用页
  assert.equal(full('https://github.com/search'), 'app_page');
  // 注意：带 q 的 /search 不是应用页 —— 它是搜索结果页，有真实可翻内容，
  // 见下面专门的搜索页测试。

  // 这些页面全部禁止兜底
  for (const u of [
    'https://github.com/dashboard',
    'https://github.com/notifications',
    'https://github.com/settings/profile',
    'https://github.com/codespaces',
    'https://github.com/explore',
    'https://github.com/topics/javascript',
    'https://github.com/search',
  ]) {
    assert.equal(
      isFallbackAllowedForPage(detectPageType(u)),
      false,
      `${u} 是应用页，必须禁止兜底`
    );
  }

  // 但不能误伤：真正的用户主页与仓库页仍应允许兜底
  assert.notEqual(full('https://github.com/torvalds'), 'app_page', '用户主页不该被判为应用页');
  assert.notEqual(full('https://github.com/vuejs/core'), 'app_page', '仓库首页不该被判为应用页');
  assert.equal(isFallbackAllowedForPage(full('https://github.com/torvalds')), true);
  assert.equal(isFallbackAllowedForPage(full('https://github.com/vuejs/core')), true);
});

test('★ 搜索结果页：识别、选择器分流与查询词上下文', () => {
  const full = (u) => detectPageType(u);

  // ---- 1. 页面类型识别 ----
  // GitHub 把搜索信息全放在查询串里，pathname 只有 /search，
  // 所以 detectPageType 必须解析 searchParams 才能正确分类。
  assert.equal(full('https://github.com/search?q=react&type=repositories'), 'search');
  assert.equal(full('https://github.com/search?q=react&type=issues'), 'search');
  assert.equal(full('https://github.com/search?q=react&type=pullrequests'), 'search');
  assert.equal(full('https://github.com/search?q=react&type=discussions'), 'search');
  assert.equal(full('https://github.com/search?q=react&type=users'), 'search');
  // 代码搜索单独归类：结果全是代码片段，翻了没意义
  assert.equal(full('https://github.com/search?q=react&type=code'), 'search_code');
  // 无 type 参数时 GitHub 默认搜代码
  assert.equal(full('https://github.com/search?q=react'), 'search_code');
  // 没有 q 参数就不是搜索结果页
  assert.equal(full('https://github.com/search'), 'app_page');

  // ---- 2. 选择器分流 ----
  // 搜索页结构（[data-testid="results-list"]）与仓库正文（.markdown-body）
  // 完全不同，混用会互相误命中，所以必须分流。
  const searchStrategy = getContentStrategy('search');
  assert.equal(searchStrategy.useSearchSelectors, true, '搜索页必须用专用选择器');
  assert.equal(searchStrategy.allowFallback, false, '搜索页不该用 main/article 兜底');

  const repoStrategy = getContentStrategy('repository_home');
  assert.equal(repoStrategy.useSearchSelectors, false, '仓库页不该用搜索选择器');
  assert.equal(repoStrategy.allowFallback, true, '仓库页应允许兜底');

  const codeStrategy = getContentStrategy('search_code');
  assert.equal(codeStrategy.useSearchSelectors, false, '代码搜索不翻');
  assert.equal(codeStrategy.allowFallback, false, '代码搜索禁用兜底，避免翻筛选栏');
});

test('★ 搜索页的提示词上下文要带上查询词', async () => {
  // buildPageContext 会读 document.title，而 core.test.js 是纯 Node 环境
  // （没有 DOM）。这里临时造一个最小 DOM —— 内容脚本的真实运行环境里
  // document 一定存在，所以这不是"为测试放宽要求"，而是补上缺失的环境。
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><title>Repository search results · GitHub</title>');
  const savedDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const ctx = buildPageContext(
      'https://github.com/search?q=state+management&type=repositories'
    );

    assert.equal(ctx.type, 'search');
    // 把查询词交给模型：搜 "state management" 时 state 应译作"状态"而非"州"
    assert.match(ctx.description, /state management/, '提示词里应包含查询词');
    assert.match(ctx.description, /搜索结果页面/, '应说明这是搜索页');
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    dom.window.close();
  }
});

test('detectPageType 识别页面类型', () => {
  const t = (p) => detectPageType(`https://github.com/o/r${p}`);
  assert.equal(t('/pull/123'), 'pull_request');
  assert.equal(t('/issues/456'), 'issue');
  assert.equal(t('/discussions/7'), 'discussion');
  assert.equal(t('/releases/tag/v1.0.0'), 'release');
  assert.equal(t('/blob/main/src/a.js'), 'file_view');
  assert.equal(t('/tree/main/src'), 'directory');
  assert.equal(t('/commit/abc123'), 'commit');
  assert.equal(t(''), 'repository_home');
});

test('★ 列表页与详情页必须区分（列表页无正文，不能启用兜底）', () => {
  const t = (p) => detectPageType(`https://github.com/o/r${p}`);

  // 列表页 —— 无正文
  assert.equal(t('/discussions'), 'discussions_list', '/discussions 是列表页');
  assert.equal(t('/discussions/'), 'discussions_list');
  assert.equal(t('/issues'), 'issues_list');
  assert.equal(t('/pulls'), 'pulls_list');
  assert.equal(t('/releases'), 'releases_list');
  assert.equal(t('/actions'), 'actions');

  // 详情页 —— 有正文
  assert.equal(t('/discussions/7'), 'discussion', '/discussions/7 是正文页');
  assert.equal(t('/issues/456'), 'issue');
  assert.equal(t('/pull/123'), 'pull_request');

  // diff 视图单独识别（实测 diff 内容在 .diff-table/.blob-code，不在 <pre> 里）
  assert.equal(t('/pull/200000/files'), 'pull_request_files');
  assert.equal(t('/pull/123/commits'), 'pull_request_files');
  assert.equal(t('/pull/123/checks'), 'pull_request_files');
  assert.equal(
    isFallbackAllowedForPage(t('/pull/200000/files')),
    false,
    'diff 页必须禁止兜底，否则可能去翻代码改动'
  );

  // 关键区分：列表页禁止兜底，详情页允许
  // （依据：vuejs/core/discussions 实测兜底会命中 202 个段落级元素，那些是讨论标题预览）
  for (const listPath of ['/discussions', '/issues', '/pulls', '/releases', '/actions']) {
    assert.equal(
      isFallbackAllowedForPage(t(listPath)),
      false,
      `${listPath} 是列表页，必须禁止兜底`
    );
  }
  for (const detailPath of ['/discussions/7', '/issues/456', '/pull/123']) {
    assert.equal(
      isFallbackAllowedForPage(t(detailPath)),
      true,
      `${detailPath} 是详情页，应允许兜底`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

test('chunk 正确切块', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1], 3), [[1]]);
});

test('mapWithConcurrency 保持顺序且限制并发', async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);

  const results = await mapWithConcurrency(items, 3, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return item * 2;
  });

  assert.deepEqual(results, items.map((i) => i * 2), '结果顺序必须与输入一致');
  assert.ok(maxActive <= 3, `并发数不能超过 3，实际 ${maxActive}`);
});

test('mapWithConcurrency 单个失败不影响其他项', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
    if (item === 2) throw new Error('boom');
    return item;
  });
  assert.equal(results[0], 1);
  assert.ok(results[1]?.error instanceof Error, '失败项应被包装为 { error }');
  assert.equal(results[2], 3);
});
