/**
 * 小工具函数集合。无依赖，可被任何环境引入。
 */

/** 延迟 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 字符串哈希（FNV-1a 32 位变体，输出 8 位十六进制）。
 * 用途：缓存键。不需要密码学强度，只需要稳定、快、碰撞率够低。
 */
export function hashString(str) {
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
export function cacheKey({ text, contextKey, targetLang, promptVersion, model }) {
  return hashString(
    [text, contextKey, targetLang, promptVersion, model].join('\u0000')
  );
}

/** 归一化文本：折叠空白，用于比较与缓存（不用于替换，替换要用原文） */
export function normalizeText(str) {
  return String(str).replace(/\s+/g, ' ').trim();
}

/** 是否包含可翻译的"自然语言"内容 */
export function hasTranslatableContent(str) {
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
export function looksLikeChinese(str) {
  const cjk = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const letters = (str.match(/[A-Za-z\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (letters === 0) return false;
  return cjk / letters > 0.35;
}

/** 纯标识符/代码特征 —— 挡掉不该翻的短串 */
export function looksLikeIdentifier(str) {
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
export function isVisible(element) {
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
export async function mapWithConcurrency(items, limit, worker) {
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
export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}
