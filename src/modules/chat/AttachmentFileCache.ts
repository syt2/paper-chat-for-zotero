import type { FileAttachment } from "../../types/chat";
import type { QueryableDatabase } from "./db/MessageRowStorage";

export function getAttachmentCacheDirectory(): string {
  return PathUtils.join(
    Zotero.getTempDirectory().path,
    "paperchat-attachments",
  );
}

function getCopyName(file: FileAttachment): string {
  return (
    (file.name || "attachment.txt")
      // eslint-disable-next-line no-control-regex -- Strip control characters from cached file names.
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .slice(0, 120)
      .replace(/[. ]+$/, "") || "attachment.txt"
  );
}

export function getAttachmentCopyPath(file: FileAttachment): string {
  return PathUtils.join(
    getAttachmentCacheDirectory(),
    `${Zotero.Utilities.Internal.md5(file.content)}-${getCopyName(file)}`,
  );
}

export type AttachmentFileRow = { files: string | null };

function readFiles(rows: AttachmentFileRow[]): FileAttachment[] {
  return rows.flatMap((row) => {
    if (!row.files) return [];
    const files: unknown = JSON.parse(row.files);
    if (!Array.isArray(files)) throw new Error("Invalid attachment metadata");
    if (
      !files.every(
        (file): file is FileAttachment =>
          file &&
          typeof file.name === "string" &&
          typeof file.content === "string",
      )
    )
      throw new Error("Invalid attachment metadata");
    return files;
  });
}

/** Run only after the session deletion commits. Shared copies stay available. */
export async function cleanupDeletedSessionAttachmentCopies(
  deletedRows: AttachmentFileRow[],
  db: QueryableDatabase,
): Promise<void> {
  const deletedFiles = readFiles(deletedRows);
  if (!deletedFiles.length) return;
  const candidates = new Set(deletedFiles.map(getAttachmentCopyPath));
  const candidateNames = new Set(deletedFiles.map(getCopyName));
  // Never remove an attachment's explicitly recorded original file.
  for (const file of deletedFiles) {
    if (file.sourcePath) candidates.delete(file.sourcePath);
  }
  for (const path of candidates) {
    if (!(await IOUtils.exists(path))) candidates.delete(path);
  }
  if (!candidates.size) return;

  // Keyset pagination bounds memory and avoids repeatedly scanning earlier rows.
  const pageSize = 32;
  let cursor = 0;
  while (candidates.size) {
    const remainingRows =
      (await db.queryAsync(
        "SELECT rowid AS cache_cursor, files FROM messages WHERE rowid > ? AND files IS NOT NULL ORDER BY rowid LIMIT ?",
        [cursor, pageSize],
      )) || [];
    // Invalid metadata aborts cleanup rather than risking a shared copy.
    for (const file of readFiles(remainingRows)) {
      // Most files differ by name; avoid hashing their potentially large contents.
      if (candidateNames.has(getCopyName(file))) {
        candidates.delete(getAttachmentCopyPath(file));
      }
      if (file.sourcePath) candidates.delete(file.sourcePath);
    }
    if (remainingRows.length < pageSize) break;
    const nextCursor = remainingRows[remainingRows.length - 1].cache_cursor;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
      throw new Error("Invalid attachment cleanup cursor");
    }
    cursor = nextCursor;
  }
  for (const path of candidates) {
    try {
      await IOUtils.remove(path, { ignoreAbsent: true });
    } catch (error) {
      // A file open in another application may be locked on Windows.
      ztoolkit.log("[Attachments] Could not remove cached copy:", error);
    }
  }
}
