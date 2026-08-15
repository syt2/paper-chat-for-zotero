import { assert } from "chai";
import {
  createDefaultDownloadRuntime,
  executeDownloadCapability,
  fileNameFromContentDisposition,
  MAX_DOWNLOAD_BYTES,
  sanitizeDownloadFileName,
  type DownloadCapabilityRuntime,
  type DownloadResponseMetadata,
  type ImportedDownloadAttachment,
  type ZoteroDownloadTarget,
} from "../src/modules/download";

interface FakeRuntimeOptions {
  response?: DownloadResponseMetadata;
  downloadError?: Error;
  downloadsMoveError?: Error;
  importError?: Error;
  size?: number;
  existingPaths?: string[];
  collideOnceAt?: string;
  parent?: ZoteroDownloadTarget | null;
  collection?: ZoteroDownloadTarget | null;
  attachment?: ImportedDownloadAttachment;
}

function createFakeRuntime(options: FakeRuntimeOptions = {}) {
  const files = new Map<string, number>();
  for (const path of options.existingPaths || []) {
    files.set(path, 1);
  }
  const calls = {
    downloads: [] as Array<{ url: string; path: string; maxBytes: number }>,
    imports: [] as Array<{
      filePath: string;
      sourceUrl: string;
      title?: string;
      libraryID: number;
      parentItemID?: number;
      collectionIDs?: number[];
    }>,
    moves: [] as Array<{ sourcePath: string; destinationPath: string }>,
    removed: [] as Array<{ path: string; recursive?: boolean }>,
    parentKeys: [] as string[],
    collectionKeys: [] as string[],
    temporaryDirectories: 0,
    userLibraryLookups: 0,
  };
  let collisionInjected = false;

  const runtime: DownloadCapabilityRuntime = {
    createTemporaryDirectory: async () => {
      calls.temporaryDirectories += 1;
      return "/tmp/paperchat-download-1";
    },
    ensureDirectory: async () => undefined,
    downloadToFile: async (url, path, maxBytes) => {
      calls.downloads.push({ url, path, maxBytes });
      if (options.downloadError) {
        throw options.downloadError;
      }
      files.set(path, options.size ?? 4_096);
      return options.response || {};
    },
    getDownloadsDirectory: () => "/downloads",
    getUserLibraryID: () => {
      calls.userLibraryLookups += 1;
      return 1;
    },
    resolveParentItem: (key) => {
      calls.parentKeys.push(key);
      return options.parent === undefined ? null : options.parent;
    },
    resolveCollection: (key) => {
      calls.collectionKeys.push(key);
      return options.collection === undefined ? null : options.collection;
    },
    importIntoZotero: async (importOptions) => {
      calls.imports.push(importOptions);
      if (options.importError) throw options.importError;
      return (
        options.attachment || {
          attachmentKey: "ATCH0001",
          fileName: "download.pdf",
          contentType: "application/pdf",
        }
      );
    },
    fileExists: async (path) => files.has(path),
    getFileSize: async (path) => {
      const size = files.get(path);
      if (size === undefined) throw new Error(`Missing fake file: ${path}`);
      return size;
    },
    moveFile: async (sourcePath, destinationPath) => {
      if (
        options.downloadsMoveError &&
        destinationPath.startsWith("/downloads/")
      ) {
        throw options.downloadsMoveError;
      }
      if (!collisionInjected && options.collideOnceAt === destinationPath) {
        collisionInjected = true;
        files.set(destinationPath, 1);
        throw new Error(`Destination already exists: ${destinationPath}`);
      }
      if (files.has(destinationPath)) {
        throw new Error(`Destination already exists: ${destinationPath}`);
      }
      const size = files.get(sourcePath);
      if (size === undefined) {
        throw new Error(`Missing fake source: ${sourcePath}`);
      }
      files.delete(sourcePath);
      files.set(destinationPath, size);
      calls.moves.push({ sourcePath, destinationPath });
    },
    removePath: async (path, recursive) => {
      calls.removed.push({ path, recursive });
      for (const filePath of [...files.keys()]) {
        if (filePath === path || filePath.startsWith(`${path}/`)) {
          files.delete(filePath);
        }
      }
    },
  };

  return { runtime, files, calls };
}

describe("download capability", function () {
  let originalPathUtils: unknown;
  let originalIOUtils: unknown;
  let originalServices: unknown;
  let originalCc: unknown;
  let originalCi: unknown;
  let originalZotero: unknown;
  let originalZtoolkit: unknown;
  let originalFetch: unknown;

  beforeEach(function () {
    originalPathUtils = (globalThis as any).PathUtils;
    originalIOUtils = (globalThis as any).IOUtils;
    originalServices = (globalThis as any).Services;
    originalCc = (globalThis as any).Cc;
    originalCi = (globalThis as any).Ci;
    originalZotero = (globalThis as any).Zotero;
    originalZtoolkit = (globalThis as any).ztoolkit;
    originalFetch = (globalThis as any).fetch;
    (globalThis as any).PathUtils = {
      join: (...parts: string[]) =>
        parts
          .map((part, index) =>
            index === 0 ? part.replace(/\/$/, "") : part.replace(/^\//, ""),
          )
          .join("/"),
      filename: (path: string) => path.split("/").pop() || "",
    };
  });

  afterEach(function () {
    (globalThis as any).PathUtils = originalPathUtils;
    (globalThis as any).IOUtils = originalIOUtils;
    (globalThis as any).Services = originalServices;
    (globalThis as any).Cc = originalCc;
    (globalThis as any).Ci = originalCi;
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalZtoolkit;
    (globalThis as any).fetch = originalFetch;
  });

  it("uses the server filename and avoids overwriting an existing download", async function () {
    const { runtime, files, calls } = createFakeRuntime({
      response: {
        finalUrl: "https://cdn.example.test/final",
        contentType: "application/pdf",
        contentDisposition: "attachment; filename*=UTF-8''paper%20notes.pdf",
      },
      existingPaths: ["/downloads/paper notes.pdf"],
    });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/fallback.bin",
        destination: "downloads",
      },
      runtime,
    );

    assert.include(result, "File downloaded successfully.");
    assert.include(result, "File path: /downloads/paper notes (1).pdf");
    assert.include(result, "Content type: application/pdf");
    assert.isTrue(files.has("/downloads/paper notes.pdf"));
    assert.isTrue(files.has("/downloads/paper notes (1).pdf"));
    assert.deepEqual(calls.downloads, [
      {
        url: "https://example.test/fallback.bin",
        path: "/tmp/paperchat-download-1/fallback.bin",
        maxBytes: MAX_DOWNLOAD_BYTES,
      },
    ]);
    assert.deepEqual(calls.removed, [
      { path: "/tmp/paperchat-download-1", recursive: true },
    ]);
    assert.equal(calls.userLibraryLookups, 0);
  });

  it("sanitizes a model-provided filename before saving it", async function () {
    const { runtime, files } = createFakeRuntime();

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/report.pdf",
        destination: "downloads",
        filename: "../../report.pdf",
      },
      runtime,
    );

    assert.include(result, "File path: /downloads/..-..-report.pdf");
    assert.notInclude(result, "/../");
    assert.isTrue(files.has("/downloads/..-..-report.pdf"));
  });

  it("does not compatibility-normalize the download URL", async function () {
    const { runtime, calls } = createFakeRuntime();

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/①.pdf?name=Å#preview",
        destination: "downloads",
      },
      runtime,
    );

    assert.equal(
      calls.downloads[0]?.url,
      "https://example.test/%E2%91%A0.pdf?name=%E2%84%AB#preview",
    );
    assert.include(result, "Source URL: https://example.test/%E2%91%A0.pdf");
    assert.notInclude(result, "name=");
    assert.notInclude(result, "#preview");
  });

  it("supports a filesystem-only runtime for Downloads", async function () {
    const { runtime } = createFakeRuntime();
    const fileOnlyRuntime: DownloadCapabilityRuntime = {
      ...runtime,
      getUserLibraryID: undefined,
      resolveParentItem: undefined,
      resolveCollection: undefined,
      importIntoZotero: undefined,
    };

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/archive.zip",
        destination: "downloads",
      },
      fileOnlyRuntime,
    );

    assert.include(result, "File path: /downloads/archive.zip");
  });

  it("keeps collision suffixes within the filesystem filename limit", async function () {
    const requestedName = `${"论文".repeat(100)}.pdf`;
    const sanitizedName = sanitizeDownloadFileName(requestedName);
    const { runtime, files } = createFakeRuntime({
      existingPaths: [`/downloads/${sanitizedName}`],
    });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "downloads",
        filename: requestedName,
      },
      runtime,
    );

    const finalPath = result.match(/^File path: (.+)$/m)?.[1] || "";
    const finalName = finalPath.split("/").pop() || "";
    assert.match(finalName, / \(1\)\.pdf$/);
    assert.isAtMost(new TextEncoder().encode(finalName).length, 180);
    assert.isTrue(files.has(finalPath));
  });

  it("retries when another writer claims the destination during the move", async function () {
    const { runtime, files } = createFakeRuntime({
      collideOnceAt: "/downloads/paper.pdf",
    });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "downloads",
      },
      runtime,
    );

    assert.include(result, "File path: /downloads/paper (1).pdf");
    assert.isTrue(files.has("/downloads/paper.pdf"));
    assert.isTrue(files.has("/downloads/paper (1).pdf"));
  });

  it("imports a download under a Zotero parent item", async function () {
    const { runtime, calls } = createFakeRuntime({
      parent: { id: 42, key: "ITEM0001", libraryID: 1 },
      response: { contentType: "application/pdf" },
      attachment: {
        attachmentKey: "ATCH0001",
        parentItemKey: "ITEM0001",
        attachmentTitle: "Downloaded paper",
        fileName: "paper.pdf",
        contentType: "application/pdf",
      },
    });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "zotero",
        parentItemKey: "item0001",
        title: "  Downloaded\npaper  ",
      },
      runtime,
    );

    assert.include(result, "imported into Zotero successfully");
    assert.include(result, '"attachmentKey":"ATCH0001"');
    assert.include(result, "Attachment Key: ATCH0001");
    assert.include(result, "Parent Item Key: ITEM0001");
    assert.deepEqual(calls.parentKeys, ["ITEM0001"]);
    assert.deepEqual(calls.imports, [
      {
        filePath: "/tmp/paperchat-download-1/paper.pdf",
        sourceUrl: "https://example.test/paper.pdf",
        title: "Downloaded paper",
        libraryID: 1,
        parentItemID: 42,
        collectionIDs: undefined,
      },
    ]);
    assert.equal(calls.userLibraryLookups, 1);
  });

  it("imports a top-level attachment into a Zotero collection", async function () {
    const { runtime, calls } = createFakeRuntime({
      collection: { id: 9, key: "COLL0001", libraryID: 1 },
    });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/data.zip",
        destination: "zotero",
        collectionKey: "coll0001",
      },
      runtime,
    );

    assert.include(result, "Collection Key: COLL0001");
    assert.deepEqual(calls.collectionKeys, ["COLL0001"]);
    assert.deepEqual(calls.imports[0]?.collectionIDs, [9]);
    assert.isUndefined(calls.imports[0]?.parentItemID);
  });

  it("rejects unsafe or contradictory destinations before downloading", async function () {
    const invalidProtocol = createFakeRuntime();
    const embeddedCredentials = createFakeRuntime();
    const malformedZoteroKey = createFakeRuntime();
    const conflictingTargets = createFakeRuntime();
    const downloadsWithParent = createFakeRuntime();
    const localNetwork = createFakeRuntime();
    const benchmarkLiteral = createFakeRuntime();
    const proxyIpv6Literal = createFakeRuntime();
    const ipv4CompatibleLoopback = createFakeRuntime();
    const siteLocalIpv6 = createFakeRuntime();

    const invalidProtocolResult = await executeDownloadCapability(
      { url: "file:///tmp/paper.pdf", destination: "downloads" },
      invalidProtocol.runtime,
    );
    const embeddedCredentialsResult = await executeDownloadCapability(
      {
        url: "https://user:password@example.test/paper.pdf",
        destination: "downloads",
      },
      embeddedCredentials.runtime,
    );
    const malformedZoteroKeyResult = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "zotero",
        parentItemKey: "not-a-key",
      },
      malformedZoteroKey.runtime,
    );
    const conflictingTargetsResult = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "zotero",
        parentItemKey: "ITEM0001",
        collectionKey: "COLL0001",
      },
      conflictingTargets.runtime,
    );
    const downloadsWithParentResult = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "downloads",
        parentItemKey: "ITEM0001",
      },
      downloadsWithParent.runtime,
    );
    const localNetworkResult = await executeDownloadCapability(
      { url: "http://127.0.0.1/private.pdf", destination: "downloads" },
      localNetwork.runtime,
    );
    const benchmarkLiteralResult = await executeDownloadCapability(
      {
        url: "https://198.18.0.104/private.pdf",
        destination: "downloads",
      },
      benchmarkLiteral.runtime,
    );
    const proxyIpv6LiteralResult = await executeDownloadCapability(
      {
        url: "https://[fdfe:dcba:9876::64]/private.pdf",
        destination: "downloads",
      },
      proxyIpv6Literal.runtime,
    );
    const ipv4CompatibleLoopbackResult = await executeDownloadCapability(
      { url: "http://[::7f00:1]/private.pdf", destination: "downloads" },
      ipv4CompatibleLoopback.runtime,
    );
    const siteLocalIpv6Result = await executeDownloadCapability(
      { url: "http://[fec0::1]/private.pdf", destination: "downloads" },
      siteLocalIpv6.runtime,
    );

    for (const result of [
      invalidProtocolResult,
      embeddedCredentialsResult,
      malformedZoteroKeyResult,
      conflictingTargetsResult,
      downloadsWithParentResult,
      localNetworkResult,
      benchmarkLiteralResult,
      proxyIpv6LiteralResult,
      ipv4CompatibleLoopbackResult,
      siteLocalIpv6Result,
    ]) {
      assert.include(result, "Category: invalid_arguments");
    }
    assert.equal(invalidProtocol.calls.temporaryDirectories, 0);
    assert.equal(embeddedCredentials.calls.temporaryDirectories, 0);
    assert.equal(malformedZoteroKey.calls.temporaryDirectories, 0);
    assert.equal(conflictingTargets.calls.temporaryDirectories, 0);
    assert.equal(downloadsWithParent.calls.temporaryDirectories, 0);
    assert.equal(localNetwork.calls.temporaryDirectories, 0);
    assert.equal(benchmarkLiteral.calls.temporaryDirectories, 0);
    assert.equal(proxyIpv6Literal.calls.temporaryDirectories, 0);
    assert.equal(ipv4CompatibleLoopback.calls.temporaryDirectories, 0);
    assert.equal(siteLocalIpv6.calls.temporaryDirectories, 0);
  });

  it("rejects a redirect to a private network before saving the file", async function () {
    const { runtime, files, calls } = createFakeRuntime({
      response: { finalUrl: "http://[::1]/private.pdf" },
    });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/redirect",
        destination: "downloads",
      },
      runtime,
    );

    assert.include(result, "Local or private network URLs are not accepted");
    assert.isFalse(files.has("/downloads/private.pdf"));
    assert.deepEqual(calls.removed, [
      { path: "/tmp/paperchat-download-1", recursive: true },
    ]);
  });

  it("returns not-found without downloading when the Zotero target is missing", async function () {
    const { runtime, calls } = createFakeRuntime({ parent: null });

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "zotero",
        parentItemKey: "ITEM0001",
      },
      runtime,
    );

    assert.include(result, "Category: not_found");
    assert.include(result, "download destination was not found");
    assert.notInclude(result, "Invalid download request");
    assert.equal(calls.temporaryDirectories, 0);
    assert.deepEqual(calls.downloads, []);
  });

  it("enforces the size limit and cleans temporary files after failures", async function () {
    const oversized = createFakeRuntime({ size: MAX_DOWNLOAD_BYTES + 1 });
    const failed = createFakeRuntime({
      downloadError: new Error("network unavailable"),
    });

    const oversizedResult = await executeDownloadCapability(
      {
        url: "https://example.test/large.bin",
        destination: "downloads",
      },
      oversized.runtime,
    );
    const failedResult = await executeDownloadCapability(
      {
        url: "https://example.test/failure.bin",
        destination: "downloads",
      },
      failed.runtime,
    );

    assert.include(oversizedResult, "too large");
    assert.include(failedResult, "network unavailable");
    assert.deepEqual(oversized.calls.removed, [
      { path: "/tmp/paperchat-download-1", recursive: true },
    ]);
    assert.deepEqual(failed.calls.removed, [
      { path: "/tmp/paperchat-download-1", recursive: true },
    ]);
  });

  it("accepts empty files and files exactly at the size limit", async function () {
    for (const size of [0, MAX_DOWNLOAD_BYTES]) {
      const { runtime } = createFakeRuntime({ size });
      const result = await executeDownloadCapability(
        {
          url: `https://example.test/${size}.bin`,
          destination: "downloads",
        },
        runtime,
      );

      assert.include(result, "File downloaded successfully.");
      assert.include(result, `(${size} bytes)`);
    }
  });

  it("distinguishes destination and Zotero import failures from network failures", async function () {
    const downloadsFailure = createFakeRuntime({
      downloadsMoveError: new Error("Downloads is read-only"),
    });
    const zoteroFailure = createFakeRuntime({
      importError: new Error("Zotero storage is unavailable"),
    });

    const downloadsResult = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "downloads",
      },
      downloadsFailure.runtime,
    );
    const zoteroResult = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "zotero",
      },
      zoteroFailure.runtime,
    );

    assert.include(downloadsResult, "could not be saved to Downloads");
    assert.include(downloadsResult, "retry the same URL");
    assert.include(zoteroResult, "could not be imported into Zotero");
    assert.include(zoteroResult, "retry the same URL");
  });

  it("does not save a file after the session aborts", async function () {
    const controller = new AbortController();
    const { runtime, files, calls } = createFakeRuntime();
    runtime.downloadToFile = async (_url, path, _maxBytes, abortSignal) => {
      assert.equal(abortSignal, controller.signal);
      files.set(path, 4_096);
      controller.abort();
      return {};
    };

    const result = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "downloads",
      },
      runtime,
      controller.signal,
    );

    assert.include(result, "The download was cancelled");
    assert.deepEqual(calls.moves, []);
    assert.isFalse(files.has("/downloads/paper.pdf"));
    assert.deepEqual(calls.removed, [
      { path: "/tmp/paperchat-download-1", recursive: true },
    ]);
  });

  it("rejects empty required values and falls back from an empty filename", async function () {
    const emptyUrl = createFakeRuntime();
    const emptyDestination = createFakeRuntime();
    const filenameFallback = createFakeRuntime();

    const emptyUrlResult = await executeDownloadCapability(
      { url: "  ", destination: "downloads" },
      emptyUrl.runtime,
    );
    const emptyDestinationResult = await executeDownloadCapability(
      { url: "https://example.test/paper.pdf", destination: "" },
      emptyDestination.runtime,
    );
    const filenameFallbackResult = await executeDownloadCapability(
      {
        url: "https://example.test/paper.pdf",
        destination: "downloads",
        filename: "  ",
      },
      filenameFallback.runtime,
    );

    assert.include(emptyUrlResult, "Category: invalid_arguments");
    assert.include(emptyDestinationResult, "Category: invalid_arguments");
    assert.equal(emptyUrl.calls.temporaryDirectories, 0);
    assert.equal(emptyDestination.calls.temporaryDirectories, 0);
    assert.include(filenameFallbackResult, "File path: /downloads/paper.pdf");
  });

  it("streams anonymous manual redirects without a plugin-global AbortController", async function () {
    const writes: Array<{ path: string; bytes: number; append: boolean }> = [];
    const removedPaths: string[] = [];
    const setDnsAddresses = (addresses: string[], trrMode = 0) => {
      (globalThis as any).Services = {
        dns: {
          currentTrrMode: trrMode,
          asyncResolve: (
            _hostname: string,
            _type: number,
            _flags: number,
            _additionalInfo: null,
            listener: {
              onLookupComplete(
                request: unknown,
                record: unknown,
                status: number,
              ): void;
            },
          ) => {
            let index = 0;
            const record = {
              hasMore: () => index < addresses.length,
              getNextAddrAsString: () => addresses[index++],
            };
            listener.onLookupComplete({}, record, 0);
            return { cancel: () => undefined };
          },
        },
        io: {
          newURI: (url: string) => ({ spec: url }),
        },
        tm: { currentThread: {} },
      };
    };
    setDnsAddresses(["93.184.216.34"]);
    const pinEvents: string[] = [];
    const activePins = new Map<string, string[]>();
    let configuredProxy: { type: string } | null = null;
    const dnsOverride = {
      addIPOverride: (hostname: string, address: string) => {
        pinEvents.push(`add:${hostname}:${address}`);
        activePins.set(hostname, [
          ...(activePins.get(hostname) || []),
          address,
        ]);
      },
      clearHostOverride: (hostname: string) => {
        pinEvents.push(`clear:${hostname}`);
        activePins.delete(hostname);
      },
    };
    (globalThis as any).Cc = {
      "@mozilla.org/network/native-dns-override;1": {
        getService: () => dnsOverride,
      },
      "@mozilla.org/network/protocol-proxy-service;1": {
        getService: () => ({
          asyncResolve: (
            _uri: unknown,
            _flags: number,
            callback: {
              onProxyAvailable(
                request: unknown,
                channel: unknown,
                proxyInfo: { type: string } | null,
                status: number,
              ): void;
            },
          ) => {
            callback.onProxyAvailable({}, {}, configuredProxy, 0);
            return { cancel: () => undefined };
          },
        }),
      },
    };
    (globalThis as any).Ci = {
      nsIDNSAddrRecord: {},
      nsINativeDNSResolverOverride: {},
      nsIProtocolProxyService: {},
    };
    (globalThis as any).IOUtils = {
      write: async (
        path: string,
        bytes: Uint8Array,
        options?: { mode?: string },
      ) => {
        writes.push({
          path,
          bytes: bytes.byteLength,
          append: options?.mode === "append",
        });
      },
      remove: async (path: string) => {
        removedPaths.push(path);
      },
    };

    const createResponse = (options: {
      status: number;
      headers?: Record<string, string>;
      chunks?: number[][];
      onCancel?: () => void;
      closeAfterChunks?: boolean;
    }): Response => {
      const chunks = options.chunks || [];
      let index = 0;
      const body = chunks.length
        ? new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks[index++];
              if (!chunk) {
                if (options.closeAfterChunks !== false) controller.close();
                return;
              }
              controller.enqueue(Uint8Array.from(chunk));
            },
            cancel: options.onCancel,
          })
        : null;
      return {
        status: options.status,
        url: "",
        headers: new Headers(options.headers),
        body,
      } as unknown as Response;
    };

    const requestUrls: string[] = [];
    const requestOptions: RequestInit[] = [];
    (globalThis as any).fetch = async (url: string, options: RequestInit) => {
      assert.deepEqual(activePins.get(new URL(url).hostname), [
        "93.184.216.34",
      ]);
      requestUrls.push(url);
      requestOptions.push(options);
      if (requestUrls.length === 1) {
        return createResponse({
          status: 302,
          headers: { Location: "https://cdn.example.test/paper.pdf" },
        });
      }
      return createResponse({
        status: 200,
        headers: {
          "Content-Type": "application/pdf; charset=binary",
          "Content-Disposition": 'attachment; filename="paper.pdf"',
        },
        chunks: [
          [1, 2],
          [3, 4],
        ],
      });
    };
    const NativeAbortController = globalThis.AbortController;
    const NativeZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      getMainWindow: () => ({ AbortController: NativeAbortController }),
    };
    const runtime = createDefaultDownloadRuntime();
    const metadata = await (async () => {
      delete (globalThis as any).AbortController;
      try {
        return await runtime.downloadToFile(
          "https://example.test/paper.pdf",
          "/tmp/paper.pdf",
          MAX_DOWNLOAD_BYTES,
        );
      } finally {
        (globalThis as any).AbortController = NativeAbortController;
        if (NativeZotero === undefined) delete (globalThis as any).Zotero;
        else (globalThis as any).Zotero = NativeZotero;
      }
    })();

    assert.deepEqual(requestUrls, [
      "https://example.test/paper.pdf",
      "https://cdn.example.test/paper.pdf",
    ]);
    assert.deepEqual(metadata, {
      finalUrl: "https://cdn.example.test/paper.pdf",
      contentType: "application/pdf",
      contentDisposition: 'attachment; filename="paper.pdf"',
    });
    for (const options of requestOptions) {
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.equal(options.cache, "no-store");
      assert.instanceOf(options.signal, AbortSignal);
    }
    assert.deepEqual(writes, [
      { path: "/tmp/paper.pdf", bytes: 0, append: false },
      { path: "/tmp/paper.pdf", bytes: 2, append: true },
      { path: "/tmp/paper.pdf", bytes: 2, append: true },
    ]);
    assert.deepEqual(pinEvents.slice(0, 4), [
      "add:example.test:93.184.216.34",
      "clear:example.test",
      "add:cdn.example.test:93.184.216.34",
      "clear:cdn.example.test",
    ]);
    assert.equal(activePins.size, 0);

    setDnsAddresses(["198.18.0.104"]);
    let fakeIpFetchCount = 0;
    (globalThis as any).fetch = async (url: string) => {
      assert.deepEqual(activePins.get(new URL(url).hostname), ["198.18.0.104"]);
      fakeIpFetchCount += 1;
      return createResponse({ status: 200, chunks: [[5]] });
    };
    await runtime.downloadToFile(
      "https://public.example.test/fake-ip.pdf",
      "/tmp/fake-ip.pdf",
      MAX_DOWNLOAD_BYTES,
    );
    let insecureFakeIpError: unknown;
    try {
      await runtime.downloadToFile(
        "http://public.example.test/fake-ip.pdf",
        "/tmp/insecure-fake-ip.pdf",
        MAX_DOWNLOAD_BYTES,
      );
    } catch (error) {
      insecureFakeIpError = error;
    }
    assert.include(
      String((insecureFakeIpError as Error)?.message || ""),
      "resolves to a local or private address",
    );
    assert.equal(fakeIpFetchCount, 1);

    setDnsAddresses(["fdfe:dcba:9876::64"]);
    let fakeIpv6FetchCount = 0;
    (globalThis as any).fetch = async (url: string) => {
      assert.deepEqual(activePins.get(new URL(url).hostname), [
        "fdfe:dcba:9876::64",
      ]);
      fakeIpv6FetchCount += 1;
      return createResponse({ status: 200, chunks: [[6]] });
    };
    await runtime.downloadToFile(
      "https://public.example.test/fake-ipv6.pdf",
      "/tmp/fake-ipv6.pdf",
      MAX_DOWNLOAD_BYTES,
    );
    let insecureFakeIpv6Error: unknown;
    try {
      await runtime.downloadToFile(
        "http://public.example.test/fake-ipv6.pdf",
        "/tmp/insecure-fake-ipv6.pdf",
        MAX_DOWNLOAD_BYTES,
      );
    } catch (error) {
      insecureFakeIpv6Error = error;
    }
    assert.include(
      String((insecureFakeIpv6Error as Error)?.message || ""),
      "resolves to a local or private address",
    );
    assert.equal(fakeIpv6FetchCount, 1);

    let streamCancelCount = 0;
    setDnsAddresses(["93.184.216.34"]);
    (globalThis as any).fetch = async () =>
      createResponse({
        status: 200,
        chunks: [
          [1, 2],
          [3, 4],
        ],
        closeAfterChunks: false,
        onCancel: () => {
          streamCancelCount += 1;
        },
      });
    let sizeError: unknown;
    try {
      await runtime.downloadToFile(
        "https://example.test/large.bin",
        "/tmp/large.bin",
        3,
      );
    } catch (error) {
      sizeError = error;
    }
    assert.include(String((sizeError as Error)?.message || ""), "exceeds");
    assert.equal(streamCancelCount, 1);
    assert.include(removedPaths, "/tmp/large.bin");

    let requestCount = 0;
    (globalThis as any).fetch = async () => {
      requestCount += 1;
      return createResponse({
        status: 302,
        headers: { Location: "http://127.0.0.1/private.pdf" },
      });
    };
    let redirectError: unknown;
    try {
      await runtime.downloadToFile(
        "https://example.test/redirect",
        "/tmp/redirect",
        MAX_DOWNLOAD_BYTES,
      );
    } catch (error) {
      redirectError = error;
    }
    assert.include(
      String((redirectError as Error)?.message || ""),
      "Local or private network URLs are not accepted",
    );
    assert.equal(requestCount, 1);

    setDnsAddresses(["127.0.0.1"]);
    requestCount = 0;
    (globalThis as any).fetch = async () => {
      requestCount += 1;
      throw new Error("must not connect");
    };
    let dnsError: unknown;
    try {
      await runtime.downloadToFile(
        "https://public-name.example/file",
        "/tmp/dns-private",
        MAX_DOWNLOAD_BYTES,
      );
    } catch (error) {
      dnsError = error;
    }
    assert.include(
      String((dnsError as Error)?.message || ""),
      "resolves to a local or private address",
    );
    assert.equal(requestCount, 0);

    setDnsAddresses(["93.184.216.34"]);
    configuredProxy = { type: "http" };
    let proxyError: unknown;
    try {
      await runtime.downloadToFile(
        "http://example.test/proxied",
        "/tmp/proxied-http",
        MAX_DOWNLOAD_BYTES,
      );
    } catch (error) {
      proxyError = error;
    }
    assert.include(
      String((proxyError as Error)?.message || ""),
      "through a configured proxy",
    );
    assert.equal(requestCount, 0);
    configuredProxy = null;

    setDnsAddresses(["93.184.216.34"], 3);
    let trrError: unknown;
    try {
      await runtime.downloadToFile(
        "https://example.test/forced-doh",
        "/tmp/forced-doh",
        MAX_DOWNLOAD_BYTES,
      );
    } catch (error) {
      trrError = error;
    }
    assert.include(
      String((trrError as Error)?.message || ""),
      "DNS-over-HTTPS",
    );
    assert.equal(requestCount, 0);

    setDnsAddresses(["93.184.216.34"]);
    let releaseFirstFetch!: (response: Response) => void;
    let queuedFetchCount = 0;
    (globalThis as any).fetch = async () => {
      queuedFetchCount += 1;
      if (queuedFetchCount === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirstFetch = resolve;
        });
      }
      return createResponse({ status: 200, chunks: [[9]] });
    };
    const firstDownload = runtime.downloadToFile(
      "https://example.test/first",
      "/tmp/first",
      MAX_DOWNLOAD_BYTES,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedAbortController = new AbortController();
    const queuedDownload = runtime
      .downloadToFile(
        "https://cdn.example.test/queued",
        "/tmp/queued",
        MAX_DOWNLOAD_BYTES,
        queuedAbortController.signal,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    await new Promise((resolve) => setTimeout(resolve, 0));
    queuedAbortController.abort();
    let queuedOutcome: unknown;
    try {
      queuedOutcome = await Promise.race([
        queuedDownload,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
    } finally {
      releaseFirstFetch(createResponse({ status: 200, chunks: [[8]] }));
      await firstDownload;
      if (queuedOutcome === "timeout") await queuedDownload;
    }
    assert.notEqual(queuedOutcome, "timeout");
    assert.include(
      String((queuedOutcome as Error)?.message || ""),
      "download was cancelled",
    );
    assert.equal(queuedFetchCount, 1);

    const abortController = new AbortController();
    let nativeSignal: AbortSignal | undefined;
    (globalThis as any).fetch = async (_url: string, options: RequestInit) => {
      nativeSignal = options.signal as AbortSignal;
      abortController.abort();
      throw new Error("native request cancelled");
    };

    let abortError: unknown;
    try {
      await runtime.downloadToFile(
        "https://example.test/cancel",
        "/tmp/cancel",
        MAX_DOWNLOAD_BYTES,
        abortController.signal,
      );
    } catch (error) {
      abortError = error;
    }
    assert.include(
      String((abortError as Error)?.message || ""),
      "download was cancelled",
    );
    assert.equal(nativeSignal?.aborted, true);
  });

  it("uses Zotero's native import and best-effort PDF recognition", async function () {
    const importedOptions: Record<string, unknown>[] = [];
    const savedFields = new Map<string, unknown>();
    let recognized = false;
    const attachment = {
      key: "ATCH0001",
      parentItemID: 0,
      attachmentFilename: "paper.pdf",
      attachmentContentType: "application/pdf",
      setField: (field: string, value: unknown) =>
        savedFields.set(field, value),
      saveTx: async () => undefined,
      isPDFAttachment: () => true,
      isEPUBAttachment: () => false,
      getField: (field: string) =>
        field === "title" ? "Recognized paper" : "",
    };
    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      Attachments: {
        importFromFile: async (options: Record<string, unknown>) => {
          importedOptions.push(options);
          return attachment;
        },
      },
      Items: {
        get: (id: number) => (id === 99 ? { key: "ITEM0001" } : null),
      },
      RecognizeDocument: {
        autoRecognizeItems: async () => {
          recognized = true;
          attachment.parentItemID = 99;
        },
      },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
    const runtime = createDefaultDownloadRuntime();

    const result = await runtime.importIntoZotero({
      filePath: "/tmp/paper.pdf",
      sourceUrl: "https://example.test/paper.pdf",
      title: "Paper",
      libraryID: 1,
      collectionIDs: [9],
    });

    assert.deepEqual(importedOptions, [
      {
        file: "/tmp/paper.pdf",
        libraryID: 1,
        parentItemID: undefined,
        collections: [9],
        title: "Paper",
      },
    ]);
    assert.equal(savedFields.get("url"), "https://example.test/paper.pdf");
    assert.equal(recognized, true);
    assert.deepEqual(result, {
      attachmentKey: "ATCH0001",
      attachmentTitle: "Recognized paper",
      fileName: "paper.pdf",
      contentType: "application/pdf",
      parentItemKey: "ITEM0001",
    });
  });

  it("parses common Content-Disposition names and sanitizes reserved names", function () {
    assert.equal(
      fileNameFromContentDisposition(
        "attachment; filename*=UTF-8''research%20data.csv",
      ),
      "research data.csv",
    );
    assert.equal(
      fileNameFromContentDisposition(
        "attachment; filename*=UTF-8'zh'%E8%AE%BA%E6%96%87.pdf",
      ),
      "论文.pdf",
    );
    assert.equal(
      fileNameFromContentDisposition(
        "attachment; filename*=ISO-8859-1''caf%E9.pdf",
      ),
      "café.pdf",
    );
    assert.equal(
      fileNameFromContentDisposition(
        "attachment; filename*=UTF-8''%FF.pdf; filename=\"fallback.pdf\"",
      ),
      "fallback.pdf",
    );
    assert.equal(
      fileNameFromContentDisposition('attachment; filename="paper.pdf"'),
      "paper.pdf",
    );
    assert.equal(sanitizeDownloadFileName("CON.txt"), "_CON.txt");
    assert.equal(sanitizeDownloadFileName("a/b\\c?.pdf"), "a-b-c-.pdf");
    assert.equal(
      sanitizeDownloadFileName("invoice\u202Efdp.exe"),
      "invoicefdp.exe",
    );
    const longUnicodeName = sanitizeDownloadFileName(
      `${"论文".repeat(100)}.pdf`,
    );
    assert.isAtMost(new TextEncoder().encode(longUnicodeName).length, 180);
    assert.match(longUnicodeName, /\.pdf$/);
  });
});
