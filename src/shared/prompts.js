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
export function parseGlossary(raw) {
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
export function buildSystemPrompt({ pageContext, glossary }) {
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
export function buildUserPrompt(items) {
  return JSON.stringify({ segments: items.map((item) => ({ i: item.i, text: item.text })) });
}
