/**
 * Hash Utilities - Content hashing for change detection
 */

/**
 * Calculate hash for text content using djb2 algorithm
 * Fast and sufficient for change detection (not cryptographic)
 *
 * @param text Text to hash
 * @returns 8-character hex hash string
 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  // Convert to unsigned 32-bit integer and then to hex
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Calculate hash for an array of texts
 *
 * @param texts Array of texts
 * @returns Combined hash string
 */
export function hashTexts(texts: string[]): string {
  const combined = texts.join("\n---\n");
  return hashText(combined);
}
