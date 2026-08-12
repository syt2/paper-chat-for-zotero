const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export interface PresentationAttachmentResult {
  status: "attached" | "not_attached";
  path: string;
  itemID?: number;
  itemKey?: string;
  parentItemID?: number;
  libraryID?: number;
  mode?: "child" | "top_level";
  warning?: string;
}

function getItemByKey(itemKey: string | undefined): Zotero.Item | null {
  if (!itemKey || typeof Zotero === "undefined") return null;

  const libraryIDs = [
    Zotero.Libraries.userLibraryID,
    ...(Zotero.Libraries.getAll?.() || []).map((library) => library.libraryID),
  ].filter((libraryID, index, values) => values.indexOf(libraryID) === index);

  for (const libraryID of libraryIDs) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    if (item) return item;
  }
  return null;
}

function resolveAttachmentTarget(sourceItemKey: string | undefined): {
  source?: Zotero.Item;
  parent?: Zotero.Item;
  libraryID: number;
  collections?: number[];
} {
  const source = getItemByKey(sourceItemKey) || undefined;
  const parent =
    source &&
    (source.isAttachment?.() || source.isNote?.()) &&
    source.parentItemID
      ? Zotero.Items.get(source.parentItemID) || undefined
      : source && !source.isAttachment?.() && !source.isNote?.()
        ? source
        : undefined;

  return {
    source,
    parent,
    libraryID:
      parent?.libraryID || source?.libraryID || Zotero.Libraries.userLibraryID,
    collections: parent ? undefined : source?.getCollections?.() || undefined,
  };
}

function attachmentTitle(
  source: Zotero.Item | undefined,
  presentationTitle: string,
): string {
  const sourceTitle = String(source?.getField?.("title") || "").trim();
  return `${sourceTitle || presentationTitle} - PaperChat PPT`;
}

/**
 * Import a completed PPTX into Zotero. Attachment creation is deliberately
 * best-effort: a valid deck on disk remains a successful export even when the
 * target library is read-only or Zotero cannot create the attachment.
 */
export async function attachPresentationToZotero(options: {
  outputPath: string;
  presentationTitle: string;
  sourceItemKey?: string;
}): Promise<PresentationAttachmentResult> {
  if (typeof Zotero === "undefined" || !Zotero.Attachments?.importFromFile) {
    return {
      status: "not_attached",
      path: options.outputPath,
    };
  }

  let imported: Zotero.Item | undefined;
  try {
    const target = resolveAttachmentTarget(options.sourceItemKey);
    imported = await Zotero.Attachments.importFromFile({
      file: options.outputPath,
      ...(target.parent
        ? { parentItemID: target.parent.id }
        : {
            libraryID: target.libraryID,
            ...(target.collections?.length
              ? { collections: target.collections }
              : {}),
          }),
      title: attachmentTitle(
        target.parent || target.source,
        options.presentationTitle,
      ),
      contentType: PPTX_CONTENT_TYPE,
    });
    const importedPath = await imported.getFilePathAsync?.();
    if (typeof importedPath !== "string" || !importedPath) {
      throw new Error(
        "Zotero created an attachment without a readable file path.",
      );
    }
    const finalPath = importedPath;

    if (finalPath !== options.outputPath) {
      try {
        if (await IOUtils.exists(options.outputPath)) {
          await IOUtils.remove(options.outputPath);
        }
      } catch (error) {
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(
            `[presentation] Could not remove the post-import staging file: ${String(error)}`,
          );
        }
      }
    }

    return {
      status: "attached",
      path: finalPath,
      itemID: imported.id,
      itemKey: imported.key,
      parentItemID: target.parent?.id,
      libraryID: imported.libraryID || target.libraryID,
      mode: target.parent ? "child" : "top_level",
    };
  } catch (error) {
    if (imported) {
      try {
        await imported.eraseTx();
      } catch (cleanupError) {
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(
            `[presentation] Could not remove an incomplete Zotero PPTX attachment: ${String(cleanupError)}`,
          );
        }
      }
    }
    return {
      status: "not_attached",
      path: options.outputPath,
      warning: `PPTX was generated, but Zotero could not create its attachment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
