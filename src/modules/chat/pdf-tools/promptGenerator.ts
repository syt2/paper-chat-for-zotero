/**
 * Prompt Generator - 系统提示生成
 */

import type { PaperStructureExtended } from "../../../types/tool";

/**
 * 生成系统提示（包含当前论文信息和工具使用说明）
 * @param currentPaperStructure 当前论文的结构（可选）
 * @param currentItemKey 当前 item 的 key（可选）
 * @param currentTitle 当前论文标题（可选）
 * @param hasCurrentItem 是否有当前选中的 item
 */
export function generatePaperContextPrompt(
  currentPaperStructure?: PaperStructureExtended,
  currentItemKey?: string,
  currentTitle?: string,
  hasCurrentItem: boolean = true,
): string {
  let prompt = `You are a helpful research assistant analyzing academic papers.\n\n`;

  // 如果没有当前 item，显示提示
  if (!hasCurrentItem) {
    prompt += `=== NO PAPER SELECTED ===
Currently, no paper is selected in the reader. You can only access Zotero library tools:
- list_all_items: List all items in the Zotero library (with pagination)
- get_item_metadata: Get bibliographic metadata of any Zotero item (no PDF needed)
- get_item_notes: Get all notes/annotations for an item
- get_note_content: Get the full content of a specific note

To access PDF content tools, the user needs to open a paper in the PDF reader.
You can help the user by listing available papers with list_all_items or answering questions about their Zotero library.
\n`;
    return prompt;
  }

  // 当前论文详情
  if (currentPaperStructure) {
    const title =
      currentTitle || currentPaperStructure.metadata.title || "Current Paper";
    prompt += `=== CURRENT PAPER ===\n`;
    prompt += `Title: "${title}"\n`;
    prompt += `itemKey: "${currentItemKey || "unknown"}"\n`;
    prompt += `Pages: ${currentPaperStructure.pageCount}\n`;

    if (currentPaperStructure.metadata.abstract) {
      prompt += `\nAbstract:\n${currentPaperStructure.metadata.abstract}\n`;
    }

    const sectionList = currentPaperStructure.sections
      .filter((s) => s.normalizedName !== "full_text")
      .map((s) => s.normalizedName)
      .join(", ");

    if (sectionList) {
      prompt += `\nAvailable sections: ${sectionList}\n`;
    }
    prompt += `\n`;
  }

  // 工具使用说明
  prompt += `=== PDF CONTENT TOOLS ===
- get_paper_section: Get content of a specific section
- search_paper_content: Search for keywords/phrases
- get_paper_metadata: Get paper metadata from PDF content
- get_pages: Get content by page range (e.g., "1-5,10")
- get_page_count: Get total page count and statistics
- search_with_regex: Advanced search with regex and context
- get_outline: Get document outline/TOC
- list_sections: List all available sections
- get_full_text: [HIGH TOKEN COST] Get entire paper content - use only as last resort

=== ZOTERO LIBRARY TOOLS ===
- list_all_items: List all items in the Zotero library (with pagination)
- get_item_metadata: Get bibliographic metadata of any Zotero item (no PDF needed)
- get_item_notes: Get all notes/annotations for an item
- get_note_content: Get the full content of a specific note

=== IMPORTANT NOTES ===
1. PDF content tools accept an optional "itemKey" parameter to query a specific paper.
2. If itemKey is not specified, PDF tools operate on the CURRENT paper.
3. Use list_all_items to discover available papers and their itemKeys.
4. Use get_item_metadata to get bibliographic info even without a PDF.
5. Always prefer targeted tools over get_full_text to minimize token usage.
6. Do not make up information - use the tools to verify.\n`;

  return prompt;
}
