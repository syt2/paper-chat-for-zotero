/**
 * Paper Parser - 论文结构解析
 */

import type {
  PaperSection,
  PaperMetadata,
  PageInfo,
  PaperStructureExtended,
} from "../../../types/tool";
import { SECTION_PATTERNS, ESTIMATED_CHARS_PER_PAGE } from "./constants";

/**
 * 解析论文结构（扩展版，包含页面信息）
 */
export function parsePaperStructure(pdfText: string): PaperStructureExtended {
  const lines = pdfText.split("\n");
  const sections: PaperSection[] = [];
  const metadata = extractMetadata(pdfText);
  const pages = parsePages(pdfText);

  let currentSection: {
    name: string;
    normalizedName: string;
    startIndex: number;
    lines: string[];
  } | null = null;

  let charIndex = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // 检查是否是章节标题
    const sectionMatch = matchSectionHeader(trimmedLine);

    if (sectionMatch) {
      // 保存上一个章节
      if (currentSection) {
        sections.push({
          name: currentSection.name,
          normalizedName: currentSection.normalizedName,
          content: currentSection.lines.join("\n").trim(),
          startIndex: currentSection.startIndex,
          endIndex: charIndex,
        });
      }

      // 开始新章节
      currentSection = {
        name: trimmedLine,
        normalizedName: sectionMatch,
        startIndex: charIndex,
        lines: [],
      };
    } else if (currentSection) {
      currentSection.lines.push(line);
    }

    charIndex += line.length + 1; // +1 for newline
  }

  // 保存最后一个章节
  if (currentSection) {
    sections.push({
      name: currentSection.name,
      normalizedName: currentSection.normalizedName,
      content: currentSection.lines.join("\n").trim(),
      startIndex: currentSection.startIndex,
      endIndex: charIndex,
    });
  }

  // 如果没有检测到任何章节，将整个文本作为一个章节
  if (sections.length === 0) {
    sections.push({
      name: "Full Text",
      normalizedName: "full_text",
      content: pdfText,
      startIndex: 0,
      endIndex: pdfText.length,
    });
  }

  return {
    metadata,
    sections,
    fullText: pdfText,
    pages,
    pageCount: pages.length,
  };
}

/**
 * 解析页面信息
 */
export function parsePages(pdfText: string): PageInfo[] {
  const pages: PageInfo[] = [];

  // 尝试通过 form feed 字符分割
  let pageTexts = pdfText.split("\f");

  // 如果没有 form feed，尝试通过多个换行符分割
  if (pageTexts.length <= 1) {
    // 按估计字符数分割
    const totalLength = pdfText.length;
    const estimatedPageCount = Math.max(
      1,
      Math.ceil(totalLength / ESTIMATED_CHARS_PER_PAGE),
    );

    pageTexts = [];
    for (let i = 0; i < estimatedPageCount; i++) {
      const start = i * ESTIMATED_CHARS_PER_PAGE;
      const end = Math.min((i + 1) * ESTIMATED_CHARS_PER_PAGE, totalLength);

      // 尝试在段落边界处分割
      let adjustedEnd = end;
      if (end < totalLength) {
        const nextParagraph = pdfText.indexOf("\n\n", end - 200);
        if (nextParagraph !== -1 && nextParagraph < end + 200) {
          adjustedEnd = nextParagraph + 2;
        }
      }

      pageTexts.push(pdfText.substring(start, adjustedEnd));
    }
  }

  let currentIndex = 0;
  for (let i = 0; i < pageTexts.length; i++) {
    const content = pageTexts[i];
    pages.push({
      pageNumber: i + 1,
      startIndex: currentIndex,
      endIndex: currentIndex + content.length,
      content: content.trim(),
    });
    currentIndex += content.length + 1; // +1 for separator
  }

  return pages;
}

/**
 * 解析页码范围字符串
 * 支持格式: "1", "1-5", "1,3,5", "1-3,7,10-12"
 */
export function parsePageRange(rangeStr: string, maxPage: number): number[] {
  const pages: Set<number> = new Set();
  const parts = rangeStr.split(",").map((s) => s.trim());

  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-").map((s) => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(maxPage, end); i++) {
          pages.add(i);
        }
      }
    } else {
      const page = parseInt(part, 10);
      if (!isNaN(page) && page >= 1 && page <= maxPage) {
        pages.add(page);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * 提取论文元数据
 */
export function extractMetadata(pdfText: string): PaperMetadata {
  const metadata: PaperMetadata = {};

  // 尝试从文本开头提取标题（通常是第一行非空内容）
  const lines = pdfText.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    // 标题通常较短且在开头
    const potentialTitle = lines[0].trim();
    if (potentialTitle.length < 200 && potentialTitle.length > 10) {
      metadata.title = potentialTitle;
    }
  }

  // 提取摘要
  const abstractMatch = pdfText.match(
    /abstract[:\s]*\n?([\s\S]*?)(?=\n\s*(?:1\.?\s*)?(?:introduction|keywords|background)\b)/i,
  );
  if (abstractMatch) {
    metadata.abstract = abstractMatch[1].trim().substring(0, 2000);
  }

  // 提取关键词
  const keywordsMatch = pdfText.match(
    /keywords?[:\s]*([^\n]+(?:\n(?![A-Z1-9])[^\n]+)*)/i,
  );
  if (keywordsMatch) {
    metadata.keywords = keywordsMatch[1]
      .split(/[,;]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0 && k.length < 50);
  }

  // 尝试提取 DOI
  const doiMatch = pdfText.match(/\b(10\.\d{4,}\/[^\s]+)\b/);
  if (doiMatch) {
    metadata.doi = doiMatch[1];
  }

  // 尝试提取年份
  const yearMatch = pdfText.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    metadata.year = parseInt(yearMatch[0], 10);
  }

  return metadata;
}

/**
 * 匹配章节标题
 */
export function matchSectionHeader(line: string): string | null {
  const trimmed = line.trim();

  // 跳过太短或太长的行
  if (trimmed.length < 3 || trimmed.length > 100) {
    return null;
  }

  // 检查是否匹配已知的章节模式
  for (const [normalizedName, pattern] of Object.entries(SECTION_PATTERNS)) {
    if (pattern.test(trimmed)) {
      return normalizedName;
    }
  }

  return null;
}
