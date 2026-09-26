# 选择器验证记录

这份文件记录 `CONTENT_SELECTORS` 与排除规则的**证据等级**。
目的是把"我猜的"和"我验证过的"分开 —— 这样 GitHub 改版时你知道该先怀疑哪一条。

## 验证方法（两个阶段）

**阶段一（静态）**：用 `Invoke-WebRequest` 抓取真实 GitHub 页面的 HTML，统计关键标记出现次数。

**阶段二（真实浏览器，决定性）**：用浏览器自动化在**真实 GitHub 页面上执行扩展的真实源码逻辑**
（`scripts/run-probe.js` 直接 `import` 真实的 `constants.js`，不是副本），
报告"会翻译多少条文本、命中哪些选择器、输入框是否安全"。

> 用副本验证等于没验证 —— 所以探针脚本是从真实源码动态生成的。

---

## 一、真实浏览器验证结果（2026-09-22）

### 主路径：正常工作

| 页面 | URL | 页面类型 | 容器 | 可翻译文本 | 输入框在容器内 |
|---|---|---|---|---|---|
| 仓库首页 | `vuejs/core` | repository_home | 2 | **68 条** | 0 / 1 |
| README 渲染 | `vuejs/core/blob/main/README.md` | file_view | 1 | **34 条** | 0 / 1 |
| Issue 详情 | `microsoft/vscode/issues/1` | issue | 46 | **126 条** | 0 / 0 |
| PR 详情 | `vuejs/core/pull/13000` | pull_request | 3 | **24 条** | 0 / 2 |
| Release 列表 | `vuejs/core/releases` | releases_list | 10 | **40 条** | 0 / 42 |
| 代码密集 README | `expressjs/express` | repository_home | 2 | **426 条** | — |

**代码泄漏检查**（在真实页面上对比"收集到的文本"与"页面所有 PRE/CODE/diff 文本"）：

| 页面 | 页面代码段数 | 泄漏数 | 可疑文本 |
|---|---|---|---|
| `vuejs/core` | 1 | **0** | 0 |
| `microsoft/vscode/issues/1` | 0 | **0** | 0 |
| `vuejs/core/releases` | 0 | **0** | 0 |
| `expressjs/express` | 13 | **0** | 0 |

→ 四个页面**零代码泄漏、零可疑模式**（无 diff 特征、无 HTML 标签泄漏、无代码语句）。

### 输入框安全的真实证据

在 Release 列表页，页面上有 **42 个输入控件**（搜索框、隐藏字段等），
**落在内容容器内的：0 个**。

这印证了 `src/core/dom.js` 里的结构性保证：输入控件在 `SKIP_TAGS` 里被挡住，
而内容容器是一个小集合，两者天然不相交。

---

## 二、真实浏览器抓出的两个致命 bug（已修）

### bug 1：`[class*="OverviewContent"]` 把 README 整段误杀

**发现方式**：在 `vuejs/core` 上跑探针，结果是 `containerCount: 0`、`collectedCount: 0`
—— **README 一个字都翻不了**。

**证据**：

```
killedContent: [{
  containerClass: "markdown-body entry-content container-lg",
  excludedBy: "DIV.OverviewContent-module__Box_11__F19kY",
  textPreview: "vuejs/core Getting Started Please follow the documentation at vuejs.org! Sponsor"
}]
```

README 的祖先链（从内到外）：

```
[0] <DIV> DirectoryRichtextContent-module__SharedMarkdownContent__hHXUL
[1] <DIV> OverviewRepoFiles-module__Box_2__zsLGk
[2] <DIV> OverviewRepoFiles-module__Box_1__OXeac
[3] <DIV> OverviewContent-module__Box_11__F19kY   ← 被我的排除规则命中
[4] <DIV> OverviewContent-module__Box__PF75K
...
```

**根因**：`OverviewContent` 在 GitHub **旧版**布局里是侧栏，React 改版后
变成了**整页内容容器**。CSS Module 类名是实现细节，语义会变。
同页 `[class*="Sidebar"]` 更是命中 **73 个**元素，连 `prc-PageLayout-*` 布局包装层都匹配上了。

**修复**：`EXCLUDE_UI_SELECTORS` 里**彻底删除所有 `[class*="..."]` 形式的布局类匹配**，
只保留语义稳定规则（`header`/`footer`/`nav`/ARIA role/精确 ID）。

**修复效果**：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 内容容器 | 0 | **2** |
| 可翻译文本 | **0** | **68** |
| 误杀正文 | 1 处 | **0 处** |

### bug 2：兜底逻辑去翻译"没有正文"的页面

**发现方式**：目录页探针显示 `容器 0 个`，但 `兜底可收集 276 个段落级元素`
—— 那些是文件名和导航。翻它们是错的。

进一步验证发现讨论列表页更严重：`vuejs/core/discussions` 兜底会命中 **202 个**元素。

**根因**：`detectPageType` 把 `/discussions`（列表）与 `/discussions/123`（正文）
当成同一类型，且兜底逻辑无条件启用。

**修复**：
1. 区分列表页与详情页：新增 `discussions_list` / `issues_list` / `pulls_list` / `actions` 类型
2. 新增 `NO_PROSE_PAGE_TYPES` 集合 + `isFallbackAllowedForPage()`，
   这些页面**禁止启用兜底**

**修复效果**（真实页面复验）：

| 页面 | 类型 | 兜底 | 修复后收集 |
|---|---|---|---|
| `tree/main/packages` | directory | 禁止 | **0 条** ✓（原 276） |
| `blob/main/package.json` | file_view | 禁止 | **0 条** ✓ |
| `discussions` | discussions_list | 禁止 | **0 条** ✓（原 202） |
| `issues` | issues_list | 禁止 | **0 条** ✓ |
| `vuejs/core` 首页 | repository_home | 允许 | **68 条** ✓（保持正常） |

---

## 三、逐条选择器的证据等级

### 已验证（真实页面命中）

| 选择器 | 验证页面 | 结果 |
|---|---|---|
| `.markdown-body` | 首页 / README / Issue / PR / Release | ✅ **主力选择器，全部命中** |
| `article.markdown-body` | `vuejs/core` 首页 | ✅ 命中 1，保留 1 |
| `[class*="SharedMarkdownContent"]` | `vuejs/core` 首页 | ✅ 命中 1，保留 1 |
| `[class*="DirectoryRichtextContent"]` | `vuejs/core` 首页 | ✅ 命中 1，保留 1 |
| `[data-testid="issue-body"]` | `vscode/issues/1`、`vuejs/core/pull/13000` | ✅ 命中 1，保留 1 |
| `[class*="IssueBody"]` | Issue / PR 页 | ✅ 命中 20，保留 20 |
| `.comment-body` | `vuejs/core/pull/13000` | ✅ 命中 3，保留 3（PR 页仍有效） |
| `.js-comment-body` | 同上 | ✅ 命中 3，保留 3 |

### 已证伪或降级（我原本猜错，靠验证纠正）

| 选择器 | 状态 | 证据 |
|---|---|---|
| `[data-testid="readme"]` | **降级为辅助** | 在 `vuejs/core` 上出现 **0 次** |
| `.comment-body` / `.js-comment-body` | **仅 PR 页有效** | 在 `vscode/issues/1` 上 **0 次**（React 改版后 Issue 页改用别的结构） |
| `[class*="OverviewContent"]` | **已删除** | 会误杀 README（见 bug 1） |
| `[class*="Sidebar"]` | **已删除** | 命中 73 个元素，包含正文祖先 |

### 仍未验证

| 项目 | 说明 |
|---|---|
| Release 详情页（`/releases/tag/...`）的 `.release-body` | 只验证了 Release **列表**页（`.markdown-body` 有效）；`vuejs/core` 的 tag 页受限于实际存在的 tag |
| Discussion **详情**页（`/discussions/123`） | 只验证了列表页；该仓库无公开 discussion 详情可测 |
| `.discussion-body` / `.release-body` 等旧版类名 | 保留作旧版兼容，未在真实页面上命中过 |

这些若失效，会走宽松模式或（详情页允许的）兜底，不会静默失效。
用 popup 的「诊断（不发请求）」可随时自查。

---

## 四、三级降级机制

```
第 1 级  已验证的稳定选择器       .markdown-body / [data-testid="issue-body"]
   ↓ 一个都没命中，且该页面类型允许兜底
第 2 级  宽松类名模式             [class*="SharedMarkdownContent"] 等
   ↓ 仍然没有
第 3 级  兜底：main / article 内找段落级文本（p / li / h1-h6 / blockquote / td / dd / summary）
         并排除语义化界面外壳
   ↓ 若页面类型属于 NO_PROSE_PAGE_TYPES
       直接禁用兜底，报"该页无正文"而不是乱翻
```

降级路径全部有自动化测试覆盖（`tests/dom.test.js`）：
- 能翻到 `main` 里的段落与列表项
- **不会**翻到导航栏、仓库头部、页脚、侧栏文件树、代码块
- **仍然不触碰输入框**（兜底不能成为安全漏洞）
- 目录页/列表页**禁止兜底**，收集结果为 0

---

## 五、复现验证的方法

```powershell
# 1. 选择器命中情况（自动从真实源码生成探针）
node scripts/run-probe.js "https://github.com/vuejs/core"

# 2. 代码泄漏检查（对比收集结果与页面代码文本）
node scripts/check-code-leak.js "https://github.com/expressjs/express"

# 3. 兜底禁用验证（按页面类型判断是否该翻）
node scripts/verify-fallback.js "https://github.com/vuejs/core/discussions"
```

三个脚本都**直接 import 真实源码**（`src/shared/constants.js`、`src/shared/github-context.js`），
不是硬编码副本 —— 所以验证的就是实际会加载进浏览器的逻辑。

---

## 六、GitHub 改版后的修正流程

1. 点 popup 的「诊断（不发请求）」，看命中情况与模式
2. 若模式为「降级」→ 前两级选择器失效，用 `node scripts/run-probe.js <url>` 复现
3. 在 GitHub 页面按 F12，找到正文容器的真实 class
4. 把新选择器加进 `src/shared/constants.js` 的 `CONTENT_SELECTORS` **列表最前面**
5. 重新加载扩展 + 刷新页面，再点诊断确认

> 两个注意点，都是这次验证换来的教训：
> 1. **不要用 `[class*="..."]` 匹配布局包装层** —— React 改版后语义会变，
>    `OverviewContent` 就是这么从"侧栏"变成"整页容器"的。
> 2. **用包含匹配而不是完整类名** —— 类名形如 `Xxx-module__Name__hash`，hash 会变。
