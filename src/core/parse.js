/**
 * 模型返回结果的解析。
 *
 * 【为什么单独抽一个文件】
 * 这是纯函数逻辑，不依赖 DOM、不依赖 chrome、不依赖网络。
 * 抽出来之后可以用 `node --test` 直接跑单元测试 —— 在"我无法在浏览器里点按钮"
 * 的前提下，这是唯一能自动化验证的部分。所以它值得单独存在。
 */

export class TranslateError extends Error {
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
export function parseModelOutput(content) {
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
export function alignToItems(byIndex, items) {
  const result = new Map();
  for (const item of items) {
    const translated = byIndex.get(item.i);
    const usable = typeof translated === 'string' && translated.trim();
    result.set(item.i, usable ? translated : item.text);
  }
  return result;
}
