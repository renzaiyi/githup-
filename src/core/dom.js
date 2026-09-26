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
import {
  SKIP_TAGS,
  CONTENT_SELECTORS,
  SEARCH_CONTENT_SELECTORS,
  SEARCH_EXCLUDE_SELECTORS,
  FALLBACK_CONTAINER_SELECTORS,
  EXCLUDE_SELECTORS,
  MIN_TEXT_LENGTH,
  MAX_TEXT_LENGTH,
  NS,
} from '../shared/constants.js';
import {
  normalizeText,
  hasTranslatableContent,
  looksLikeChinese,
  looksLikeIdentifier,
  isVisible,
} from '../shared/util.js';

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
export function findContentContainers(options = {}) {
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
export function collectTextNodes(options = {}) {
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
export function getLastReport() {
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
export function injectTranslation(nodeOrNodes, translation) {
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
export function applyMode(mode) {
  document.documentElement.setAttribute(`data-${NS}-mode`, mode);
}

/**
 * 全部复原：移除所有注入的译文与原包装，页面回到原始状态。
 * 顺序很重要 —— 必须先解包（把原文节点放回父元素），再删译文，
 * 否则会出现"原文还藏在即将被删的 wrapper 里"的中间态。
 */
export function removeAllTranslations() {
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
export function countInjected() {
  return document.querySelectorAll(`[data-${NS}-role="translation"]`).length;
}
