/**
 * GitHub 智能翻译 · 内容脚本（自动生成，请勿直接编辑）
 *
 * 由 scripts/build-content.js 从以下模块打包而成：
 *   - src/shared/constants.js  (19 个顶层声明, 7533 字节)
 *   - src/shared/util.js  (10 个顶层声明, 3272 字节)
 *   - src/shared/settings.js  (3 个顶层声明, 1942 字节)
 *   - src/shared/cache.js  (10 个顶层声明, 2834 字节)
 *   - src/shared/prompts.js  (4 个顶层声明, 2605 字节)
 *   - src/shared/github-context.js  (11 个顶层声明, 7283 字节)
 *   - src/core/parse.js  (3 个顶层声明, 2505 字节)
 *   - src/core/translate.js  (2 个顶层声明, 3841 字节)
 *   - src/core/dom.js  (27 个顶层声明, 16740 字节)
 *   - src/core/styles.js  (3 个顶层声明, 4527 字节)
 *   - src/content/main.js  (11 个顶层声明, 12721 字节)
 *
 * 【为什么要打包成单文件】
 * manifest 用 "type": "module" 时内容脚本是异步加载的，会导致消息监听器
 * 注册晚于 popup 发消息（真机实测症状：「没有运行扩展」）。打包成经典脚本后
 * 同步执行、零 import，把这类失败模式整个消除。
 *
 * 修改源码后请重新运行：npm run build
 */
(function () {
  'use strict';

/* ============================================================
 * 来自 src/shared/constants.js
 * ============================================================ */
/**
 * 全局常量与配置默认值。
 * 这些值被 content script / popup / background 共享（ES module）。
 */

/** 存储键名（chrome.storage.local） */
const STORAGE_KEYS = {
  apiKey: 'ghst_apiKey',
  model: 'ghst_model',
  baseUrl: 'ghst_baseUrl',
  mode: 'ghst_mode', // 'off' | 'zh' | 'bilingual'
  autoTranslate: 'ghst_autoTranslate',
  glossary: 'ghst_glossary',
};

/** 显示模式 */
const MODES = {
  OFF: 'off',
  ZH: 'zh', // 纯译文：隐藏原文，只显示中文
  BILINGUAL: 'bilingual', // 双语：原文在上，译文在下
};

const DEFAULT_SETTINGS = {
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
const PROMPT_VERSION = 'p1';

/**
 * 这些标签【绝不进入】遍历。
 *
 * 这是整个扩展最重要的安全边界：
 * INPUT / TEXTAREA 在这里被挡住，所以你键入的英文永远不会被改写。
 * PRE / CODE 被挡住，所以代码块永远不会被翻译。
 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
  'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
  'SVG', 'CANVAS', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'TITLE', 'META', 'LINK', 'BASE',
  'RT', 'RP',
]);

/** 这些标签自身不翻，但子节点要翻 */
const PASSTHROUGH_TAGS = new Set(['BODY', 'HTML', 'DIV', 'SPAN', 'SECTION', 'ARTICLE', 'MAIN']);

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
const CONTENT_SELECTORS = [
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
const SEARCH_CONTENT_SELECTORS = [
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
const SEARCH_EXCLUDE_SELECTORS = [
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
const FALLBACK_CONTAINER_SELECTORS = [
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
const EXCLUDE_UI_SELECTORS = [
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
const EXCLUDE_SELECTORS = [
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
const MIN_TEXT_LENGTH = 2;

/** 单个文本节点最长长度。超过则截断不翻（防御异常大的节点）。 */
const MAX_TEXT_LENGTH = 4000;

/** 一批最多提交多少条文本（控制单次请求大小与失败影响面） */
const BATCH_SIZE = 20;

/** 并发请求上限 */
const MAX_CONCURRENCY = 3;

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 60000;

/** 单条请求失败重试次数 */
const MAX_RETRIES = 2;

/** 扩展注入元素的类名前缀 */
const NS = 'ghst';

/* ============================================================
 * 来自 src/shared/util.js
 * ============================================================ */
/**
 * 小工具函数集合。无依赖，可被任何环境引入。
 */

/** 延迟 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 字符串哈希（FNV-1a 32 位变体，输出 8 位十六进制）。
 * 用途：缓存键。不需要密码学强度，只需要稳定、快、碰撞率够低。
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619，用移位避免 32 位溢出精度问题
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 缓存键：文本 + 上下文 + 目标语言 + 提示词版本。
 * 提示词版本参与计算，所以改提示词后旧缓存自动失效。
 */
function cacheKey({ text, contextKey, targetLang, promptVersion, model }) {
  return hashString(
    [text, contextKey, targetLang, promptVersion, model].join('\u0000')
  );
}

/** 归一化文本：折叠空白，用于比较与缓存（不用于替换，替换要用原文） */
function normalizeText(str) {
  return String(str).replace(/\s+/g, ' ').trim();
}

/** 是否包含可翻译的"自然语言"内容 */
function hasTranslatableContent(str) {
  // 至少包含两个连续字母才算自然语言（挡掉 "v1.2.3"、"foo_bar" 这类标识符）
  return /[A-Za-z]{2,}/.test(str);
}

/**
 * 判断是否"基本已经是中文"：CJK 字符占字母总数的比例超过 35%，就认为不需要翻译。
 *
 * 阈值取 35% 而不是 50%：中文的字符密度天然高，
 * 一段"中文里夹几个英文专名"的文字 CJK 占比通常在 60% 以上，
 * 而"英文里夹几个中文词"会低于 35%。35% 能干净地把两者分开。
 * 注意：混排内容（如 "混合 mixed 内容 content"）占比约 33%，会被判为需要翻译 —— 这是对的，
 * 因为它一半是英文。
 */
function looksLikeChinese(str) {
  const cjk = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const letters = (str.match(/[A-Za-z\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (letters === 0) return false;
  return cjk / letters > 0.35;
}

/** 纯标识符/代码特征 —— 挡掉不该翻的短串 */
function looksLikeIdentifier(str) {
  const s = str.trim();
  if (!s) return true;
  // URL
  if (/^https?:\/\/\S+$/i.test(s)) return true;
  // 命令行选项（--verbose / -rf / --dry-run --force）
  if (/^-{1,2}[A-Za-z][\w-]*(\s+-{1,2}[A-Za-z][\w-]*)*$/.test(s)) return true;
  // 文件路径 / 包名（含斜杠或点号分隔且无空格）
  if (/^[\w./@-]+$/.test(s) && /[./@]/.test(s) && !/\s/.test(s)) return true;
  // 版本号
  if (/^v?\d+(\.\d+)+([-+][\w.]+)?$/i.test(s)) return true;
  // camelCase / snake_case / SCREAMING_CASE 单个词
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return true;
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/i.test(s)) return true;
  // 形如 foo() / foo.bar / Foo::bar
  if (/^[\w$]+(\(\)|\.\w+|::\w+)+$/.test(s)) return true;
  return false;
}

/** 安全地取元素的计算样式（在 iframe/异常环境下不抛错） */
function isVisible(element) {
  try {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  } catch {
    return true;
  }
}

/**
 * 并发受限的 map。
 * 用于批量翻译：一次最多发 N 个请求，避免把 API 打爆或触发限流。
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(run());
  }
  await Promise.all(runners);
  return results;
}

/** 把数组切成固定大小的块 */
function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

/* ============================================================
 * 来自 src/shared/settings.js
 * ============================================================ */
/**
 * 设置读写。统一封装，避免各处直接碰 chrome.storage。
 */

/** 读取全部设置（带默认值兜底） */
async function getSettings() {
  const raw = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    apiKey: raw[STORAGE_KEYS.apiKey] ?? DEFAULT_SETTINGS.apiKey,
    model: raw[STORAGE_KEYS.model] ?? DEFAULT_SETTINGS.model,
    baseUrl: raw[STORAGE_KEYS.baseUrl] ?? DEFAULT_SETTINGS.baseUrl,
    mode: raw[STORAGE_KEYS.mode] ?? DEFAULT_SETTINGS.mode,
    autoTranslate: raw[STORAGE_KEYS.autoTranslate] ?? DEFAULT_SETTINGS.autoTranslate,
    glossary: raw[STORAGE_KEYS.glossary] ?? DEFAULT_SETTINGS.glossary,
  };
}

/** 写入部分设置 */
async function saveSettings(patch) {
  const payload = {};
  if ('apiKey' in patch) payload[STORAGE_KEYS.apiKey] = patch.apiKey;
  if ('model' in patch) payload[STORAGE_KEYS.model] = patch.model;
  if ('baseUrl' in patch) payload[STORAGE_KEYS.baseUrl] = patch.baseUrl;
  if ('mode' in patch) payload[STORAGE_KEYS.mode] = patch.mode;
  if ('autoTranslate' in patch) payload[STORAGE_KEYS.autoTranslate] = patch.autoTranslate;
  if ('glossary' in patch) payload[STORAGE_KEYS.glossary] = patch.glossary;
  await chrome.storage.local.set(payload);
}

/**
 * 监听设置变化。返回取消监听的函数。
 * content script 用它在 popup 改了模式后立即响应。
 */
function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    for (const [storageKey, field] of Object.entries({
      [STORAGE_KEYS.apiKey]: 'apiKey',
      [STORAGE_KEYS.model]: 'model',
      [STORAGE_KEYS.baseUrl]: 'baseUrl',
      [STORAGE_KEYS.mode]: 'mode',
      [STORAGE_KEYS.autoTranslate]: 'autoTranslate',
      [STORAGE_KEYS.glossary]: 'glossary',
    })) {
      if (storageKey in changes) patch[field] = changes[storageKey].newValue;
    }
    if (Object.keys(patch).length > 0) callback(patch);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/* ============================================================
 * 来自 src/shared/cache.js
 * ============================================================ */
/**
 * 译文缓存。
 *
 * 两层结构：
 *   1. 内存 Map —— 当前页面会话内最快，零延迟。
 *   2. IndexedDB —— 跨页面、跨会话持久化。这是省钱的关键：
 *      同一个 README 第二次打开、第二个标签页、明天再看，都是 0 成本 0 延迟。
 *
 * 缓存键 = hash(原文 + 页面上下文 + 目标语言 + 提示词版本 + 模型)
 * 所以：换模型、改提示词 → 旧缓存自动失效，不会串味。
 */

const DB_NAME = 'ghst-cache';
const DB_VERSION = 1;
const STORE = 'translations';

/** 内存层 */
const memory = new Map();

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('byTime', 'time');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** 读一条缓存（先内存，后 IndexedDB） */
async function getCached(key) {
  if (memory.has(key)) return memory.get(key);
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result?.value);
      req.onerror = () => reject(req.error);
    });
    if (typeof value === 'string') {
      memory.set(key, value);
      return value;
    }
  } catch {
    // IndexedDB 不可用（隐私模式等）时静默降级为纯内存缓存
  }
  return undefined;
}

/** 写一批缓存：memory 立即写，IndexedDB 异步写 */
async function setCachedMany(entries) {
  const time = Date.now();
  for (const [key, value] of entries) {
    memory.set(key, value);
  }
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [key, value] of entries) {
        store.put({ key, value, time });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 同上，忽略
  }
}

/** 统计缓存条数 */
async function countCached() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return memory.size;
  }
}

/** 清空缓存（popup 里提供按钮） */
async function clearCache() {
  memory.clear();
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 忽略
  }
}

/* ============================================================
 * 来自 src/shared/prompts.js
 * ============================================================ */
/**
 * 提示词构造。
 *
 * 这是"人性化"的核心。设计原则：
 *   1. 先立"绝对不许动"的红线（代码/标识符/URL）—— 模型最容易在这里出错。
 *   2. 再给页面上下文，让它知道自己在翻技术文档而不是文学。
 *   3. 用 few-shot 正反例纠正"直译腔"—— 光说"要意译"是没用的。
 *   4. 严格约束输出为 JSON，便于程序解析且不会带闲聊。
 */

/** 解析术语表文本（每行 `英文 => 中文`，# 开头为注释） */
function parseGlossary(raw) {
  if (!raw || !raw.trim()) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(.+?)\s*(?:=>|=|：|:)\s*(.+)$/);
    if (match) {
      out.push([match[1].trim(), match[2].trim()]);
    }
  }
  return out;
}

/** 把术语表渲染成提示词里的一段 */
function renderGlossary(glossaryRaw) {
  const entries = parseGlossary(glossaryRaw);
  if (entries.length === 0) {
    return '（用户未提供术语表，请使用中文技术社区最通行的译法，并保证同页前后一致）';
  }
  return entries.map(([from, to]) => `- ${from} => ${to}`).join('\n');
}

/**
 * 构造 system 提示词。
 * @param {{ pageContext: {description: string}, glossary: string }} options
 */
function buildSystemPrompt({ pageContext, glossary }) {
  return `你是资深的中文技术译者，长期参与开源项目本地化，精通 Git 与 GitHub。
你的任务：把用户以 JSON 数组给出的英文文本片段，翻译成简体中文。

${pageContext?.description ? `【当前页面上下文】\n${pageContext.description}\n` : ''}
【第一优先级 · 一律原样保留，绝不翻译】
- 围栏代码块内容、行内代码 \`...\`、命令与参数
- 变量名、函数名、类名、包名、模块名、API 名称
- 文件路径、目录名、文件名、扩展名
- URL、域名、邮箱
- 版本号（v1.2.3）、commit hash、分支名、tag 名、PR/Issue 编号（#123）
- 环境变量名、配置项的 key（如 GITHUB_TOKEN）
- 数学公式、纯符号、表情符号
以上内容保持原样，连大小写和空格都不要改。片段如果本身就不含自然语言（比如只是一个标识符），原样返回。

【术语表 · 严格遵守】
${renderGlossary(glossary)}

【GitHub 产品名保留英文】
Actions、Copilot、Codespaces、Dependabot、Pages、Sponsors、Gist、
Projects、Packages、Discussions、Marketplace、Webhooks、Apps、Runners、
Secrets、Variables、Releases、Environments
（例外：Codespaces 可用官方译法「代码空间」）

【风格 · 最重要】
- 意译优先，绝不逐词直译
- 用中文技术社区的习惯表达，不要英语式语序
- 语气专业、简洁、自然，像同事在说明一件事
- 不要添加原文没有的解释、补充说明或「译者注」
- 原文是命令式就保持命令式；是疑问句就保持疑问句
- 保留原文里的 Markdown 标记（如 **粗体**、\`代码\`、[文字](链接)），
  只翻译"人看的文字"，绝不翻译链接地址

【风格正反例】
英文：Run the following command to install dependencies:
差：运行接下来的命令来安装依赖：
好：执行以下命令安装依赖：

英文：This will not work if the token is missing.
差：如果令牌是丢失的，这将不会工作。
好：缺少令牌时该操作不会生效。

英文：Feel free to open an issue if you hit any problems.
差：如果你撞到任何问题，请随意打开一个议题。
好：遇到问题欢迎提交议题。

【输出格式 · 严格遵守】
只输出一个 JSON 对象，不要有任何其他文字、解释或 Markdown 代码围栏包裹：
{"translations":[{"i":0,"t":"译文"},{"i":1,"t":"译文"}]}
- i 必须与输入片段的 i 一一对应，不能缺项、不能新增、不能改变顺序
- t 是译文，纯文本，不要把整段包在引号或反引号里
- 如果某个片段无法翻译或不需要翻译，t 填原文`;
}

/**
 * 构造 user 提示词（一批片段）。
 * @param {Array<{i: number, text: string}>} items
 */
function buildUserPrompt(items) {
  return JSON.stringify({ segments: items.map((item) => ({ i: item.i, text: item.text })) });
}

/* ============================================================
 * 来自 src/shared/github-context.js
 * ============================================================ */
/**
 * GitHub 页面上下文识别。
 *
 * 为什么需要它：LLM 的译文质量高度依赖"它知不知道自己在翻什么"。
 * 告诉它"这是 git 仓库 vuejs/core 的一个 Issue"，
 * 它就不会把 "issue" 翻成"发行"、也不会把命令翻成中文。
 */

/** 从 URL 中解析仓库所有者与名称 */
function parseRepoFromUrl(url = location.href) {
  try {
    const u = new URL(url);
    if (!/(^|\.)github\.com$/.test(u.hostname)) return null;
    // 排除 github.com 的保留路径
    const reserved = new Set([
      'settings', 'notifications', 'explore', 'marketplace', 'pricing',
      'features', 'about', 'login', 'signup', 'search', 'topics',
      'collections', 'sponsors', 'orgs', 'apps', 'dashboard', 'issues',
      'pulls', 'trending', 'new', 'codespaces', 'organizations',
    ]);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (reserved.has(owner)) return null;
    return { owner, repo, fullName: `${owner}/${repo}` };
  } catch {
    return null;
  }
}

/** 判断当前页面类型 */
function detectPageType(url = location.href) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'other';
  }
  const path = parsed.pathname;

  // ---- 搜索结果页必须最优先判断 ----
  // 它既在 APP_PAGE_PATTERNS 里（/search），又有真实可翻内容。
  // 真机实测：GitHub 搜索用查询串承载全部信息，pathname 只有 "/search"，
  // 所以必须先解析查询参数，再决定用哪套内容选择器。
  if (path === '/search' && parsed.searchParams.get('q')) {
    // 代码搜索的可翻文本是代码片段，翻了没意义还可能破坏语义 → 单独归类
    return getSearchScope(parsed) === 'code' ? 'search_code' : 'search';
  }

  // GitHub 的"应用型页面"：整页都是界面元素，没有正文。
  // 必须放在最前面判断，否则会掉进 profile 分支而被允许兜底 ——
  // 真机实测（github.com/dashboard）：兜底会命中 main 但收集到 0 条正文，
  // 只在页面上留下"没有找到需要翻译的正文"这条令人困惑的提示。
  if (isGitHubAppPage(path)) return 'app_page';

  // diff 视图必须单独识别：这个页面只有代码改动，没有正文。
  // 实测（microsoft/vscode/pull/200000/files）diff 内容在 table.diff-table /
  // .blob-code 里，**不在 <pre> 里** —— 所以光靠 PRE 标签挡不住，
  // 必须把该页面类型列入"无正文"，禁止兜底。
  if (/\/pull\/\d+\/(files|commits|checks)/.test(path)) return 'pull_request_files';
  if (/\/pull\/\d+/.test(path)) return 'pull_request';
  if (/\/issues\/\d+/.test(path)) return 'issue';
  if (/\/discussions\/\d+/.test(path)) return 'discussion';
  if (/\/discussions\/?$/.test(path)) return 'discussions_list';
  if (/\/releases\/tag\//.test(path)) return 'release';
  if (/\/releases\/?$/.test(path)) return 'releases_list';
  if (/\/blob\//.test(path)) return 'file_view';
  if (/\/tree\//.test(path)) return 'directory';
  if (/\/commit\//.test(path)) return 'commit';
  if (/\/actions\/?/.test(path)) return 'actions';
  if (/\/pulls\/?$/.test(path)) return 'pulls_list';
  if (/\/issues\/?$/.test(path)) return 'issues_list';
  if (/^\/[^/]+\/?$/.test(path)) return 'profile';
  if (/^\/[^/]+\/[^/]+\/?$/.test(path)) return 'repository_home';
  return 'other';
}

/**
 * 解析搜索范围。GitHub 用 ?type= 表示，缺省是代码搜索（GitHub 的默认行为）。
 */
function getSearchScope(parsed) {
  const type = (parsed.searchParams.get('type') || '').toLowerCase();
  if (!type) return 'code'; // 无 type 参数时 GitHub 默认搜代码
  if (type.startsWith('repositor')) return 'repositories';
  if (type.startsWith('issue')) return 'issues';
  if (type.startsWith('pull')) return 'pullrequests';
  if (type.startsWith('discussion')) return 'discussions';
  if (type.startsWith('user')) return 'users';
  if (type.startsWith('commit')) return 'commits';
  if (type.startsWith('code')) return 'code';
  return type;
}

/**
 * 该页面类型应该用哪一套内容选择器。
 *
 * 搜索页与仓库正文的结构完全不同，混用会导致互相误命中，
 * 所以在这里做显式分流，而不是把所有选择器塞进一个清单。
 *
 * @returns {{ useSearchSelectors: boolean, allowFallback: boolean, label: string }}
 */
function getContentStrategy(pageType) {
  if (pageType === 'search') {
    return { useSearchSelectors: true, allowFallback: false, label: '搜索结果为容器' };
  }
  if (pageType === 'search_code') {
    // 代码搜索的结果是代码片段，翻译没有意义，也不该拿兜底去翻它
    return { useSearchSelectors: false, allowFallback: false, label: '代码搜索结果（不翻译）' };
  }
  return { useSearchSelectors: false, allowFallback: !NO_PROSE_PAGE_TYPES.has(pageType), label: '' };
}

/**
 * GitHub 的"应用型页面"路径。这些页面全是界面元素，没有正文。
 *
 * 列入这里的效果：禁用兜底 → 不再去翻卡片和按钮 →
 * 用户看到的是"这个页面本来就没有正文"这种准确的提示，
 * 而不是令人困惑的"没有找到需要翻译的正文"。
 */
const APP_PAGE_PATTERNS = [
  /^\/dashboard/,
  /^\/notifications/,
  /^\/settings/,
  /^\/codespaces/,
  /^\/marketplace/,
  /^\/sponsors/,
  /^\/explore/,
  /^\/topics/,
  /^\/trending/,
  /^\/collections/,
  /^\/orgs\/[^/]+\/(dashboard|people|settings|repositories|teams)/,
  /^\/search/,
  /^\/new/,
  /^\/login/,
  /^\/signup/,
  /^\/apps\//,
  /^\/features/,
  /^\/pricing/,
];

function isGitHubAppPage(path) {
  return APP_PAGE_PATTERNS.some((re) => re.test(path));
}

/**
 * 这类页面**本来就没有正文**，不应该启用兜底。
 *
 * 依据：在 vuejs/core/tree/main/packages（目录页）上实测，
 * 兜底会命中 276 个段落级元素 —— 那些是文件名和导航，翻它们是错的。
 * 宁可什么都不翻（用户看得出来"这页没内容可翻"），
 * 也不要把文件树和按钮翻成一堆中文。
 */
const NO_PROSE_PAGE_TYPES = new Set([
  'directory',
  'file_view',
  'commit',
  'releases_list',
  'discussions_list',
  'issues_list',
  'pulls_list',
  'actions',
  'pull_request_files',
  // Dashboard / 通知 / 设置这类应用页全是界面元素，没有正文
  'app_page',
  // 搜索页走 SEARCH_CONTENT_SELECTORS，不用 main/article 兜底
  // （否则会把筛选栏、排序菜单也当成正文）
  'search',
  'search_code',
]);

/**
 * 该页面类型是否允许启用兜底匹配。
 *
 * 这是 getContentStrategy 的便捷封装，保留给只关心"要不要兜底"的调用方与测试。
 * 真相源在 getContentStrategy —— 避免两处各写一份判断逻辑而逐渐不一致。
 */
function isFallbackAllowedForPage(pageType) {
  return getContentStrategy(pageType).allowFallback;
}

/** 页面类型的中文描述，写进提示词里 */
const PAGE_TYPE_LABEL = {
  pull_request: '一个 Pull Request（拉取请求）的页面',
  pull_request_files: '一个 Pull Request 的代码改动（diff）页面',
  issue: '一个 Issue（议题）的页面',
  discussion: '一个 Discussion（讨论）的页面',
  discussions_list: '仓库的 Discussion 列表页面',
  release: '一个 Release（发行版）说明页面',
  releases_list: '仓库的 Release（发行版）列表页面',
  file_view: '一个源码文件查看页面',
  directory: '一个代码目录浏览页面',
  commit: '一个 Commit（提交）详情页面',
  issues_list: '仓库的 Issue 列表页面',
  pulls_list: '仓库的 Pull Request 列表页面',
  actions: '仓库的 Actions 页面',
  search: 'GitHub 的搜索结果页面',
  search_code: 'GitHub 的代码搜索结果页面（内容为代码片段）',
  repository_home: '仓库首页（README 文档）',
  profile: '一个用户或组织的个人主页',
  app_page: 'GitHub 的应用页面（Dashboard／通知／设置等，没有正文）',
  other: 'GitHub 的一个页面',
};

/**
 * 生成用于提示词的上下文描述。
 * 越具体，译文越贴合语境。
 */
function buildPageContext(url = location.href) {
  const repo = parseRepoFromUrl(url);
  const type = detectPageType(url);
  const title = document.title || '';

  const lines = [];
  lines.push(`当前页面：${PAGE_TYPE_LABEL[type] || PAGE_TYPE_LABEL.other}`);
  if (repo) {
    lines.push(`所属仓库：${repo.fullName}`);
  }

  // 搜索结果页：把用户的查询词告诉模型，译文能更贴合搜索意图
  // （例如搜 "state management" 时，result 里的 "state" 应译作"状态"而非"州"）
  if (type === 'search' || type === 'search_code') {
    try {
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q');
      if (q) lines.push(`用户搜索的关键词：${q}`);
      const scope = parsed.searchParams.get('type');
      if (scope) lines.push(`搜索范围：${scope}`);
    } catch {
      /* URL 解析失败时忽略，不影响主流程 */
    }
  }

  if (title) {
    // GitHub 的 title 形如 "标题 · Pull Request #123 · owner/repo"
    lines.push(`页面标题：${title}`);
  }
  return { repo, type, title, description: lines.join('\n') };
}

/**
 * 用于缓存键的短标识。同一页面内上下文相同 → 缓存可命中。
 * 故意不含 title：title 会随滚动/通知变化，含进去会导致缓存失效。
 */
function buildContextKey(url = location.href) {
  const repo = parseRepoFromUrl(url);
  const type = detectPageType(url);
  return `${repo ? repo.fullName : 'norepo'}:${type}`;
}

/* ============================================================
 * 来自 src/core/parse.js
 * ============================================================ */
/**
 * 模型返回结果的解析。
 *
 * 【为什么单独抽一个文件】
 * 这是纯函数逻辑，不依赖 DOM、不依赖 chrome、不依赖网络。
 * 抽出来之后可以用 `node --test` 直接跑单元测试 —— 在"我无法在浏览器里点按钮"
 * 的前提下，这是唯一能自动化验证的部分。所以它值得单独存在。
 */

class TranslateError extends Error {
  constructor(message, { retriable = false, status = 0 } = {}) {
    super(message);
    this.name = 'TranslateError';
    this.retriable = retriable;
    this.status = status;
  }
}

/**
 * 从模型输出里解析出 { i, t } 列表。
 * 容错处理三种常见偏差：```json 围栏、前后多余文字、字段缺失。
 *
 * @param {string} content 模型返回的原始文本
 * @returns {Map<number, string>} 索引 -> 译文
 */
function parseModelOutput(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new TranslateError('模型返回内容为空', { retriable: true });
  }

  let text = content.trim();

  // 容错 1：模型有时仍会包一层 ```json 围栏
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();

  // 容错 2：前后有多余文字，截取最外层的 JSON。
  // 必须先判断最外层是对象还是数组 —— 否则会切错括号，
  // 把 `[{...}]` 当成 `{...}` 处理（这个 bug 已由单元测试捕获）。
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const useArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);
  const open = useArray ? '[' : '{';
  const close = useArray ? ']' : '}';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranslateError('模型返回的不是合法 JSON', { retriable: true });
  }

  // 容错 3：有的模型直接返回数组，而不是 { translations: [...] }
  const list = Array.isArray(parsed?.translations)
    ? parsed.translations
    : Array.isArray(parsed)
      ? parsed
      : null;

  if (!list) {
    throw new TranslateError('模型返回的 JSON 缺少 translations 字段', { retriable: true });
  }

  const byIndex = new Map();
  for (const entry of list) {
    if (entry && typeof entry.i === 'number' && typeof entry.t === 'string') {
      byIndex.set(entry.i, entry.t);
    }
  }
  return byIndex;
}

/**
 * 把解析结果按请求项对齐。
 * 缺失的项回退为原文 —— 宁可显示原文，也不要显示错位的译文。
 *
 * @param {Map<number,string>} byIndex
 * @param {Array<{i:number,text:string}>} items
 * @returns {Map<number,string>}
 */
function alignToItems(byIndex, items) {
  const result = new Map();
  for (const item of items) {
    const translated = byIndex.get(item.i);
    const usable = typeof translated === 'string' && translated.trim();
    result.set(item.i, usable ? translated : item.text);
  }
  return result;
}

/* ============================================================
 * 来自 src/core/translate.js
 * ============================================================ */
/**
 * 翻译引擎（网络层）。
 *
 * 运行环境：**只在 Service Worker 里运行**。
 * 原因见 src/background.js 顶部注释 —— 内容脚本直连 API 会被页面 CORS 拦截。
 */

class Translator {
  /**
   * @param {{ apiKey: string, baseUrl: string, model: string, glossary?: string }} settings
   * @param {{ description?: string }} pageContext
   */
  constructor(settings, pageContext) {
    this.apiKey = settings.apiKey;
    this.baseUrl = (settings.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    this.model = settings.model || 'deepseek-flash';
    this.glossary = settings.glossary || '';
    this.pageContext = pageContext || {};
    this.systemPrompt = buildSystemPrompt({
      pageContext: this.pageContext,
      glossary: this.glossary,
    });
  }

  /**
   * 翻译一批片段（带重试）。
   * @param {Array<{i: number, text: string}>} items
   * @returns {Promise<Map<number, string>>}
   */
  async translateBatch(items) {
    if (!Array.isArray(items) || items.length === 0) return new Map();
    if (!this.apiKey) {
      throw new TranslateError('未填写 DeepSeek API Key，请点击扩展图标填写。');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const content = await this.#request(items);
        return alignToItems(parseModelOutput(content), items);
      } catch (error) {
        lastError = error;
        const retriable = error instanceof TranslateError ? error.retriable : true;
        if (!retriable || attempt === MAX_RETRIES) break;
        await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s
      }
    }
    throw lastError || new TranslateError('翻译请求失败');
  }

  async #request(items) {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: buildUserPrompt(items) },
      ],
      temperature: 1.3, // DeepSeek 官方对翻译场景推荐的温度
      stream: false,
      response_format: { type: 'json_object' },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') {
        throw new TranslateError(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）`, { retriable: true });
      }
      throw new TranslateError(`网络错误：${error.message}`, { retriable: true });
    }
    clearTimeout(timer);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const status = response.status;
      const retriable = status === 429 || status >= 500;
      let hint = '';
      if (status === 401) hint = '（API Key 无效或已过期）';
      else if (status === 402) hint = '（余额不足，请到 DeepSeek 平台充值）';
      else if (status === 404) hint = `（模型名 "${this.model}" 不存在，请在弹窗里改为当前可用模型名）`;
      else if (status === 429) hint = '（请求过于频繁，将自动降速重试）';
      throw new TranslateError(
        `API 返回 ${status}${hint}${detail ? `：${detail.slice(0, 200)}` : ''}`,
        { retriable, status }
      );
    }

    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new TranslateError('API 响应结构异常，未找到 choices[0].message.content', {
        retriable: true,
      });
    }
    return content;
  }
}

/** 测试连通性（popup 里的「测试连接」） */
async function testConnection(settings) {
  const translator = new Translator(settings, { description: '' });
  const result = await translator.translateBatch([{ i: 0, text: 'Hello world' }]);
  return result.get(0);
}

/* ============================================================
 * 来自 src/core/dom.js
 * ============================================================ */
/**
 * DOM 提取与注入。
 *
 * 这是整个扩展最容易出错、也最关键的部分。设计原则：
 *
 *   1. **白名单优先**：只在命中 CONTENT_SELECTORS 的容器里找文本。
 *      不去猜"哪里是导航栏"，而是只认"哪里是正文"。猜错最多是不翻，
 *      不会把 GitHub 的按钮/侧栏/diff 翻坏。
 *
 *   2. **三级降级**：主选择器 → 宽松的类名模式 → 兜底启发式。
 *      GitHub 改版时扩展不会静默失效，而是降级继续工作，
 *      并在诊断信息里标记出来。
 *
 *   3. **绝不改变原有 DOM 结构**：译文作为一个独立 <span> 插入到原文后面，
 *      原文节点本身一个字符都不动。这样能随时复原，不留副作用。
 *
 *   4. **输入框在 SKIP_TAGS 里被硬挡**，选择器匹配不到它，
 *      TreeWalker 也进不去。你键入的英文永远不会被改写。
 */

const EXCLUDE_SELECTOR = EXCLUDE_SELECTORS.join(',');
const FALLBACK_CONTAINER_SELECTOR = FALLBACK_CONTAINER_SELECTORS.join(',');

/**
 * 搜索页的排除规则 = 通用规则 + 搜索页专用规则。
 *
 * 专用规则挡掉话题标签 / 时间 / 语言 / 星数 / 按钮这些界面噪音 ——
 * 真机实测不加它们会收集到 158 条"JavaScript / Updated yesterday / Star"之类的垃圾。
 */
const SEARCH_EXCLUDE_SELECTOR = [...EXCLUDE_SELECTORS, ...SEARCH_EXCLUDE_SELECTORS].join(',');

/** 兜底模式下，只考虑段落级标签，避免把零碎的行内文本也捞进来 */
const FALLBACK_TEXT_TAGS = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'DD', 'SUMMARY']);

/**
 * 这些标签的文本可以聚合成一个翻译单元。
 *
 * 【为什么必须聚合 · 真机暴露的问题】
 * GitHub 的 README 里，一句话常被行内元素切成好几个文本节点：
 *   "Please follow the documentation at" + <a>vuejs.org</a> + "!"
 * 如果按单个文本节点独立翻译，就会产生大量碎片
 * （"Getting Started"、"Please follow the documentation at"、"Sponsors"…），
 * 译文既少又不自然。聚合后 LLM 能看到完整句子，译文质量与覆盖率同时提升。
 *
 * 只对"叶子块"聚合 —— 即不含嵌套块级子元素的段落/标题/列表项/表格单元格，
 * 这样不会把多个段落揉成一坨。
 */
const AGGREGATABLE_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'SUMMARY', 'FIGCAPTION',
]);

/** 行内标签：出现在块里不算"嵌套块" */
const INLINE_TAGS = new Set([
  'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SMALL', 'SUB', 'SUP',
  'FONT', 'MARK', 'ABBR', 'CITE', 'Q', 'TIME', 'LABEL', 'BDI', 'BDO', 'WBR',
  'CODE', 'KBD', 'SAMP', 'VAR', 'IMG', 'PICTURE', 'BR',
]);

/**
 * 单个聚合单元的文本长度上限。超过就不再聚合，避免一次请求过大。
 */
const MAX_SEGMENT_LENGTH = 1200;

/**
 * "短 div"也允许聚合。
 *
 * 【为什么需要这个 · 真机实测的教训】
 * GitHub 把搜索结果描述放在 <div class="Content-module__Content__EMhAj"> 里，
 * 描述被高亮 <em> 切成多个片段。而 AGGREGATABLE_TAGS 只含语义化块
 * （p / h1-h6 / li / td …），不含 div —— 所以聚合一次都没触发，
 * 描述永远是"Cheatsheets for experienced" / "developers getting started..." 两段。
 *
 * 判据用"元素自身文本长度"而不是标签名：
 *   - 语义化标签（p/li/h1…）→ 直接可聚合
 *   - div/span 等 → 仅当自身文本不超过 MAX_CONTAINER_DIV_LENGTH 时才聚合
 * 这样既能聚合"包裹一段描述的短 div"，又不会把整个布局容器当成一句话。
 */
const MAX_CONTAINER_DIV_LENGTH = 1500;

/** 这些标签即使不在 AGGREGATABLE_TAGS 里，也可能承载一段完整文本 */
const CONTAINER_LIKE_TAGS = new Set(['DIV', 'SPAN', 'SECTION', 'ARTICLE', 'TD', 'TH']);

/** 向上查找可聚合祖先时的最大层数，防止长链上反复计算 */
const MAX_ANCESTOR_WALK = 6;

/**
 * 判断一个元素是否是"块级"（用于决定聚合边界）。
 * 用标签名做便宜判断，避免对每个元素都调用 getComputedStyle。
 */
function isBlockLevelElement(el) {
  return !INLINE_TAGS.has(el.tagName) && el.tagName !== 'BODY' && el.tagName !== 'HTML';
}

/**
 * 该元素是否已有一个"可聚合的块级祖先"。
 *
 * 【为什么这是必需的 · 真机实测的关键教训】
 * 结果项里描述的 DOM 是：
 *   <div class="Content-module__Content__EMhAj">          ← 想让它聚合整段
 *     <span class="search-match">The library for web and native</span>
 *     <em>react</em>
 *     <span class="search-match">user interfaces.</span>
 *   </div>
 *
 * 内层 span 的深度比父 div 大，如果按"最内层优先"处理，两个 span 会各自成句，
 * 父 div 就永远没机会 —— 描述被永久切成两段（这就是实测到的现象）。
 *
 * 所以改成自顶向下：只要祖先里有可聚合的块，就把这一整段交给祖先处理，
 * 自己退出。这样聚合边界始终落在**最外层的那个"短块"**上，
 * 内层的行内碎片自然被完整覆盖。
 */
function hasAggregatableBlockAncestor(el) {
  let cur = el.parentElement;
  let hops = 0;
  while (cur && hops < MAX_ANCESTOR_WALK) {
    if (isBlockLevelElement(cur) && isAggregatableBlock(cur, hops + 1)) return true;
    cur = cur.parentElement;
    hops++;
  }
  return false;
}

/**
 * 判断一个块元素是否值得聚合成一个翻译单元。
 * 条件：标签在可聚合清单里、不含嵌套块级子元素、可见。
 */
function isAggregatableBlock(el, depth = 0) {
  const isSemanticBlock = AGGREGATABLE_TAGS.has(el.tagName);
  const isContainerLike = CONTAINER_LIKE_TAGS.has(el.tagName);

  if (!isSemanticBlock && !isContainerLike) return false;

  // 容器类标签（div/span 等）要额外限制：自身文本不能太长，
  // 否则会把整个布局容器当成"一句话"聚合，产生巨大且无意义的请求。
  if (!isSemanticBlock) {
    const ownText = (el.textContent || '').trim();
    if (ownText.length === 0 || ownText.length > MAX_CONTAINER_DIV_LENGTH) return false;
  }

  // 不含嵌套块级子元素（否则应该由更内层的块各自处理）
  for (const child of el.children) {
    if (!INLINE_TAGS.has(child.tagName) && !isInlineDisplayed(child)) return false;
  }

  // 自顶向下：已有可聚合祖先时让位，避免内层行内元素抢先成句
  // （depth 用于限制递归深度，防止相互调用的无限循环）
  if (depth < MAX_ANCESTOR_WALK && hasAggregatableBlockAncestor(el)) return false;

  return isVisible(el);
}

/** 有些元素虽标签不在行内清单里，但实际是 inline 显示（如自定义组件） */
function isInlineDisplayed(el) {
  try {
    return window.getComputedStyle(el).display.startsWith('inline');
  } catch {
    return false;
  }
}

/**
 * 在一个块元素内收集连续的、可翻译的行内文本节点，聚合成一个单元。
 *
 * 返回 { nodes, text }，nodes 是参与聚合的文本节点（按文档顺序）。
 * 注意：这里不做标识符过滤 —— 短片段可能在拼接后才有意义，
 * 过滤统一交给上层的 isTranslatable 处理。
 */
function collectSegment(el, excludeSelector = EXCLUDE_SELECTOR) {
  const nodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;

      // 父链上出现跳过标签（CODE/PRE/INPUT…）→ 这个片段不参与
      let cur = parent;
      while (cur && cur !== el) {
        if (SKIP_TAGS.has(cur.tagName)) return NodeFilter.FILTER_REJECT;
        cur = cur.parentElement;
      }
      if (parent.closest(excludeSelector)) return NodeFilter.FILTER_REJECT;
      if (processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let n;
  while ((n = walker.nextNode())) {
    nodes.push(n);
    // 长度上限：防止把超长段落拼成一个巨大请求
    const joined = nodes.map((x) => x.nodeValue).join(' ');
    if (joined.length > MAX_SEGMENT_LENGTH) {
      nodes.pop();
      break;
    }
  }

  return { nodes, text: normalizeText(nodes.map((x) => x.nodeValue).join(' ')) };
}

/* ------------------------------------------------------------------ */

/** 记录每个原文文本节点对应的译文 span */
const nodeState = new WeakMap();

/** 记录原文被包进 wrapper 的情况，复原时用 */
const wrappedNodes = new WeakMap();

/**
 * 已经处理过的文本节点。
 *
 * 【这个集合是省钱的关键】
 * 没有它的话：MutationObserver 每次触发都会重新收集同一批节点，
 * 结果是同一段文字被反复送去翻译、反复付费。
 */
let processedNodes = new WeakSet();

/** 最近一次收集的诊断报告，供 popup 展示 */
let lastReport = null;

/** 判断一个文本节点是否可以翻译 */
function isTranslatable(node) {
  const text = node.nodeValue;
  if (!text) return false;

  if (processedNodes.has(node)) return false;

  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return false;
  if (trimmed.length > MAX_TEXT_LENGTH) return false;
  if (!hasTranslatableContent(trimmed)) return false;
  if (looksLikeChinese(trimmed)) return false;
  if (looksLikeIdentifier(trimmed)) return false;

  if (node.parentElement?.closest(`.${NS}-translation`)) return false;

  const editable = node.parentElement?.closest('[contenteditable="true"], [contenteditable=""]');
  if (editable) return false;

  return true;
}

/**
 * 找出应该被当作"正文容器"的元素。
 *
 * @param {{ root?: Document|Element, fallbackAllowed?: boolean }} [options]
 *   fallbackAllowed=false 时禁用兜底。
 *   目录页、代码页这类**本来就没有正文**的页面必须传 false ——
 *   否则兜底会去翻文件树和按钮（在 vuejs/core/tree/main/packages 上实测会命中 276 个段落级元素）。
 *
 * 返回 { elements, matchedSelectors, usedFallback, fallbackBlocked }。
 */
function findContentContainers(options = {}) {
  const root = options.root || document;
  const fallbackAllowed = options.fallbackAllowed !== false;
  // 搜索页结构与仓库正文完全不同 → 用专用选择器，避免互相误命中
  const useSearch = Boolean(options.useSearchSelectors);
  const selectors = useSearch ? SEARCH_CONTENT_SELECTORS : CONTENT_SELECTORS;
  const excludeSelector = useSearch ? SEARCH_EXCLUDE_SELECTOR : EXCLUDE_SELECTOR;

  const elements = new Set();
  const matchedSelectors = [];
  let usedFallback = false;
  let fallbackBlocked = false;

  for (const selector of selectors) {
    let found;
    try {
      found = root.querySelectorAll(selector);
    } catch {
      continue; // 选择器语法不被支持时跳过，不影响其他选择器
    }
    if (found.length === 0) continue;
    matchedSelectors.push({ selector, count: found.length });
    for (const el of found) {
      if (el.closest(excludeSelector)) continue;

      // 跳过已被更靠前选择器覆盖的嵌套元素。
      //
      // 【为什么必须做】真机实测搜索页：`[data-testid="results-list"]` 命中 1 个外层容器，
      // 而 `.search-title` × 10、`.search-match` × 20 都在它内部。
      // 不跳过嵌套会导致同一段文字被多个容器重复遍历、重复计费。
      // 选择器清单是按"由外到内"排列的，所以先入为主的容器优先。
      let nested = false;
      for (const existing of elements) {
        if (existing !== el && existing.contains(el)) {
          nested = true;
          break;
        }
      }
      if (nested) continue;

      elements.add(el);
    }
  }

  // 主选择器一个都没命中 → 视情况启用兜底，避免扩展静默失效
  if (elements.size === 0) {
    if (!fallbackAllowed) {
      fallbackBlocked = true;
    } else {
      usedFallback = true;
      for (const containerSelector of FALLBACK_CONTAINER_SELECTORS) {
        let containers;
        try {
          containers = root.querySelectorAll(containerSelector);
        } catch {
          continue;
        }
        for (const container of containers) {
          if (container.closest(excludeSelector)) continue;
          matchedSelectors.push({ selector: `${containerSelector} (兜底)`, count: containers.length });
          elements.add(container);
        }
      }
    }
  }

  return {
    elements: [...elements],
    matchedSelectors,
    usedFallback,
    fallbackBlocked,
    usedSearchSelectors: useSearch,
    excludeSelector,
  };
}

/**
 * 在整页里找出所有可翻译的翻译单元。
 *
 * 每个单元是 **一组文本节点**（通常只有 1 个），它们会被合并成一句话
 * 送去翻译，译文统一插到最后一个节点之后。
 *
 * 【为什么要按组返回而不是按单节点】
 * GitHub 的行内元素会把一句话切成多个文本节点，逐节点翻译会产生碎片。
 * 聚合后 LLM 看到完整句子，译文覆盖率与质量同时提升。
 *
 * @param {{ report?: object, elements?: HTMLElement[], usedFallback?: boolean }} [options]
 *        传入 findContentContainers 的结果可避免重复查找
 * @returns {Array<{ nodes: Text[], text: string }>}
 */
function collectTextNodes(options = {}) {
  const report = options.report || findContentContainers();
  const containers = options.elements || report.elements;
  const usedFallback = options.usedFallback ?? report.usedFallback;
  // 搜索页需要额外的排除规则（话题标签/时间/按钮），由 report 带入
  const excludeSelector =
    options.excludeSelector || report.excludeSelector || EXCLUDE_SELECTOR;

  const results = [];
  const seen = new Set();
  /** 已经被聚合进某个单元的节点，避免后面又被单独收集一次 */
  const aggregated = new Set();

  /** 单元文本是否值得翻译（在聚合后再判断，短碎片合并后可能就有意义了） */
  const isWorthTranslating = (text) => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) return false;
    if (trimmed.length > MAX_TEXT_LENGTH) return false;
    if (!hasTranslatableContent(trimmed)) return false;
    if (looksLikeChinese(trimmed)) return false;
    if (looksLikeIdentifier(trimmed)) return false;
    return true;
  };

  for (const container of containers) {
    if (!isVisible(container)) continue;

    // ---- 第一遍：聚合"叶子块"里的行内碎片 ----
    // 从最内层块开始收集，这样嵌套结构下先处理更小的单元。
    //
    // 查询范围要包含容器类标签（div/span…）—— 真机实测搜索结果描述就包在
    // <div class="Content-module__Content__EMhAj"> 里，只查语义化标签会漏掉它。
    // 真正的过滤交给 isAggregatableBlock（含"自身文本不过长"的限制）。
    const blocks = Array.from(
      container.querySelectorAll([...AGGREGATABLE_TAGS, ...CONTAINER_LIKE_TAGS].join(','))
    );

    // 注意：这里**不按深度排序**。
    // 排序解决不了"内层抢先成句"的问题（内层 span 深度必然大于父 div），
    // 真正的解法是 isAggregatableBlock 里的 hasAggregatableBlockAncestor ——
    // 有可聚合祖先的块主动让位，聚合边界自然落在最外层短块上。

    for (const block of blocks) {
      // 兜底模式下块本身也要符合段落级要求（与单节点路径保持一致）
      if (usedFallback && !FALLBACK_TEXT_TAGS.has(block.tagName)) continue;
      if (block.closest(excludeSelector)) continue;
      if (!isAggregatableBlock(block)) continue;

      const { nodes, text } = collectSegment(block, excludeSelector);
      if (nodes.length === 0) continue;
      // 该块里所有节点都应可用（没被别处用过）
      if (nodes.some((n) => seen.has(n) || aggregated.has(n))) continue;
      if (!isWorthTranslating(text)) continue;

      for (const n of nodes) {
        aggregated.add(n);
        seen.add(n);
      }
      results.push({ nodes, text: normalizeText(text) });
    }

    // ---- 第二遍：收集剩下未被聚合的单节点（如超长段落、无块的散文本）----
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // 父链上任一标签命中跳过清单 → 整棵子树跳过
        // 这一条就是"输入框和代码块永不被翻译"的根本保证
        let current = parent;
        while (current) {
          if (SKIP_TAGS.has(current.tagName)) return NodeFilter.FILTER_REJECT;
          current = current.parentElement;
        }

        if (parent.closest(excludeSelector)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;

        // 兜底模式：只取段落级标签里的文本，避免捞进一堆界面碎片
        if (usedFallback && !FALLBACK_TEXT_TAGS.has(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      if (seen.has(node) || aggregated.has(node)) continue;
      if (!isTranslatable(node)) continue;
      seen.add(node);
      results.push({ nodes: [node], text: normalizeText(node.nodeValue) });
    }
  }

  lastReport = {
    matchedSelectors: report.matchedSelectors,
    usedFallback,
    fallbackBlocked: report.fallbackBlocked || false,
    containerCount: containers.length,
    textNodeCount: results.length,
    aggregatedUnits: results.filter((r) => r.nodes.length > 1).length,
    sample: results.slice(0, 5).map((r) => r.text.slice(0, 80)),
  };

  return results;
}

/** 取最近一次收集的诊断报告 */
function getLastReport() {
  return lastReport;
}

/**
 * 把译文注入到原文之后。
 *
 * 【关于"包一层 wrapper"的取舍 · 2026-09-22 修复】
 * 原实现只插入译文 span，不改原文结构。好处是零侵入，但代价是
 * **「纯中文」模式无法隐藏原文** —— 因为没有任何元素可以承载"隐藏"这个语义
 * （CSS 里那条 `.ghst-original-hidden { display:none }` 从来没有目标元素，
 * 所以切到纯中文毫无效果，这是真机发现的功能缺失）。
 *
 * 现在把原文包进一个 <span data-ghst-role="original">：
 *   - 只新增元素，**不修改任何文本内容**，所以 `textContent` 不变、可无损复原
 *   - 双语模式：原文与译文各自成块显示
 *   - 纯中文模式：CSS 隐藏整个原文块
 *
 * @param {Text|Text[]} nodeOrNodes 原文节点（聚合单元会传入多个）
 * @param {string} translation 译文
 */
function injectTranslation(nodeOrNodes, translation) {
  const nodes = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
  const valid = nodes.filter((n) => n && n.parentElement);
  if (valid.length === 0) return null;

  const first = valid[0];
  const last = valid[valid.length - 1];
  const parent = last.parentElement;

  // 已注入过 → 只更新译文文本
  const existing = nodeState.get(first);
  if (existing?.span?.isConnected) {
    existing.span.textContent = translation;
    existing.translation = translation;
    return existing.span;
  }

  // ---- 1) 把原文节点包进一个 span ----
  let wrapper = first.parentElement?.closest?.(`[data-${NS}-role="original"]`);
  if (!wrapper) {
    wrapper = document.createElement('span');
    wrapper.className = `${NS}-original`;
    wrapper.setAttribute(`data-${NS}-role`, 'original');
    parent.insertBefore(wrapper, first);
    for (const n of valid) {
      wrappedNodes.set(n, wrapper);
      wrapper.appendChild(n); // appendChild 会从原位置移走该节点
    }
  }

  // ---- 2) 译文插到 wrapper 之后 ----
  const span = document.createElement('span');
  span.className = `${NS}-translation`;
  span.setAttribute(`data-${NS}-role`, 'translation');
  span.textContent = translation;

  if (wrapper.nextSibling) {
    wrapper.parentElement.insertBefore(span, wrapper.nextSibling);
  } else {
    wrapper.parentElement.appendChild(span);
  }

  for (const n of valid) processedNodes.add(n);
  nodeState.set(first, { span, translation, wrapper, nodes: valid });
  return span;
}

/** 应用显示模式 */
function applyMode(mode) {
  document.documentElement.setAttribute(`data-${NS}-mode`, mode);
}

/**
 * 全部复原：移除所有注入的译文与原包装，页面回到原始状态。
 * 顺序很重要 —— 必须先解包（把原文节点放回父元素），再删译文，
 * 否则会出现"原文还藏在即将被删的 wrapper 里"的中间态。
 */
function removeAllTranslations() {
  // 1) 解包：把原文节点移回 wrapper 的父元素，再删 wrapper
  for (const wrapper of document.querySelectorAll(`[data-${NS}-role="original"]`)) {
    const parent = wrapper.parentElement;
    if (parent) {
      while (wrapper.firstChild) {
        parent.insertBefore(wrapper.firstChild, wrapper);
      }
    }
    wrapper.remove();
  }

  // 2) 删除所有译文
  for (const span of document.querySelectorAll(`[data-${NS}-role="translation"]`)) {
    span.remove();
  }

  // 3) 兼容清理：早期版本没有 data-role 属性，用类名兜底
  for (const el of document.querySelectorAll(`.${NS}-translation, .${NS}-original`)) {
    el.remove();
  }

  // WeakMap/WeakSet 不能清空，只能整体替换 —— 复原后这些节点应允许被重新翻译
  processedNodes = new WeakSet();
  document.documentElement.removeAttribute(`data-${NS}-mode`);
}

/** 当前已注入的译文数量 */
function countInjected() {
  return document.querySelectorAll(`[data-${NS}-role="translation"]`).length;
}

/* ============================================================
 * 来自 src/core/styles.js
 * ============================================================ */
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
const STYLE_ID = 'ghst-style';

const CSS = `
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
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
}

/* ============================================================
 * 来自 src/content/main.js
 * ============================================================ */
/**
 * 内容脚本入口：把各个模块串起来。
 *
 * 流程：
 *   读取设置 → 判断模式 → 收集文本节点 → 查缓存 → 批量翻译 → 注入译文 → 监听动态内容
 */

const TARGET_LANG = 'zh-CN';

const state = {
  settings: null,
  contextKey: '',
  pageContext: null,
  running: false,
  pending: false,
  observer: null,
  debounceTimer: null,
  booted: false,
  bootError: null,
  stats: { total: 0, fromCache: 0, translated: 0, failed: 0 },
};

/**
 * 通过 Service Worker 发翻译请求。
 *
 * 【关键】不能在这里直接 fetch —— 内容脚本的 fetch 受 github.com 的 CORS 策略约束，
 * 会被浏览器拦截。必须交给有 host_permissions 的后台去做。
 *
 * @param {Array<{i:number,text:string}>} items
 * @returns {Promise<Map<number,string>>}
 */
function requestTranslation(items) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'GHST_TRANSLATE',
        items,
        pageContext: state.pageContext,
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(`无法连接后台服务：${lastError.message}`));
          return;
        }
        if (!response) {
          reject(new Error('后台服务无响应'));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || '翻译失败'));
          return;
        }
        resolve(new Map(response.translations));
      }
    );
  });
}

/** 初始化页面上下文（不涉及网络，无需后台） */
function initContext() {
  state.pageContext = buildPageContext();
  state.contextKey = buildContextKey();
}

/**
 * 翻译整个页面（增量：已在缓存里的直接注入，未命中的发请求）。
 */
async function translatePage({ silent = false } = {}) {
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  state.stats = { total: 0, fromCache: 0, translated: 0, failed: 0 };

  try {
    // 消息可能在 boot() 完成之前就到达（模块化内容脚本是异步加载的），
    // 所以这里补齐 settings 与页面上下文，避免出现 undefined.model 之类的崩溃。
    if (!state.settings) {
      state.settings = await getSettings();
    }
    if (!state.pageContext) {
      initContext();
    }
    if (!document.getElementById(STYLE_ID)) {
      injectStyles();
    }

    // 先找容器，拿到诊断信息（选择器命中情况）。
    // 这一步纯本地计算，不花任何 token。
    // 策略分流：搜索页用专用选择器；目录页/代码页没有正文 → 禁用兜底。
    const strategy = getContentStrategy(state.pageContext?.type);
    const report = findContentContainers({
      fallbackAllowed: strategy.allowFallback,
      useSearchSelectors: strategy.useSearchSelectors,
    });
    const nodes = collectTextNodes({ report });
    if (nodes.length === 0) {
      const diag = getLastReport();
      const pageType = state.pageContext?.type || '未知';
      let why;
      if (diag?.fallbackBlocked) {
        why =
          `当前页面类型是「${pageType}」，这是 GitHub 的应用/列表页面，` +
          `没有正文内容。请打开一个仓库页面（例如 github.com/vuejs/core）或某个 Issue / PR 再试。` +
          `\n（界面上的按钮和菜单标签需要靠 github-chinese 词库那套方案，本扩展只翻正文。）`;
      } else {
        why =
          `匹配到 ${diag?.containerCount ?? 0} 个正文容器，但里面没有需要翻译的英文文本` +
          `（可能是内容已经是中文、或全是代码与标识符）。`;
      }
      notify(why, 'warning');
      return;
    }

    state.stats.total = nodes.length;

    // 1. 计算缓存键并查缓存
    const items = [];
    const cacheHits = [];

    for (const entry of nodes) {
      const key = cacheKey({
        text: entry.text,
        contextKey: state.contextKey,
        targetLang: TARGET_LANG,
        promptVersion: PROMPT_VERSION,
        model: state.settings.model,
      });
      const cached = await getCached(key);
      if (typeof cached === 'string') {
        injectTranslation(entry.nodes, cached);
        state.stats.fromCache++;
      } else {
        items.push({ nodes: entry.nodes, text: entry.text, key });
      }
    }

    notify(
      `缓存命中 ${state.stats.fromCache} 条，需翻译 ${items.length} 条`,
      'info'
    );

    if (items.length === 0) {
      applyMode(state.settings.mode);
      notify('全部命中缓存，未产生 API 费用', 'success');
      return;
    }

    // 2. 分批 + 限并发
    const batches = chunk(items, BATCH_SIZE);
    let batchIndex = 0;

    await mapWithConcurrency(batches, MAX_CONCURRENCY, async (batch) => {
      const requestItems = batch.map((item, idx) => ({ i: idx, text: item.text }));
      try {
        const result = await requestTranslation(requestItems);
        const toCache = [];
        batch.forEach((item, idx) => {
          const translation = result.get(idx);
          if (typeof translation === 'string' && translation.trim()) {
            injectTranslation(item.nodes, translation);
            toCache.push([item.key, translation]);
            state.stats.translated++;
          } else {
            state.stats.failed++;
          }
        });
        await setCachedMany(toCache);
        notify(
          `进度 ${Math.round((++batchIndex / batches.length) * 100)}%（本页已翻译 ${state.stats.translated} 条）`,
          'info'
        );
      } catch (error) {
        state.stats.failed += batch.length;
        notify(`翻译失败：${error.message}`, 'error');
      }
    });

    applyMode(state.settings.mode);
    notify(
      `完成：新翻译 ${state.stats.translated} 条，缓存命中 ${state.stats.fromCache} 条` +
        (state.stats.failed > 0 ? `，失败 ${state.stats.failed} 条` : ''),
      state.stats.failed > 0 ? 'warning' : 'success'
    );
  } finally {
    state.running = false;
    if (state.pending) {
      state.pending = false;
      // 有新内容在等待处理，稍后再跑一轮
      setTimeout(() => translatePage({ silent: true }), 800);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 页面提示条（不用 chrome 通知，避免权限与打扰）                       */
/* ------------------------------------------------------------------ */

let toastTimer = null;

function notify(message, level = 'info') {
  let el = document.getElementById('ghst-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ghst-toast';
    el.className = 'ghst-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.setAttribute('data-level', level);
  el.setAttribute('data-visible', '1');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.removeAttribute('data-visible');
  }, level === 'error' ? 8000 : 3500);
}

/* ------------------------------------------------------------------ */
/* 动态内容监听：GitHub 是 React SPA，切 Tab / 展开折叠都会新增内容      */
/* ------------------------------------------------------------------ */

function startObserver() {
  if (state.observer) return;
  state.observer = new MutationObserver((mutations) => {
    // 只关心"新增节点"和"文本变化"，忽略我们自己的注入
    let relevant = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) continue;
          if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('ghst-translation')) continue;
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (!relevant) return;

    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      if (state.settings?.mode && state.settings.mode !== MODES.OFF) {
        translatePage({ silent: true });
      }
    }, 1200);
  });

  state.observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (state.observer) {
    state.observer.disconnect();
    state.observer = null;
  }
  clearTimeout(state.debounceTimer);
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

/**
 * 【关键修复 · 2026-09-22】
 *
 * 消息监听器必须**在最顶层同步注册**，不能放在 async boot() 里面。
 *
 * 原因：manifest 里给内容脚本声明了 "type": "module"，而模块化内容脚本是
 * **异步加载**的。如果监听器注册在 `await getSettings()` 之后，那么
 * 用户点「翻译此页」时监听器可能还没挂上 —— popup 会收到
 * "Could not establish connection"，显示成"当前页面没有运行扩展"。
 * 这正是真机实测暴露出来的 bug：单元测试与静态注入都覆盖不到它。
 *
 * 所以：先同步注册监听器（消息到达时再去读 settings），最后才启动其余逻辑。
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  try {
    if (message.type === 'GHST_TRANSLATE_NOW') {
      translatePage()
        .then(() => sendResponse({ ok: true, stats: state.stats }))
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || String(error) })
        );
      return true; // 异步响应
    }

    if (message.type === 'GHST_RESET') {
      stopObserver();
      removeAllTranslations();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GHST_CLEAR_CACHE') {
      // IndexedDB 属于页面源，所以清缓存也必须由内容脚本执行
      clearCache()
        .then(() => sendResponse({ ok: true, remaining: countInjected() }))
        .catch((error) => sendResponse({ ok: false, error: error?.message }));
      return true;
    }

    if (message.type === 'GHST_STATUS') {
      sendResponse({
        ok: true,
        injected: countInjected(),
        running: state.running,
        pageContext: state.pageContext,
        report: getLastReport(),
        booted: state.booted,
        bootError: state.bootError,
      });
      return true;
    }

    if (message.type === 'GHST_DIAGNOSE') {
      // 现场跑一次检测，把"选择器命中情况 + 会翻译哪些文本"完整回报给 popup。
      // 这一步不发任何网络请求，所以可以放心点。
      const pageType = state.pageContext?.type || detectPageType();
      const strategy = getContentStrategy(pageType);
      const report = findContentContainers({
        fallbackAllowed: strategy.allowFallback,
        useSearchSelectors: strategy.useSearchSelectors,
      });
      const nodes = collectTextNodes({ report });
      sendResponse({
        ok: true,
        url: location.href,
        pageContext: state.pageContext || { type: pageType },
        report: getLastReport(),
        scannedNodes: nodes.length,
      });
      return true;
    }
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || String(error) });
    return true;
  }

  return false;
});

async function boot() {
  state.settings = await getSettings();
  injectStyles();
  initContext();
  state.booted = true;

  if (state.settings.mode !== MODES.OFF) {
    if (state.settings.autoTranslate) {
      // 等待 GitHub 的首屏渲染完成
      setTimeout(() => translatePage({ silent: true }), 1500);
    }
    startObserver();
  }

  // 监听设置变化（popup 里改了模式/key 立即响应）
  onSettingsChanged((patch) => {
    Object.assign(state.settings, patch);
    initContext();

    if (patch.mode === MODES.OFF) {
      stopObserver();
      removeAllTranslations();
      notify('已关闭翻译，页面已复原', 'info');
      return;
    }

    if (patch.mode) {
      applyMode(patch.mode);
    }

    if (patch.apiKey || patch.model || patch.baseUrl || patch.glossary) {
      // 关键配置变了，之前失败的译文值得重试
      notify('配置已更新，重新翻译中…', 'info');
      startObserver();
      translatePage({ silent: true });
    } else if (patch.mode) {
      startObserver();
      translatePage({ silent: true });
    }
  });

  // GitHub 是 SPA，URL 变化时上下文也变了（比如从仓库首页点进某个 Issue）。
  //
  // 【为什么不用 setInterval 轮询】
  // 轮询有两个坏处：① 永远有一个定时器挂着，会阻止测试进程退出；
  // ② 最长要等一个轮询周期才反应。改用事件驱动 + observer，两种情况都更好。
  setupUrlChangeListener();
}

/**
 * 监听 SPA 导航。三种情况都要覆盖：
 *   1. 浏览器前进/后退 → popstate
 *   2. pushState/replaceState（GitHub 主要用这个）→ 需要包装原方法
 *   3. 兜底 → 观察 document.title 变化（SPA 导航几乎必然改标题）
 */
function setupUrlChangeListener() {
  let lastUrl = location.href;

  const onUrlMaybeChanged = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    initContext();
    if (state.settings?.mode !== MODES.OFF) {
      startObserver();
      if (state.settings?.autoTranslate) {
        setTimeout(() => translatePage({ silent: true }), 1200);
      }
    }
  };

  window.addEventListener('popstate', onUrlMaybeChanged);

  // 包装 history 方法，捕获 pushState / replaceState
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function patched(...args) {
      const result = original.apply(this, args);
      // 让 GitHub 自己的处理先跑完再检查
      setTimeout(onUrlMaybeChanged, 0);
      return result;
    };
  }

  // 兜底：标题变化通常等价于导航完成
  const titleNode = document.querySelector('title');
  if (titleNode) {
    const titleObserver = new MutationObserver(onUrlMaybeChanged);
    titleObserver.observe(titleNode, { childList: true, subtree: true, characterData: true });
  }
}

/**
 * 启动。任何异常都写进 state 并以页面提示条暴露出来 ——
 * 静默失败是最难排查的，所以在最外层兜住并显式报告。
 */
boot().catch((error) => {
  state.bootError = error?.message || String(error);
  console.error('[GitHub 智能翻译] 启动失败：', error);
  try {
    injectStyles();
    notify(`扩展启动失败：${state.bootError}`, 'error');
  } catch {
    // 连提示条都插不进去就只能靠 console 了
  }
});
})();
