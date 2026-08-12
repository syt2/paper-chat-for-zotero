import {
  PRESENTATION_RENDERER_GLOBAL,
  type PresentationRendererBundleApi,
  type PresentationRendererApi,
} from "./contracts";

const RENDERER_SCRIPT_URL =
  "chrome://paperchat/content/scripts/paperchat-ppt-renderer.js";

type RendererWindow = Window & {
  [PRESENTATION_RENDERER_GLOBAL]?: PresentationRendererBundleApi;
};

export function getPresentationRenderer(): PresentationRendererApi {
  const target = Zotero.getMainWindow() as RendererWindow;
  // The presentation renderer is intentionally split into its own lazy bundle.
  // Zotero's development hot reload replaces that file without recreating the
  // main window, so retaining the previous global silently serves stale layout
  // code. Reload once per export and bust the chrome-resource cache. The cost is
  // small compared with PDF rendering and PPTX serialization, and production
  // builds gain the same guarantee that the on-disk bundle is authoritative.
  target[PRESENTATION_RENDERER_GLOBAL] = undefined;
  Services.scriptloader.loadSubScript(
    `${RENDERER_SCRIPT_URL}?paperchat=${Date.now()}`,
    target,
  );

  const renderer = Reflect.get(target, PRESENTATION_RENDERER_GLOBAL) as
    | PresentationRendererBundleApi
    | undefined;
  if (typeof renderer?.renderPresentation !== "function") {
    throw new Error(
      "PaperChat presentation renderer bundle loaded without its public API.",
    );
  }
  return {
    renderPresentation(spec) {
      const runtime = globalThis as unknown as {
        Components?: {
          utils?: {
            cloneInto?: (value: unknown, target: unknown) => unknown;
          };
        };
      };
      const cloneInto = runtime.Components?.utils?.cloneInto;
      const rendererSpec = cloneInto
        ? (cloneInto(spec, target) as typeof spec)
        : (JSON.parse(JSON.stringify(spec)) as typeof spec);
      return renderer.renderPresentation(rendererSpec);
    },
    renderPresentationWithPreview(spec) {
      if (typeof renderer.renderPresentationWithPreview !== "function") {
        throw new Error(
          "PaperChat presentation renderer bundle does not support visual previews.",
        );
      }
      const runtime = globalThis as unknown as {
        Components?: {
          utils?: {
            cloneInto?: (value: unknown, target: unknown) => unknown;
          };
        };
      };
      const cloneInto = runtime.Components?.utils?.cloneInto;
      const rendererSpec = cloneInto
        ? (cloneInto(spec, target) as typeof spec)
        : (JSON.parse(JSON.stringify(spec)) as typeof spec);
      return renderer.renderPresentationWithPreview(rendererSpec);
    },
  };
}

export function resetPresentationRendererForTests(): void {
  if (typeof Zotero === "undefined") {
    return;
  }
  const target = Zotero.getMainWindow() as RendererWindow;
  // loadSubScript installs the IIFE global as a non-configurable `var` on the
  // window. Assigning clears the test hook without throwing in strict mode.
  target[PRESENTATION_RENDERER_GLOBAL] = undefined;
}
