/**
 * PDF Tool Constants - 论文解析相关常量
 */

// 常见的论文章节名称及其变体
export const SECTION_PATTERNS: Record<string, RegExp> = {
  abstract: /^abstract\b/i,
  introduction: /^(1\.?\s*)?(introduction|background)\b/i,
  related_work: /^(2\.?\s*)?(related\s+work|literature\s+review|background)\b/i,
  methodology:
    /^(3\.?\s*)?(method|methodology|approach|materials?\s+and\s+methods?)\b/i,
  experiments: /^(4\.?\s*)?(experiment|evaluation|implementation)\b/i,
  results: /^(5\.?\s*)?(result|finding)\b/i,
  discussion: /^(6\.?\s*)?(discussion|analysis)\b/i,
  conclusion: /^(7\.?\s*)?(conclusion|summary|future\s+work)\b/i,
  references: /^(references|bibliography)\b/i,
  appendix: /^(appendix|supplementary)\b/i,
};

// 标准化章节名称映射
export const SECTION_ALIASES: Record<string, string> = {
  abstract: "abstract",
  introduction: "introduction",
  background: "introduction",
  related_work: "related_work",
  "literature review": "related_work",
  method: "methodology",
  methods: "methodology",
  methodology: "methodology",
  approach: "methodology",
  "materials and methods": "methodology",
  experiment: "experiments",
  experiments: "experiments",
  evaluation: "experiments",
  implementation: "experiments",
  result: "results",
  results: "results",
  finding: "results",
  findings: "results",
  discussion: "discussion",
  analysis: "discussion",
  conclusion: "conclusion",
  conclusions: "conclusion",
  summary: "conclusion",
  "future work": "conclusion",
  references: "references",
  bibliography: "references",
  appendix: "appendix",
  supplementary: "appendix",
};

// 页面分隔符模式（常见的 PDF 提取文本中的页面标记）
export const PAGE_BREAK_PATTERNS = [
  /\f/g, // Form feed character
  /\n{3,}/g, // Multiple newlines
  /(?:^|\n)(?:\d+\s*(?:of\s*\d+)?|\[\d+\])\s*(?:\n|$)/gi, // Page numbers like "1 of 10" or "[1]"
];

// 估计每页平均字符数（用于没有明确页面标记时的估算）
export const ESTIMATED_CHARS_PER_PAGE = 3000;
