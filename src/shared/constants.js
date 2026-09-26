/**
 * 全局常量与配置默认值。
 * 这些值被 content script / popup / background 共享（ES module）。
 */

/** 存储键名（chrome.storage.local） */
export const STORAGE_KEYS = {
  apiKey: 'ghst_apiKey',
  model: 'ghst_model',
  baseUrl: 'ghst_baseUrl',
  mode: 'ghst_mode', // 'off' | 'zh' | 'bilingual'
  autoTranslate: 'ghst_autoTranslate',
  glossary: 'ghst_glossary',
};

/** 显示模式 */
export const MODES = {
  OFF: 'off',
  ZH: 'zh', // 纯译文：隐藏原文，只显示中文
  BILINGUAL: 'bilingual', // 双语：原文在上，译文在下
};

export const DEFAULT_SETTINGS = {
  apiKey: '',
  // 注意：DeepSeek 模型名会随官方调整，可在 popup 里改。
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com/v1',
  mode: MODES.BILINGUAL,
  autoTranslate: false,
  glossary: '',
};

/**
 * 提示词版本号。
 * 只要提示词内容有改动，就把它 +1 —— 它参与缓存键计算，
 * 这样旧的缓存会自动失效，不会拿旧提示词产出的译文糊弄你。
 */
export const PROMPT_VERSION = 'p1';

/**
 * 这些标签【绝不进入】遍历。
 *
 * 这是整个扩展最重要的安全边界：
 * INPUT / TEXTAREA 在这里被挡住，所以你键入的英文永远不会被改写。
 * PRE / CODE 被挡住，所以代码块永远不会被翻译。
 */
export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
  'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
  'SVG', 'CANVAS', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK', 'BASE',
  'RT', 'RP',
]);

/** 这些标签自身不翻，但子节点要翻 */
export const PASSTHROUGH_TAGS = new Set(['BODY', 'HTML', 'DIV', 'SPAN', 'SECTION', 'ARTICLE', 'MAIN']);

/**
 * 允许被翻译的"内容容器"选择器。
 *
 * 【分级设计 —— 这是选择器失效时的第一道保险】
 * 1 级：经过真实页面验证的稳定选择器（`.markdown-body` 已确认存在于当前 GitHub）
 * 2 级：宽松的命名模式（GitHub 的 CSS Module 类名带随机后缀，只能用包含匹配）
 * 3 级：兜底启发式（见 EXCLUDE_UI_SELECTORS 与 dom.js 里的 fallback）
 *
 * 采用白名单而非黑名单：宁可少翻，绝不把导航栏、按钮、diff 翻坏。
 */
export const CONTENT_SELECTORS = [
  // ---- 1 级：已验证的稳定选择器 ----
  '.markdown-body',
  'article.markdown-body',

  // ---- 2 级：宽松模式（GitHub CSS Module 类名形如 Xxx-module__Name__hash） ----
  '[class*="SharedMarkdownContent"]',
  '[class*="DirectoryRichtextContent"]',

  // ---- Issue / PR / Discussion / Release 正文与评论 ----
  '.comment-body',
  '.js-comment-body',
  '[data-testid="issue-body"]',
  '[data-testid="comment-body"]',
  '[data-testid="release-body"]',
  '[data-testid="discussion-body"]',
  '[class*="IssueBody"]',
  '[class*="ReleaseBody"]',
  '[class*="DiscussionBody"]',
  '.release-body',
  '.discussion-body',
];

/**
 * 搜索结果页专用容器选择器。
 *
 * 【为什么只保留最外层容器 · 真机实测的教训】
 * 最初这里还列了 `.search-title` 与 `.search-match`，结果描述被切成碎片：
 *   "Cheatsheets for experienced" / "developers getting started with TypeScript"
 *
 * 根因：聚合只能在**同一个容器内**进行。把内层的 .search-match 也当容器后，
 * 描述被高亮切成的多个 span 分属不同容器，聚合就无从下手了。
 *
 * 正确做法：只认 `[data-testid="results-list"]` 这一个外层容器，
 * 让 findContentContainers 的"跳过嵌套容器"逻辑 + 块级聚合去处理内部结构。
 * 实测这样描述会重新拼成完整句子。
 *
 * 真机实测（2026-09-22）：
 *   <div class="List-module__List__j9yVV" data-testid="results-list">  ← 唯一容器
 *     └ <div class="Result-module__Result__I0WVD">
 *         └ ... <span class="search-match">描述</span> <em>高亮词</em> <span class="search-match">描述续</span>
 */
export const SEARCH_CONTENT_SELECTORS = [
  '[data-testid="results-list"]',
  // 旧版 GitHub / 其他入口的兜底容器（实测当前命中 0，保留作兼容）
  '.repo-list',
  '.codesearch-results',
];

/**
 * 搜索结果页的额外排除规则。
 *
 * 【为什么必须单独一份 · 真机实测发现的问题】
 * 只用 SEARCH_CONTENT_SELECTORS 会把大量界面元数据也当成正文，
 * 实测 `react` 仓库搜索收集到 158 条单元，但样本全是
 * "JavaScript"、"Updated yesterday"、"251k"、"Star" 这类噪音 ——
 * 真正要翻的仓库描述反而被挤掉了。
 *
 * 实测第一项的内部结构（2026-09-22）：
 *   <span class="search-match">react/</span>                      ← 仓库名，不翻
 *   <span class="search-match">The library for web...</span>      ← 仓库描述，要翻
 *   <a class="TopicLabel-module__topicLabel__WAFkQ">javascript</a> ← 话题标签，不翻
 *   <span>JavaScript</span>  <span>251k</span>                    ← 语言/星数，不翻
 *   <span>Updated</span> <span>yesterday</span>                   ← 时间，不翻
 *   <span class="prc-Button-Label-FWkx3">Star</span>              ← 按钮，不翻
 *
 * 注意：仓库描述与仓库名**共用 search-match 这个类**，无法靠选择器区分，
 * 所以仓库名交给 looksLikeIdentifier('react/') 过滤；
 * 这里的规则负责挡掉话题标签、时间、语言、按钮等结构性噪音。
 */
export const SEARCH_EXCLUDE_SELECTORS = [
  // 结果项的页脚区：语言 / 星数 / 更新时间 / Star 按钮都在这里。
  // 【真机实测】"JavaScript"、"Updated yesterday" 的祖先链是：
  //   <span> → <li class="Footer-module__footerItem__H6aUw">
  //   → <ul class="Footer-module__footer__rWx13">
  // 注意不能用 `footer` 这个标签选择器 —— GitHub 用的是
  // Footer-module__footer 这个 **class**，标签选择器匹配不到。
  '[class*="Footer-module"]',
  '[class*="footerItem"]',
  '[class*="footer__"]',
  // 搜索关键词高亮标记。
  // 【真机实测】仓库描述被高亮切成碎片：
  //   "Cheatsheets for experienced" + <em>developers</em> + "getting started with TypeScript"
  // 裸 <em> 里只有一个关键词（"react"/"React"/"ReAct"，连大小写都不一致），
  // 单独翻译没有意义。排除 em 有一举两得的效果：
  //   1. 不再产生"翻译 react"这种无意义请求
  //   2. 被高亮切断的句子会重新拼接完整，聚合质量更高
  'em',
  'mark',
  '[class*="SearchMatchText"] em',
  // 话题标签
  '[class*="TopicLabel"]',
  '[class*="topic-tag"]',
  '.topic-tag',
  // 时间元素（实测当前搜索页没有 relative-time，但保留以兼容其他版本）
  'relative-time',
  'time',
  // 按钮与图标
  '[class*="Button"]',
  '[class*="button"]',
  'button',
  '[role="button"]',
  'svg',
  'img',
  'nav',
  'header',
  'footer',
];
// 注意：曾经想用 '[data-testid="results-list"] > div > div:first-child'
// 排除"结果项头部次要信息区"，但探针实测它会**连仓库描述一起排除** ——
// 描述的祖先链是：
//   <span class="search-match"> → <div class="Content-module__Content__EMhAj">
//   → <div class="Repositories-module__resultContent__X93zw"> → ...
// 也就是说描述就在 :first-child 那个容器里。这条规则已删除。
//
// 同理，绝不能写 [class*="Content"] —— 会误杀描述所在的 Content-module__Content。

/**
 * 3 级兜底启发式：当上面全部没匹配到内容时，退而求其次在这些容器里
 * 找"段落级"文本（p / li / h1-h6 / blockquote / td）。
 *
 * 兜底只在"主选择器完全没命中"时才启用，并会在诊断信息里标记为降级模式，
 * 这样即使 GitHub 大改版，扩展也不会静默失效。
 */
export const FALLBACK_CONTAINER_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '.application-main',
];

/**
 * 这些是"界面外壳"，即使在兜底容器的范围内也必须排除。
 *
 * 【重要教训 · 2026-09-22 用真实浏览器验证后修正】
 * 这里曾经包含 `[class*="OverviewContent"]` 和 `[class*="Sidebar"]`，
 * 在真实页面上它们会把 README 一起排除掉，导致**一个字都翻不了**：
 *   - `[class*="OverviewContent"]` 命中了 17 个元素，其中一个正是包裹 README 的
 *     `OverviewContent-module__Box_11__F19kY`（README 的第 3 层祖先）
 *   - `[class*="Sidebar"]` 命中 73 个元素，连 `prc-PageLayout-*` 布局包装层都匹配上了
 *
 * 根因：GitHub 的 CSS Module 类名是**实现细节**，React 改版后语义会变。
 * `OverviewContent` 在旧版布局里是侧栏，新版里成了整页内容容器。
 *
 * 所以现在只保留**语义稳定**的规则：语义化标签、ARIA role、精确的稳定 ID。
 * 因为内容侧已经是白名单（只认 .markdown-body 这类），
 * 排除侧不需要激进也能保证安全 —— 宁可少排除，也不能误杀正文。
 */
export const EXCLUDE_UI_SELECTORS = [
  // 语义化标签与 ARIA —— 这些是稳定的
  'header',
  'footer',
  'nav',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="menu"]',
  '[role="menubar"]',
  // 稳定 ID
  '[aria-labelledby="folders-and-files"]',
  '#repository-container-header',
  '#repos-file-tree',
  '#diff-content',
  // 代码类 —— 与 SKIP_TAGS 互为双保险
  'table.diff-table',
  '.diff-table',
  '.blob-wrapper',
  '.blob-code',
  // 注意：不要再用 [class*="..."] 匹配布局包装层，见上方教训
];

/**
 * 即使在白名单容器内部，这些子树也必须排除。
 * 这是第二道防线（纵深防御）：比如 README 里嵌的代码高亮块、diff、文件树。
 */
export const EXCLUDE_SELECTORS = [
  // 代码相关 —— 绝不翻译
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  '.highlight',
  '.blob-wrapper',
  '.blob-code',
  'table.diff-table',
  '.diff-table',
  '[data-testid="diff"]',
  // 界面外壳 —— 复用上面的 UI 排除清单，避免两处规则不一致
  ...EXCLUDE_UI_SELECTORS,
  // 可编辑区域
  '[contenteditable="true"]',
  '[contenteditable=""]',
  // 我们自己注入的内容，防止递归翻译
  '.ghst-translation',
  '.ghst-original-hidden',
];

/** 单个文本节点最短长度（去空白后）。太短的片段（如 "ok"）翻译成本高、收益低。 */
export const MIN_TEXT_LENGTH = 2;

/** 单个文本节点最长长度。超过则截断不翻（防御异常大的节点）。 */
export const MAX_TEXT_LENGTH = 4000;

/** 一批最多提交多少条文本（控制单次请求大小与失败影响面） */
export const BATCH_SIZE = 20;

/** 并发请求上限 */
export const MAX_CONCURRENCY = 3;

/** 请求超时（毫秒） */
export const REQUEST_TIMEOUT = 60000;

/** 单条请求失败重试次数 */
export const MAX_RETRIES = 2;

/** 扩展注入元素的类名前缀 */
export const NS = 'ghst';
