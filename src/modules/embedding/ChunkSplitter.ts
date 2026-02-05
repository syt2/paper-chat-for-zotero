/**
 * ChunkSplitter - Text chunking for RAG
 *
 * Splits text into semantically meaningful chunks for embedding
 */

import type { TextChunk, ChunkOptions } from "../../types/embedding";
import { hashText } from "./utils/hash";

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  maxTokens: 512,
  overlap: 50,
  separators: ["\n\n", "\n", ". ", "。", " "],
};

/**
 * Estimate token count for text
 * Uses a simple heuristic: ~4 characters per token for English
 * For Chinese/Japanese, ~1.5 characters per token
 */
function estimateTokens(text: string): number {
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const otherCount = text.length - cjkCount;

  // CJK: ~1.5 chars/token, Other: ~4 chars/token
  return Math.ceil(cjkCount / 1.5 + otherCount / 4);
}

/**
 * Split text by separator, keeping the separator at the end of each chunk
 */
function splitBySeparator(text: string, separator: string): string[] {
  if (separator === " ") {
    // Special handling for space: split by words
    return text.split(/(\s+)/).filter(Boolean);
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const index = remaining.indexOf(separator);
    if (index === -1) {
      parts.push(remaining);
      break;
    }
    parts.push(remaining.slice(0, index + separator.length));
    remaining = remaining.slice(index + separator.length);
  }

  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Split text into chunks with overlap
 */
export function splitText(
  text: string,
  options: ChunkOptions = {},
): TextChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const chunks: TextChunk[] = [];

  // Clean and normalize text
  const cleanedText = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleanedText) {
    return [];
  }

  // Try splitting with each separator in order
  let parts: string[] = [cleanedText];

  for (const separator of opts.separators) {
    const newParts: string[] = [];
    for (const part of parts) {
      if (estimateTokens(part) > opts.maxTokens) {
        newParts.push(...splitBySeparator(part, separator));
      } else {
        newParts.push(part);
      }
    }
    parts = newParts;
  }

  // Merge small parts and split large ones
  let currentChunk = "";
  let chunkIndex = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const combined = currentChunk + part;
    const combinedTokens = estimateTokens(combined);

    if (combinedTokens <= opts.maxTokens) {
      // Add to current chunk
      currentChunk = combined;
    } else if (estimateTokens(currentChunk) > 0) {
      // Save current chunk and start new one
      chunks.push({
        index: chunkIndex++,
        text: currentChunk.trim(),
        hash: hashText(currentChunk.trim()),
      });

      // Start new chunk with overlap
      if (opts.overlap > 0 && currentChunk.length > 0) {
        // Take last N tokens worth of text for overlap
        const overlapChars = opts.overlap * 4; // Approximate
        const overlapText = currentChunk.slice(-overlapChars);
        currentChunk = overlapText + part;
      } else {
        currentChunk = part;
      }

      // If still too large, force split (with max iterations to prevent infinite loop)
      let forceSplitIterations = 0;
      const maxForceSplitIterations = 1000;
      while (estimateTokens(currentChunk) > opts.maxTokens && forceSplitIterations < maxForceSplitIterations) {
        forceSplitIterations++;
        const targetChars = opts.maxTokens * 4;
        const chunkText = currentChunk.slice(0, targetChars).trim();
        chunks.push({
          index: chunkIndex++,
          text: chunkText,
          hash: hashText(chunkText),
        });

        // Overlap for forced split - ensure we always make progress
        const overlapStart = Math.max(0, targetChars - opts.overlap * 4);
        const newChunk = currentChunk.slice(overlapStart);
        // Ensure we're making progress
        if (newChunk.length >= currentChunk.length) {
          currentChunk = currentChunk.slice(targetChars);
        } else {
          currentChunk = newChunk;
        }
      }
    } else {
      // Current chunk is empty, start with this part
      currentChunk = part;

      // Force split if too large (with max iterations to prevent infinite loop)
      let forceSplitIterations = 0;
      const maxForceSplitIterations = 1000;
      while (estimateTokens(currentChunk) > opts.maxTokens && forceSplitIterations < maxForceSplitIterations) {
        forceSplitIterations++;
        const targetChars = opts.maxTokens * 4;
        const chunkText = currentChunk.slice(0, targetChars).trim();
        chunks.push({
          index: chunkIndex++,
          text: chunkText,
          hash: hashText(chunkText),
        });

        const overlapStart = Math.max(0, targetChars - opts.overlap * 4);
        const newChunk = currentChunk.slice(overlapStart);
        // Ensure we're making progress
        if (newChunk.length >= currentChunk.length) {
          currentChunk = currentChunk.slice(targetChars);
        } else {
          currentChunk = newChunk;
        }
      }
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      index: chunkIndex,
      text: currentChunk.trim(),
      hash: hashText(currentChunk.trim()),
    });
  }

  return chunks;
}

/**
 * Split text with page information
 * Expects text format: "Page X\n content..."
 */
export function splitTextWithPages(
  text: string,
  options: ChunkOptions = {},
): TextChunk[] {
  // Try to detect page markers
  const pagePattern = /(?:^|\n)(?:Page|页|P\.?)\s*(\d+)\s*\n/gi;
  const pageMatches = [...text.matchAll(pagePattern)];

  if (pageMatches.length === 0) {
    // No page markers, split normally
    return splitText(text, options);
  }

  const chunks: TextChunk[] = [];
  let chunkIndex = 0;

  // Split by page first
  for (let i = 0; i < pageMatches.length; i++) {
    const match = pageMatches[i];
    const pageNum = parseInt(match[1], 10);
    const startIndex = match.index! + match[0].length;
    const endIndex =
      i < pageMatches.length - 1 ? pageMatches[i + 1].index! : text.length;

    const pageText = text.slice(startIndex, endIndex).trim();
    if (!pageText) continue;

    // Split this page's content
    const pageChunks = splitText(pageText, options);

    // Add page number to each chunk
    for (const chunk of pageChunks) {
      chunks.push({
        ...chunk,
        index: chunkIndex++,
        page: pageNum,
      });
    }
  }

  return chunks;
}

/**
 * ChunkSplitter class for stateful chunking
 */
export class ChunkSplitter {
  private options: Required<ChunkOptions>;

  constructor(options: ChunkOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  split(text: string): TextChunk[] {
    return splitText(text, this.options);
  }

  splitWithPages(text: string): TextChunk[] {
    return splitTextWithPages(text, this.options);
  }

  /**
   * Estimate total chunks for text without actually splitting
   */
  estimateChunkCount(text: string): number {
    const totalTokens = estimateTokens(text);
    // Ensure effectiveChunkSize is at least 1 to avoid division by zero
    const effectiveChunkSize = Math.max(1, this.options.maxTokens - this.options.overlap);
    return Math.ceil(totalTokens / effectiveChunkSize);
  }
}
