/**
 * 容器层级探针：打印 README 容器的祖先链，以及每个候选排除选择器
 * 实际能匹配到多少元素、其中是否包含正文。
 *
 * 用来判断某个排除规则是不是"误杀正文"的元凶。
 */
(() => {
  const CANDIDATES = [
    'header', 'footer', 'nav',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-labelledby="folders-and-files"]',
    '.AppHeader', '[class*="AppHeader"]', '[class*="GlobalNav"]',
    '[class*="RepositoryHeader"]', '[class*="repository-container-header"]',
    '[class*="OverviewContent"]',
    '.file-navigation', '.breadcrumb', '.sidebar',
    '[class*="Sidebar"]', '[class*="Footer"]',
    '.diff-table', 'table.diff-table',
  ];

  const readme = document.querySelector('.markdown-body');
  if (!readme) return JSON.stringify({ error: '页面上没有 .markdown-body' });

  // README 的祖先链
  const ancestors = [];
  let cur = readme.parentElement;
  let depth = 0;
  while (cur && depth < 12) {
    ancestors.push({
      depth,
      tag: cur.tagName,
      cls: String(cur.className || '').slice(0, 90),
      id: cur.id || '',
      role: cur.getAttribute('role') || '',
    });
    cur = cur.parentElement;
    depth++;
  }

  // 每个候选排除选择器：命中总数 + 是否包含了 README
  const rules = CANDIDATES.map((sel) => {
    let matched = [];
    try { matched = Array.from(document.querySelectorAll(sel)); } catch { /* 忽略非法选择器 */ }
    const hitsReadme = matched.some((el) => el.contains(readme));
    return { sel, total: matched.length, hitsReadme };
  }).filter((r) => r.total > 0);

  // README 内实际有多少可翻译文本（不受排除规则影响，仅统计）
  const textLen = (readme.textContent || '').replace(/\s+/g, ' ').trim().length;

  return JSON.stringify({
    url: location.href,
    readmeClass: String(readme.className),
    readmeTextLength: textLen,
    ancestors,
    dangerousRules: rules.filter((r) => r.hitsReadme).map((r) => r.sel),
    allRules: rules,
  });
})()
