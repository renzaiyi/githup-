/**
 * GitHub 页面上下文识别。
 *
 * 为什么需要它：LLM 的译文质量高度依赖"它知不知道自己在翻什么"。
 * 告诉它"这是 git 仓库 vuejs/core 的一个 Issue"，
 * 它就不会把 "issue" 翻成"发行"、也不会把命令翻成中文。
 */

/** 从 URL 中解析仓库所有者与名称 */
export function parseRepoFromUrl(url = location.href) {
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
export function detectPageType(url = location.href) {
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
export function getContentStrategy(pageType) {
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
export function isFallbackAllowedForPage(pageType) {
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
export function buildPageContext(url = location.href) {
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
export function buildContextKey(url = location.href) {
  const repo = parseRepoFromUrl(url);
  const type = detectPageType(url);
  return `${repo ? repo.fullName : 'norepo'}:${type}`;
}
