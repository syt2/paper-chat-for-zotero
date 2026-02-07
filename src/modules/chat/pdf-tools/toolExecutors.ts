/**
 * Tool Executors - 工具执行实现
 */

import type {
  PaperStructureExtended,
  GetPaperSectionArgs,
  SearchPaperContentArgs,
  GetPagesArgs,
  SearchWithRegexArgs,
  GetFullTextArgs,
} from "../../../types/tool";
import { SECTION_ALIASES } from "./constants";
import { parsePageRange } from "./paperParser";
import { getRAGService } from "../../embedding";
import { getErrorMessage } from "../../../utils/common";

/**
 * 执行 get_paper_section
 */
export function executeGetPaperSection(
  args: GetPaperSectionArgs,
  paperStructure: PaperStructureExtended,
): string {
  const requestedSection = args.section.toLowerCase().replace(/\s+/g, "_");

  // 标准化请求的章节名称
  const normalizedRequest =
    SECTION_ALIASES[requestedSection] || requestedSection;

  // 查找匹配的章节
  const section = paperStructure.sections.find(
    (s) => s.normalizedName === normalizedRequest,
  );

  if (section) {
    // 限制返回内容长度
    const maxLength = 8000;
    if (section.content.length > maxLength) {
      return `[Section: ${section.name}]\n\n${section.content.substring(0, maxLength)}...\n\n[Content truncated, total length: ${section.content.length} characters]`;
    }
    return `[Section: ${section.name}]\n\n${section.content}`;
  }

  // 如果没找到，列出可用的章节
  const availableSections = paperStructure.sections
    .map((s) => s.normalizedName)
    .join(", ");
  return `Section "${args.section}" not found. Available sections: ${availableSections}`;
}

/**
 * 执行 search_paper_content
 * 支持语义搜索（如果 RAG 服务可用）和关键词搜索（降级方案）
 */
export async function executeSearchPaperContent(
  args: SearchPaperContentArgs,
  paperStructure: PaperStructureExtended,
  itemKey?: string,
): Promise<string> {
  const { query, max_results = 5 } = args;

  // 尝试使用语义搜索
  if (itemKey) {
    const ragService = getRAGService();
    try {
      if (await ragService.isAvailable()) {
        // 确保已索引
        if (!await ragService.isIndexed(itemKey)) {
          ztoolkit.log(`[searchPaperContent] Indexing paper: ${itemKey}`);
          await ragService.indexPaper(itemKey, paperStructure.fullText);
        }

        // 执行语义搜索
        const semanticResults = await ragService.searchPaper(query, itemKey, max_results);

        if (semanticResults.length > 0) {
          // 格式化语义搜索结果
          const formatted = semanticResults
            .map((r, i) => {
              const truncated =
                r.text.length > 500 ? r.text.substring(0, 500) + "..." : r.text;
              const pageInfo = r.page ? ` Page ${r.page}` : "";
              return `[Result ${i + 1}] (Score: ${(r.score * 100).toFixed(1)}%${pageInfo})\n${truncated}`;
            })
            .join("\n\n---\n\n");

          return `Found ${semanticResults.length} semantically relevant passages for "${query}":\n\n${formatted}`;
        }
      }
    } catch (error) {
      ztoolkit.log(
        "[searchPaperContent] Semantic search failed, falling back to keyword search:",
        getErrorMessage(error),
      );
    }
  }

  // 降级到关键词搜索
  return executeKeywordSearch(query, max_results, paperStructure);
}

/**
 * 执行关键词搜索（降级方案）
 */
function executeKeywordSearch(
  query: string,
  max_results: number,
  paperStructure: PaperStructureExtended,
): string {
  const queryLower = query.toLowerCase();
  const results: Array<{ text: string; score: number; section: string }> = [];

  // 将全文按段落分割
  const paragraphs = paperStructure.fullText
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 50);

  for (const paragraph of paragraphs) {
    const paragraphLower = paragraph.toLowerCase();

    // 计算相关性分数（简单的关键词匹配）
    const words = queryLower.split(/\s+/);
    let score = 0;
    for (const word of words) {
      if (paragraphLower.includes(word)) {
        score += 1;
      }
    }

    // 精确短语匹配加分
    if (paragraphLower.includes(queryLower)) {
      score += 3;
    }

    if (score > 0) {
      // 找出这个段落属于哪个章节
      const charIndex = paperStructure.fullText.indexOf(paragraph);
      const section = paperStructure.sections.find(
        (s) => charIndex >= s.startIndex && charIndex < s.endIndex,
      );

      results.push({
        text: paragraph.trim(),
        score,
        section: section?.name || "Unknown",
      });
    }
  }

  // 按分数排序并取前 N 个
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, max_results);

  if (topResults.length === 0) {
    return `No results found for query: "${query}"`;
  }

  // 格式化结果
  const formatted = topResults
    .map((r, i) => {
      const truncated =
        r.text.length > 500 ? r.text.substring(0, 500) + "..." : r.text;
      return `[Result ${i + 1}] (Section: ${r.section})\n${truncated}`;
    })
    .join("\n\n---\n\n");

  return `Found ${topResults.length} relevant passages for "${query}":\n\n${formatted}`;
}

/**
 * 从 Zotero item key 解析出顶层条目（如果是附件或笔记则取 parent）
 */
function resolveTopLevelItem(itemKey: string): Zotero.Item | null {
  const libraryID = Zotero.Libraries.userLibraryID;
  const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
  if (!item) return null;

  // If it's an attachment (e.g. PDF) or a note, get the parent item
  if ((item.isAttachment?.() || item.isNote?.()) && item.parentItemID) {
    const parent = Zotero.Items.get(item.parentItemID);
    return parent || null;
  }

  return item;
}

/**
 * 执行 get_paper_metadata
 */
export function executeGetPaperMetadata(
  paperStructure: PaperStructureExtended,
  itemKey?: string,
): string {
  const { sections, pageCount } = paperStructure;
  const parts: string[] = [];

  // Try to get metadata from Zotero item
  const item = itemKey ? resolveTopLevelItem(itemKey) : null;

  if (item) {
    // Use Zotero item metadata (authoritative)
    parts.push(`Item Key: ${item.key}`);

    const title = item.getField("title");
    if (title) parts.push(`Title: ${title}`);

    const creators = item.getCreators();
    if (creators && creators.length > 0) {
      const authorNames = creators.map(
        (c: { name?: string; firstName?: string; lastName?: string }) => {
          if (c.name) return c.name;
          return `${c.firstName || ""} ${c.lastName || ""}`.trim();
        },
      );
      parts.push(`Authors: ${authorNames.join(", ")}`);
    }

    const year = item.getField("year");
    if (year) parts.push(`Year: ${year}`);

    const doi = item.getField("DOI");
    if (doi) parts.push(`DOI: ${doi}`);

    const url = item.getField("url");
    if (url) parts.push(`URL: ${url}`);

    const publication = item.getField("publicationTitle");
    if (publication) parts.push(`Publication: ${publication}`);

    const conferenceName = item.getField("conferenceName");
    if (conferenceName) parts.push(`Conference: ${conferenceName}`);

    parts.push(`Pages: ${pageCount}`);

    const abstractText = item.getField("abstractNote");
    if (abstractText) {
      const truncated =
        abstractText.length > 2000
          ? abstractText.substring(0, 2000) + "..."
          : abstractText;
      parts.push(`\nAbstract:\n${truncated}`);
    }

    const tags = item.getTags();
    if (tags && tags.length > 0) {
      const tagNames = tags.map((t: { tag: string }) => t.tag);
      parts.push(`\nTags: ${tagNames.join(", ")}`);
    }
  } else {
    // Fallback: use PDF-parsed metadata
    const { metadata } = paperStructure;
    if (metadata.title) parts.push(`Title: ${metadata.title}`);
    if (metadata.authors && metadata.authors.length > 0) {
      parts.push(`Authors: ${metadata.authors.join(", ")}`);
    }
    if (metadata.year) parts.push(`Year: ${metadata.year}`);
    if (metadata.doi) parts.push(`DOI: ${metadata.doi}`);
    parts.push(`Pages: ${pageCount}`);
    if (metadata.abstract) {
      parts.push(`\nAbstract:\n${metadata.abstract}`);
    }
    if (metadata.keywords && metadata.keywords.length > 0) {
      parts.push(`\nKeywords: ${metadata.keywords.join(", ")}`);
    }
  }

  // Paper structure from PDF parsing (always available)
  const sectionList = sections
    .filter((s) => s.normalizedName !== "full_text")
    .map((s) => `  - ${s.name} (${s.content.length} chars)`)
    .join("\n");

  if (sectionList) {
    parts.push(`\nPaper Structure:\n${sectionList}`);
  }

  return parts.join("\n") || "No metadata available";
}

/**
 * 执行 get_pages - 按页码范围获取内容
 */
export function executeGetPages(
  args: GetPagesArgs,
  paperStructure: PaperStructureExtended,
): string {
  const { pages: pageRange } = args;
  const { pages, pageCount } = paperStructure;

  const requestedPages = parsePageRange(pageRange, pageCount);

  if (requestedPages.length === 0) {
    return `Error: Invalid page range "${pageRange}". Paper has ${pageCount} pages.`;
  }

  const results: string[] = [];
  let totalLength = 0;
  const maxTotalLength = 15000;

  for (const pageNum of requestedPages) {
    const page = pages.find((p) => p.pageNumber === pageNum);
    if (page) {
      const content = page.content;
      if (totalLength + content.length > maxTotalLength) {
        results.push(
          `\n[Page ${pageNum}] (truncated due to length limit)\n${content.substring(0, maxTotalLength - totalLength)}...`,
        );
        results.push(
          `\n[Output truncated. Requested ${requestedPages.length} pages, showing content up to page ${pageNum}]`,
        );
        break;
      }
      results.push(`\n[Page ${pageNum}]\n${content}`);
      totalLength += content.length;
    }
  }

  if (results.length === 0) {
    return `No content found for pages: ${pageRange}`;
  }

  return `Content from pages ${requestedPages.join(", ")} (total ${pageCount} pages):\n${results.join("\n\n---")}`;
}

/**
 * 执行 get_page_count - 获取总页数
 */
export function executeGetPageCount(
  paperStructure: PaperStructureExtended,
): string {
  const { pageCount, fullText } = paperStructure;
  const charCount = fullText.length;
  const wordCount = fullText.split(/\s+/).length;

  return `Page count: ${pageCount}\nCharacter count: ${charCount}\nEstimated word count: ${wordCount}`;
}

/**
 * 执行 search_with_regex - 正则搜索
 */
export function executeSearchWithRegex(
  args: SearchWithRegexArgs,
  paperStructure: PaperStructureExtended,
): string {
  const {
    pattern,
    use_regex = false,
    case_sensitive = false,
    context_lines = 2,
    max_results = 10,
  } = args;

  const lines = paperStructure.fullText.split("\n");
  const results: Array<{
    lineNumber: number;
    match: string;
    context: string;
    page: number;
  }> = [];

  let regex: RegExp;
  try {
    if (use_regex) {
      regex = new RegExp(pattern, case_sensitive ? "g" : "gi");
    } else {
      // 转义特殊字符用于普通文本搜索
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(escaped, case_sensitive ? "g" : "gi");
    }
  } catch (e) {
    return `Error: Invalid regex pattern "${pattern}": ${e}`;
  }

  // 搜索每一行
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      // 重置 regex lastIndex
      regex.lastIndex = 0;

      // 获取上下文
      const startLine = Math.max(0, i - context_lines);
      const endLine = Math.min(lines.length - 1, i + context_lines);
      const contextLines = lines.slice(startLine, endLine + 1);
      const context = contextLines
        .map((l, idx) => {
          const lineNum = startLine + idx + 1;
          const prefix = lineNum === i + 1 ? ">>> " : "    ";
          return `${prefix}${lineNum}: ${l}`;
        })
        .join("\n");

      // 计算所属页码
      const charIndex = lines.slice(0, i).join("\n").length;
      const page =
        paperStructure.pages.find(
          (p) => charIndex >= p.startIndex && charIndex < p.endIndex,
        )?.pageNumber || 1;

      results.push({
        lineNumber: i + 1,
        match: lines[i],
        context,
        page,
      });

      if (results.length >= max_results) {
        break;
      }
    }
  }

  if (results.length === 0) {
    return `No matches found for pattern: "${pattern}"`;
  }

  const formatted = results
    .map(
      (r, i) =>
        `[Match ${i + 1}] Line ${r.lineNumber}, Page ${r.page}\n${r.context}`,
    )
    .join("\n\n---\n\n");

  return `Found ${results.length} matches for "${pattern}":\n\n${formatted}`;
}

/**
 * 执行 get_outline - 获取文档大纲
 */
export function executeGetOutline(
  paperStructure: PaperStructureExtended,
): string {
  const { sections, pageCount } = paperStructure;

  if (
    sections.length === 0 ||
    (sections.length === 1 && sections[0].normalizedName === "full_text")
  ) {
    return "No structured outline detected. The paper may not have clear section headings.";
  }

  const outline = sections
    .filter((s) => s.normalizedName !== "full_text")
    .map((s, i) => {
      // 估算页码
      const page =
        paperStructure.pages.find(
          (p) => s.startIndex >= p.startIndex && s.startIndex < p.endIndex,
        )?.pageNumber || "?";
      return `${i + 1}. ${s.name} (Page ~${page}, ${s.content.length} chars)`;
    })
    .join("\n");

  return `Document Outline (${pageCount} pages total):\n\n${outline}`;
}

/**
 * 执行 list_sections - 列出所有章节
 */
export function executeListSections(
  paperStructure: PaperStructureExtended,
): string {
  const { sections } = paperStructure;

  if (sections.length === 0) {
    return "No sections detected.";
  }

  const sectionList = sections.map((s) => ({
    name: s.name,
    normalizedName: s.normalizedName,
    charCount: s.content.length,
    preview: s.content.substring(0, 100).replace(/\n/g, " ") + "...",
  }));

  const formatted = sectionList
    .map(
      (s, i) =>
        `${i + 1}. ${s.name}\n   ID: ${s.normalizedName}\n   Length: ${s.charCount} chars\n   Preview: ${s.preview}`,
    )
    .join("\n\n");

  return `Available sections (${sections.length} total):\n\n${formatted}`;
}

/**
 * 执行 get_full_text - 获取完整原文（高 token 消耗）
 */
export function executeGetFullText(
  args: GetFullTextArgs,
  paperStructure: PaperStructureExtended,
): string {
  if (!args.confirm) {
    return `Error: You must set confirm=true to use this tool. This tool returns the entire paper content and consumes many tokens. Please consider using targeted tools like get_paper_section, get_pages, or search_paper_content first.`;
  }

  const { fullText, pageCount } = paperStructure;
  const charCount = fullText.length;
  const estimatedTokens = Math.ceil(charCount / 4); // 粗略估算 token 数

  // 添加警告头部
  const header = `[WARNING: Full text retrieved - approximately ${estimatedTokens} tokens]\n[Paper: ${pageCount} pages, ${charCount} characters]\n\n---\n\n`;

  return header + fullText;
}
