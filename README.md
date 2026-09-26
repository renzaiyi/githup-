# GitHub 智能翻译

一个零构建的原生 Manifest V3 浏览器扩展：在 GitHub 网页上把**正文**用 LLM 意译成中文，
同时**绝不触碰你键入的英文**，也**绝不翻译代码块**。

- **浏览器**：Microsoft Edge 111+ / Chrome 111+（在 Edge 153 上开发与验证）
- **零构建**：clone 下来直接「加载解压缩的扩展」，无需 npm install
- **翻译范围**：README、Issue、PR、Release、Discussion 正文，以及**搜索结果**的仓库描述
- **隐私**：译文只发给你自己配置的 API（默认 DeepSeek），没有中间服务器

## 快速开始

```text
1. 下载本仓库（或 git clone）
2. 打开 edge://extensions/  →  打开「开发人员模式」
3. 点「加载解压缩的扩展」→ 选择本仓库根目录（含 manifest.json 的那层）
4. 打开任意 GitHub 仓库页，按 F5
5. 点工具栏的蓝色「译」图标 → 填入 DeepSeek API Key → 点「测试连接」
6. 回到页面点「翻译此页」
```

> **加载后必须刷新 GitHub 页面**：内容脚本只在页面加载时注入。
> **首次填 Key 后建议先点「诊断（不发请求）」**：它不花钱，能立刻告诉你扩展在当前页面看到了什么。

## 界面汉化怎么办

本扩展**刻意不翻界面**（菜单、按钮、导航）。界面上是固定词条，用词库替换比 LLM 更准更快，
也不会因为翻按钮而破坏 GitHub 的 React 组件。界面汉化请配合
[github-chinese](https://github.com/maboloshi/github-chinese) 使用，两者不冲突：

| 层 | 由谁负责 |
|---|---|
| 界面（菜单 / 按钮 / 时间） | github-chinese（静态词库） |
| 正文（README / Issue / PR / 搜索结果） | 本扩展（LLM 意译） |

---

## 一、它做了什么

| 能力 | 说明 |
|---|---|
| **正文意译** | 用 DeepSeek 按 GitHub 页面上下文翻译，不是逐句直译 |
| **绝不碰输入框** | `INPUT`/`TEXTAREA`/`contenteditable` 在遍历时就被挡住，你搜 `react hooks` 框里就还是 `react hooks` |
| **绝不翻代码** | `PRE`/`CODE` 整棵子树跳过；diff 表格、文件树也在排除清单里 |
| **术语统一** | 提示词 + 可编辑术语表，全页一致 |
| **双语 / 纯中文** | 原文永远保留，译文插在它后面；可随时切换或一键复原 |
| **动态内容** | MutationObserver 监听 React 的 DOM 变化，切换 Tab、展开折叠会自动补翻 |
| **增量 + 缓存** | 已翻译的节点不再重复收集（不重复付费）；译文按哈希存 IndexedDB，跨页面跨会话复用 |

## 二、它刻意不做的事（避免破坏 GitHub）

- **不翻界面标签**（Code / Issues / Settings…）。那部分用词库替换更准更快，
  交给手册第 1 步的 github-chinese，两者互不冲突。
- **不翻导航栏、侧栏、文件树、diff**。只翻"正文容器"里的内容，采用**白名单**思路：
  宁可少翻，绝不翻坏。
- **不改写原有文本节点**。译文是**新增**的 `<span>`，原文一个字符都不动，
  所以「复原」是真的复原，不留副作用。

---

## 三、安装（约 2 分钟）

1. 打开 Edge，地址栏输入 `edge://extensions/`
2. 左下角打开 **「开发人员模式」**
3. 点 **「加载解压缩的扩展」**
4. 选择这个文件夹：`D:\新建文件夹\github-smart-translate`
5. 加载成功后，工具栏会出现一个蓝色「译」图标

> ⚠️ **改过代码后必须点扩展卡片上的「重新加载」**，并在 GitHub 页面按 F5。
> 内容脚本只在页面加载时注入一次，不刷新页面改了也不生效。

---

## 四、配置 API Key（唯一要花钱的地方）

1. 点工具栏的「译」图标打开弹窗
2. 填入 DeepSeek 的 API Key（`sk-...`，在 https://platform.deepseek.com/ 创建）
3. 模型默认 `deepseek-flash`，接口地址默认 `https://api.deepseek.com/v1`
4. 点 **「测试连接」**。看到 `Hello world → 你好，世界` 之类即成功
5. 点 **「保存」**

**费用参考**：单个 GitHub 页面约 ¥0.06；缓存命中后重复访问 ≈ ¥0。

> 模型名若报 `404 模型不存在`，去 https://api-docs.deepseek.com/quick_start/pricing
> 查当前可用模型名，在弹窗里改掉即可（DeepSeek 会调整模型命名）。

---

## 五、使用

| 操作 | 结果 |
|---|---|
| 打开 GitHub 页面，点图标 → **「翻译此页」** | 翻译当前页正文 |
| 弹窗里选 **双语 / 纯中文** | 切换显示方式（即时生效，不需重新翻译） |
| 勾选 **「打开页面时自动翻译」** | 以后打开 GitHub 页面自动翻（注意费用） |
| 点 **「复原页面」** | 移除全部译文，页面回到原样 |
| 点 **「清空缓存」** | 清掉该站点的译文缓存（换提示词后想强制重翻时用） |
| 点 **「诊断（不发请求）」** | **排查神器**：报告扩展在当前页面看到了什么，不花任何 token |

### 已在真实浏览器上验证过（重要）

开发过程中用浏览器自动化在**真实 GitHub 页面**上执行了扩展的真实逻辑
（探针脚本直接 `import` 真实源码，不是副本）。结论：

| 页面 | 类型 | 容器 | 可翻译文本 | 输入框在容器内 |
|---|---|---|---|---|
| `vuejs/core` 首页 | repository_home | 2 | 68 条 | 0 |
| `vuejs/core/blob/main/README.md` | file_view | 1 | 34 条 | 0 |
| `microsoft/vscode/issues/1` | issue | 46 | 126 条 | 0 |
| `vuejs/core/pull/13000` | pull_request | 3 | 24 条 | 0 |
| `vuejs/core/releases` | releases_list | 10 | 40 条 | 0 / 42 个输入框 |
| `expressjs/express`（代码密集） | repository_home | 2 | 426 条 | — |
| `vuejs/core/discussions`（列表） | discussions_list | 0 | **0 条（正确）** | 0 |
| `vuejs/core/tree/main/packages`（目录） | directory | 0 | **0 条（正确）** | 0 |
| `microsoft/vscode/pull/200000/files`（diff） | pull_request_files | 0 | **0 条（正确）** | 0 |

**代码泄漏检查**：在上述所有页面（含 13 段代码的 `expressjs/express` 与
17 段 `.blob-code` 的 diff 页）比对"收集到的文本"与"页面所有代码文本"——
**零泄漏、零可疑模式**。

**真实浏览器抓出的两个致命 bug（已修）**：

1. **`[class*="OverviewContent"]` 把 README 整段误杀** —— 真实页面上
   `containerCount: 0`、`collectedCount: 0`，**README 一个字都翻不了**。
   该选择器命中了包裹 README 的祖先节点（GitHub 改版后语义从"侧栏"变成"整页容器"）。
   已删除所有 `[class*="..."]` 形式的布局类匹配，只保留语义稳定规则。
   **修复后：0 → 68 条。**
2. **兜底逻辑去翻"没有正文"的页面** —— 目录页会去翻 **276 个**段落级元素
   （文件名与导航），讨论列表页更严重（**202 个**）。
   已新增 `NO_PROSE_PAGE_TYPES` 并区分列表页/详情页，这些页面禁止兜底。

完整的证据、祖先链、逐条选择器的证据等级：见 `SELECTOR-VERIFICATION.md`。

复现验证：

```powershell
node scripts/run-probe.js "https://github.com/vuejs/core"                  # 选择器命中
node scripts/check-code-leak.js "https://github.com/expressjs/express"     # 代码泄漏
node scripts/verify-fallback.js "https://github.com/vuejs/core/discussions" # 兜底禁用
```

### 诊断功能怎么用（出问题时先点它）

如果"点翻译没反应"，点「诊断」，你会看到类似：

```
页面类型：repository_home
仓库：vuejs/core
匹配到的容器：3 个
模式：正常
将翻译的文本节点：87 条
命中的选择器：
  · .markdown-body × 2
  · article.markdown-body × 1
待翻译样本：
  · Run the following command to install dependencies...
  · This will not work if the GITHUB_TOKEN environment...
```

对照判断：

| 诊断显示 | 含义 | 处理 |
|---|---|---|
| 容器 0 个 | 主选择器和兜底都没命中，GitHub 大改版了 | 把诊断结果发我，改 `CONTENT_SELECTORS` |
| 模式：降级 | 主选择器失效，正在用 `main`/`article` 兜底凑合 | 能翻但可能多翻或漏翻，把诊断发我 |
| 容器 >0 但文本节点 0 条 | 命中了容器，但内容都被筛掉了 | 看"待翻译样本"，多半是内容本来就已是中文 |
| 命中选择器里没有 `markdown-body` | 当前页面类型本来就没有 README | 正常，看页面类型是否合理 |

**选择器是分三级设计的**（见 `src/shared/constants.js`）：已验证的稳定选择器 → 宽松类名模式 → `main`/`article` 兜底。
所以即使 GitHub 改版导致第一级失效，扩展也不会静默失效，而是降级继续工作并在诊断里标出来。

---

## 六、先做自检（不用装扩展，1 分钟）

**这是在没有浏览器的情况下验证安全边界的手段。**

方式 A：直接双击打开
```
D:\新建文件夹\github-smart-translate\tests\self-test.html
```
它会显示 PASS/FAIL 清单。重点看这几条：
- 输入框 value 未被收集
- placeholder 也未被收集
- 围栏代码块 / diff 表格 / 代码注释未被收集
- 注入译文后输入框 value 完全未变

方式 B：命令行自动化（更严格）
```powershell
cd "D:\新建文件夹\github-smart-translate"
node --test tests/core.test.js tests/dom.test.js   # 32 个测试
node scripts/check.js                             # 装机前自检
```

---

## 七、验收清单（装完后请务必实测）

### A. 你最关心的：搜索框安全

- [ ] 在 GitHub 搜索框键入 `react hooks`，框内文字**一个字符都不变**
- [ ] 搜索联想下拉**保持英文**
- [ ] 键入 `useState<T>`、`foo::bar` 这类符号，不被转义或吞字符
- [ ] 代码搜索页（`type=code`）输入框同样不受影响

### B. 代码不被翻译

- [ ] 打开一个 README 含代码块的仓库，翻译后**代码块保持英文原样**
- [ ] 打开某个 PR 的 Files changed，**diff 不被翻译**
- [ ] 仓库文件树**文件名不被翻译**

### C. 译文质量

- [ ] 译文像人写的，不是逐词直译
- [ ] 同一术语在页面内前后一致
- [ ] 表格未错行、链接仍可点、图片仍显示

### D. 稳定性

- [ ] 点右上角头像菜单，菜单正常弹出（**这是最容易翻车处**）
- [ ] 点 Star 按钮，行为正常
- [ ] 滚动页面时下方内容继续翻译
- [ ] 点「复原页面」后，页面完全回到原始状态

> 若 D 组出问题，**先点「复原页面」，再关掉自动翻译**，
> 然后把 `edge://extensions/` 里的报错（点扩展卡片的「错误」按钮）发给我。

---

## 八、目录结构

```
.
├── manifest.json               # MV3 清单（指向 bundle.js）
├── LICENSE                     # MIT
├── package.json                # 仅用于构建与测试，扩展运行时不依赖它
├── icons/                      # 四种尺寸图标
├── .github/workflows/verify.yml# CI：产物同步检查 + 测试 + 自检
├── src/
│   ├── background.js           # Service Worker：唯一发网络请求的地方
│   ├── shared/
│   │   ├── constants.js        # SKIP_TAGS / 白名单 / 提示词版本
│   │   ├── util.js             # 哈希、标识符判定、并发控制
│   │   ├── settings.js         # chrome.storage 封装
│   │   ├── cache.js            # 内存 + IndexedDB 两层缓存
│   │   ├── prompts.js          # 提示词构造（"人性化"的核心）
│   │   └── github-context.js   # 页面类型识别与内容策略分流
│   ├── core/
│   │   ├── dom.js              # 文本收集与译文注入（最关键的模块）
│   │   ├── parse.js            # 模型输出解析（纯函数，可测）
│   │   ├── translate.js        # 网络层，带重试与错误提示
│   │   └── styles.js           # 内联样式注入（含纯中文模式）
│   ├── content/
│   │   ├── main.js             # 内容脚本入口（源码）
│   │   ├── bundle.js           # ⚙ 生成物，由 build-content.js 产出，随仓库提交
│   │   └── diag.js             # 最小诊断脚本（排查注入问题用）
│   └── popup/                  # 弹窗界面
├── tests/
│   ├── core.test.js            # 纯逻辑测试（URL 识别、输出解析、提示词）
│   ├── dom.test.js             # DOM 测试（含"输入框永不被碰"的结构性证明）
│   ├── search.test.js          # 搜索结果页测试
│   ├── bundle.test.js          # 对**产物本身**的冒烟测试（jsdom 里真实执行）
│   ├── self-test.html          # 浏览器里可直接打开的可视化自检
│   └── fixtures*.html          # 模拟 GitHub DOM
└── scripts/
    ├── build-content.js        # 把模块打包成单文件经典脚本
    ├── check.js                # 装机前自检（产物同步、import、BOM、危险模式）
    ├── check-bindings.js       # 校验具名 import 是否真实存在
    └── verify-*.js / probe-*.js# 真机验证脚本（需 agent-browser）
```

---

## 九、开发与构建

### 为什么产物要提交进仓库

`src/content/bundle.js` 是**生成物**，但仍然刻意提交，原因是本项目的核心卖点是
「clone 下来直接加载、零构建」。如果产物不入库，用户就得先装 Node 才能使用。

代价是产物可能与源码脱节，所以有两道防线：

1. `scripts/check.js` 会检查产物是否比任一源文件旧，旧了直接报错
2. CI 会重新构建并 `git diff`，不一致就失败

### 常用命令

```bash
npm ci            # 安装测试依赖（只有 jsdom）
npm run build     # 重新生成 src/content/bundle.js
npm test          # 62 个测试
npm run check     # 装机前自检
npm run bindings  # 校验 import/export 绑定
npm run verify    # 上述全部串起来跑一遍
```

### 真机验证脚本

`scripts/` 下另有一组脚本，用浏览器自动化在**真实 GitHub 页面**上执行真实产物，
用来验证选择器是否命中、代码是否泄漏、聚合是否生效：

```bash
node scripts/verify-bundle.js "https://github.com/vuejs/core"        # 任意页面
node scripts/verify-search.js "https://github.com/search?q=react&type=repositories"
node scripts/verify-fallback.js "https://github.com/vuejs/core/discussions"
```

这些脚本需要 [`agent-browser`](https://www.npmjs.com/package/agent-browser)，且要先
`npm run build`（它们用 `bundle.exposed.js` 这个带调试暴露层的验证产物）。
**它们不是扩展运行时的依赖**，只是开发工具。

> 选择器的证据等级、真机实测数据、以及每一条"我猜错并被验证纠正"的记录，
> 都写在 [`SELECTOR-VERIFICATION.md`](./SELECTOR-VERIFICATION.md) 里。

---

## 十、已知约束与后续

| 项 | 状态 |
|---|---|
| 界面标签汉化 | **刻意不做**，交给 github-chinese |
| 搜索页 | 仅覆盖**仓库搜索**；Issue / PR / 用户搜索的结构不同，尚未支持 |
| 图片内文字（OCR） | 未实现 |
| 划词翻译 | 未实现 |
| 术语表可视化编辑 | 目前是文本框，每行 `英文 => 中文` |
| 多服务商 | 目前只配了 DeepSeek 的 host 权限；换别家需改 `manifest.json` 的 `host_permissions` |
| GitHub 改版适配 | 白名单选择器在 `src/shared/constants.js` 的 `CONTENT_SELECTORS`，改版时改这里 |
| 真实浏览器验证 | **必须由你实测**（见第七节） |

---

## 十一、排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 点「翻译此页」提示"内容脚本尚未注入" | 扩展刚装/刚重载，页面还没刷新 | 在 GitHub 页面按 F5 |
| 提示"未填写 API Key" | 没保存 key | 弹窗填 key → 保存 |
| `API 返回 401` | key 错或过期 | 重新创建 key |
| `API 返回 402` | 余额不足 | 去 DeepSeek 平台充值 |
| `API 返回 404 模型不存在` | 模型名变了 | 弹窗里改模型名 |
| 网络错误 / 请求超时 | 后台被拦或网络不通 | 确认 `manifest.json` 里 host_permissions 有 `https://api.deepseek.com/*` |
| 翻译了但不显示 | 显示模式是"关闭" | 弹窗切到双语/纯中文 |
| 只有部分内容被翻译 | 该区域不在白名单容器里 | 先点「诊断」看命中的选择器；确认是正文则把选择器加进 `CONTENT_SELECTORS` |
| 点翻译后提示"没有找到需要翻译的正文" | 选择器没匹配上，或内容已是中文 | 点「诊断」，把结果发我 |
| 界面标签还是英文 | 这是刻意设计 | 装 github-chinese |

---

## 十二、选择器验证记录（写给未来的自己）

`CONTENT_SELECTORS` 不是凭印象写的，`.markdown-body` 这一条**已对真实 GitHub 页面验证过**：

- 抓取 `https://github.com/vuejs/core`（HTTP 200，333 KB HTML）
- `markdown-body` 出现 **2 次**，实际渲染为：
  `<article class="markdown-body ..." data-hpc="true">`
- 同页面还发现目录页的新类名 `DirectoryRichtextContent-module__SharedMarkdownContent__hHXUL`
  → 已加入选择器的"宽松模式"一级

同时验证出的一个反例：`data-testid="readme"` 在该页面**一次都没出现** ——
这条是我最初凭印象写的，已降级为辅助选择器，不作为主力。
这也是为什么要做三级降级：**主要靠已验证的类名，同时用宽松模式兜住改版。**
