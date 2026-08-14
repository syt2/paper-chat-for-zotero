import type { TagElementProps } from "zotero-plugin-toolkit";
import { getString } from "../../utils/locale";
import { getPref, setPref } from "../../utils/prefs";
import { openZToolkitDialog } from "../../utils/dialog";
import { openPaperChatPurchaseDialog } from "../preferences/UserAuthUI";
import {
  formatPresentationBalance,
  PRESENTATION_MINIMUM_REMAINING_TOKENS,
  type PresentationBalanceSnapshot,
  type PresentationLaunchGuardDialogs,
} from "./PresentationLaunchGuard";
import {
  isPresentationPresetSlideCount,
  normalizePresentationLaunchSettings,
  parsePresentationSlideCount,
  PRESENTATION_MAXIMUM_SLIDE_COUNT,
  PRESENTATION_MINIMUM_SLIDE_COUNT,
  PRESENTATION_SLIDE_COUNTS,
  PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
  type PresentationDesignSystem,
  type PresentationLaunchSettings,
  type PresentationSlideCount,
} from "./PresentationLaunchSettings";

const STRING_BUTTON = 127;
const BUTTON_POSITION_0 = 1;
const BUTTON_POSITION_1 = 256;
export const PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION = "custom";

export interface PresentationLaunchDialogOptions {
  onSettingsFocusReady?: (focus: () => void) => void;
}

function focusPresentationSettingsDialog(dialogWindow: Window): void {
  if (dialogWindow.closed) return;
  try {
    dialogWindow.focus();
  } catch (error) {
    ztoolkit.log(
      "[PresentationLaunchDialogs] Failed to focus presentation settings:",
      error,
    );
  }
}

export function shouldShowPresentationCustomSlideCount(
  selectedValue: unknown,
): boolean {
  return selectedValue === PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION;
}

/**
 * ztoolkit adapts HTML selects to Zotero's native menu implementation and
 * reads option values from `properties.value`, not `attributes.value`.
 */
export function createPresentationDialogSelectOption(
  value: string,
  label: string,
  selected: boolean,
): TagElementProps {
  return {
    tag: "option",
    properties: { value, textContent: label, selected },
  };
}

function getPromptParent(): mozIDOMWindowProxy {
  return Zotero.getMainWindow() as unknown as mozIDOMWindowProxy;
}

function showTwoButtonDialog(options: {
  title: string;
  message: string;
  primary: string;
  secondary: string;
}): { accepted: boolean; checked: boolean } {
  const checkState = { value: false };
  const result = Services.prompt.confirmEx(
    getPromptParent(),
    options.title,
    options.message,
    (STRING_BUTTON * BUTTON_POSITION_0) | (STRING_BUTTON * BUTTON_POSITION_1),
    options.primary,
    options.secondary,
    "",
    "",
    checkState,
  );
  return { accepted: result === 0, checked: checkState.value };
}

export function getSavedPresentationLaunchSettings(): PresentationLaunchSettings {
  return normalizePresentationLaunchSettings({
    slideCount: getPref(
      "paperchatPresentationSlideCount",
    ) as PresentationLaunchSettings["slideCount"],
    designSystem: getPref(
      "paperchatPresentationDesignSystem",
    ) as PresentationDesignSystem,
  });
}

export function parsePresentationDialogSlideCount(
  selectedValue: unknown,
  customValue: unknown,
): PresentationSlideCount | null {
  if (!shouldShowPresentationCustomSlideCount(selectedValue)) {
    return parsePresentationSlideCount(selectedValue);
  }
  return parsePresentationSlideCount(customValue);
}

function clearSlideCountError(doc: Document): void {
  const error = doc.getElementById("presentation-slide-count-error");
  const input = doc.getElementById(
    "presentation-custom-slide-count",
  ) as HTMLInputElement | null;
  if (error) error.style.visibility = "hidden";
  input?.removeAttribute("aria-invalid");
}

function showSlideCountError(doc: Document): void {
  const select = doc.getElementById(
    "presentation-slide-count",
  ) as HTMLSelectElement | null;
  const error = doc.getElementById("presentation-slide-count-error");
  const input = doc.getElementById(
    "presentation-custom-slide-count",
  ) as HTMLInputElement | null;
  if (select) select.value = PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION;
  if (error) error.style.visibility = "visible";
  input?.setAttribute("aria-invalid", "true");
  input?.focus();
  input?.select();
}

function syncCustomSlideCountVisibility(select: HTMLSelectElement): void {
  const input = select.ownerDocument.getElementById(
    "presentation-custom-slide-count",
  ) as HTMLInputElement | null;
  if (!input) return;
  input.style.display = shouldShowPresentationCustomSlideCount(select.value)
    ? "block"
    : "none";
  clearSlideCountError(select.ownerDocument);
}

function updatePresentationInstructionsCount(input: HTMLTextAreaElement): void {
  const count = input.ownerDocument.getElementById(
    "presentation-user-instructions-count",
  );
  if (!count) return;
  count.textContent = getString("presentation-user-instructions-count", {
    args: {
      current: input.value.length,
      maximum: PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
    },
  });
}

async function showPresentationSettingsDialog(
  options: PresentationLaunchDialogOptions = {},
): Promise<PresentationLaunchSettings | null> {
  const mainWindow = Zotero.getMainWindow();
  if (!mainWindow) return null;

  const defaults = getSavedPresentationLaunchSettings();
  const usesCustomSlideCount = !isPresentationPresetSlideCount(
    defaults.slideCount,
  );
  let selection: PresentationLaunchSettings | null = null;
  const children: TagElementProps[] = [
    {
      tag: "style",
      properties: {
        textContent: `
          @supports selector(select:has(option:checked)) {
            #presentation-custom-slide-count {
              display: none !important;
            }
            #presentation-slide-count:has(option[value="${PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION}"]:checked)
              + #presentation-custom-slide-count {
              display: block !important;
            }
          }
        `,
      },
    },
    {
      tag: "div",
      properties: {
        textContent: getString("presentation-settings-description"),
      },
      styles: {
        lineHeight: "1.5",
        color: "color-mix(in srgb, CanvasText 76%, transparent)",
      },
    },
    {
      tag: "div",
      styles: {
        display: "grid",
        gridTemplateColumns: "132px minmax(250px, 1fr)",
        alignItems: "center",
        gap: "12px 16px",
      },
      children: [
        {
          tag: "label",
          attributes: { for: "presentation-slide-count" },
          properties: {
            textContent: getString("presentation-slide-count-label"),
          },
          styles: { fontWeight: "600" },
        },
        {
          tag: "div",
          styles: {
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            width: "100%",
          },
          children: [
            {
              tag: "div",
              styles: {
                display: "flex",
                alignItems: "center",
                gap: "8px",
              },
              children: [
                {
                  tag: "select",
                  id: "presentation-slide-count",
                  styles: {
                    flex: "1 1 auto",
                    minWidth: "0",
                    boxSizing: "border-box",
                    padding: "7px 10px",
                  },
                  // Zotero's ztoolkit menu adapter assigns select.value and
                  // then blurs the select without dispatching a change event.
                  // Listen for blur as well and never steal focus while its
                  // native popup is closing.
                  listeners: ["input", "change", "blur"].map((type) => ({
                    type,
                    listener: (event: Event) => {
                      const select = event.currentTarget as HTMLSelectElement;
                      syncCustomSlideCountVisibility(select);
                    },
                  })),
                  children: [
                    ...PRESENTATION_SLIDE_COUNTS.map((slideCount) =>
                      createPresentationDialogSelectOption(
                        String(slideCount),
                        getString(
                          `presentation-slide-count-${slideCount}` as
                            | "presentation-slide-count-6"
                            | "presentation-slide-count-10"
                            | "presentation-slide-count-15",
                        ),
                        defaults.slideCount === slideCount,
                      ),
                    ),
                    createPresentationDialogSelectOption(
                      PRESENTATION_CUSTOM_SLIDE_COUNT_OPTION,
                      getString("presentation-slide-count-custom"),
                      usesCustomSlideCount,
                    ),
                  ],
                },
                {
                  tag: "input",
                  id: "presentation-custom-slide-count",
                  attributes: {
                    type: "number",
                    min: String(PRESENTATION_MINIMUM_SLIDE_COUNT),
                    max: String(PRESENTATION_MAXIMUM_SLIDE_COUNT),
                    step: "1",
                    "aria-label": getString(
                      "presentation-slide-count-custom-label",
                    ),
                    "aria-describedby": "presentation-slide-count-error",
                  },
                  properties: {
                    value: usesCustomSlideCount
                      ? String(defaults.slideCount)
                      : "",
                    placeholder: getString(
                      "presentation-slide-count-custom-placeholder",
                    ),
                  },
                  styles: {
                    display: usesCustomSlideCount ? "block" : "none",
                    flex: "0 0 126px",
                    width: "126px",
                    boxSizing: "border-box",
                    padding: "7px 10px",
                  },
                  listeners: ["input", "change"].map((type) => ({
                    type,
                    listener: (event: Event) => {
                      const input = event.currentTarget as HTMLInputElement;
                      clearSlideCountError(input.ownerDocument);
                    },
                  })),
                },
              ],
            },
            {
              tag: "div",
              id: "presentation-slide-count-error",
              properties: {
                textContent: getString("presentation-slide-count-error"),
              },
              styles: {
                visibility: "hidden",
                minHeight: "1.35em",
                color: "#c43d32",
                fontSize: "0.92em",
                lineHeight: "1.35",
              },
            },
          ],
        },
        {
          tag: "label",
          attributes: { for: "presentation-design-system" },
          properties: {
            textContent: getString("presentation-design-system-label"),
          },
          styles: { fontWeight: "600" },
        },
        {
          tag: "select",
          id: "presentation-design-system",
          styles: {
            width: "100%",
            boxSizing: "border-box",
            padding: "7px 10px",
          },
          children: [
            {
              value: "teal-green-academic-defense",
              label: getString("presentation-style-academic"),
            },
            {
              value: "paperchat-editorial",
              label: getString("presentation-style-editorial"),
            },
            {
              value: "dark-editorial",
              label: getString("presentation-style-dark"),
            },
          ].map((option) =>
            createPresentationDialogSelectOption(
              option.value,
              option.label,
              defaults.designSystem === option.value,
            ),
          ),
        },
        {
          tag: "label",
          attributes: { for: "presentation-user-instructions" },
          properties: {
            textContent: getString("presentation-user-instructions-label"),
          },
          styles: { fontWeight: "600", alignSelf: "start", paddingTop: "7px" },
        },
        {
          tag: "div",
          styles: {
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          },
          children: [
            {
              tag: "textarea",
              id: "presentation-user-instructions",
              attributes: {
                rows: "4",
                maxlength: String(PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH),
                "aria-label": getString("presentation-user-instructions-label"),
                "aria-describedby": "presentation-user-instructions-count",
              },
              properties: {
                value: "",
                placeholder: getString(
                  "presentation-user-instructions-placeholder",
                ),
              },
              styles: {
                width: "100%",
                minHeight: "82px",
                maxHeight: "180px",
                boxSizing: "border-box",
                padding: "8px 10px",
                resize: "vertical",
                font: "inherit",
                lineHeight: "1.45",
              },
              listeners: [
                {
                  type: "input",
                  listener: (event: Event) => {
                    updatePresentationInstructionsCount(
                      event.currentTarget as HTMLTextAreaElement,
                    );
                  },
                },
              ],
            },
            {
              tag: "div",
              id: "presentation-user-instructions-count",
              properties: {
                textContent: getString("presentation-user-instructions-count", {
                  args: {
                    current: 0,
                    maximum: PRESENTATION_USER_INSTRUCTIONS_MAX_LENGTH,
                  },
                }),
              },
              styles: {
                color: "color-mix(in srgb, CanvasText 62%, transparent)",
                fontSize: "0.9em",
                lineHeight: "1.35",
                textAlign: "end",
              },
            },
          ],
        },
      ],
    },
  ];

  children.push({
    tag: "div",
    styles: {
      display: "flex",
      flexDirection: "column",
      gap: "5px",
      padding: "11px 13px",
      border: "1px solid color-mix(in srgb, #d89522 42%, transparent)",
      borderRadius: "6px",
      background: "color-mix(in srgb, #d89522 12%, Canvas)",
    },
    children: [
      {
        tag: "div",
        properties: {
          textContent: getString("presentation-cost-warning-title"),
        },
        styles: { fontWeight: "600" },
      },
      {
        tag: "div",
        properties: {
          textContent: getString("presentation-cost-warning-message"),
        },
        styles: { lineHeight: "1.45" },
      },
    ],
  });

  const dialogHelper = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      id: "presentation-settings-content",
      styles: {
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "18px",
        minWidth: "440px",
        maxWidth: "560px",
      },
      children,
    })
    .addButton(getString("auth-cancel"), "cancel")
    .addButton(getString("presentation-start"), "start", {
      noClose: true,
      callback: () => {
        const doc = dialogHelper.window?.document;
        if (!doc) return;
        const selectedSlideCount = (
          doc.getElementById(
            "presentation-slide-count",
          ) as HTMLSelectElement | null
        )?.value;
        const customSlideCount = (
          doc.getElementById(
            "presentation-custom-slide-count",
          ) as HTMLInputElement | null
        )?.value;
        const slideCount = parsePresentationDialogSlideCount(
          selectedSlideCount,
          customSlideCount,
        );
        if (slideCount === null) {
          showSlideCountError(doc);
          return;
        }
        clearSlideCountError(doc);
        const designSystem = (
          doc.getElementById(
            "presentation-design-system",
          ) as HTMLSelectElement | null
        )?.value;
        const userInstructions = (
          doc.getElementById(
            "presentation-user-instructions",
          ) as HTMLTextAreaElement | null
        )?.value;
        selection = normalizePresentationLaunchSettings({
          slideCount,
          designSystem:
            designSystem as PresentationLaunchSettings["designSystem"],
          userInstructions,
        });
        try {
          setPref("paperchatPresentationSlideCount", selection.slideCount);
          setPref("paperchatPresentationDesignSystem", selection.designSystem);
        } catch (error) {
          // Preference persistence is a convenience. It must not trap the user
          // in the dialog or discard a valid one-time selection.
          ztoolkit.log(
            "[PresentationLaunchDialogs] Failed to save presentation defaults:",
            error,
          );
        }
        dialogHelper.window?.close();
      },
    });

  let dialogWindow: Window | null = null;
  try {
    openZToolkitDialog(
      dialogHelper,
      mainWindow,
      getString("presentation-settings-title"),
      {
        resizable: false,
        centerscreen: true,
        fitContent: true,
      },
    );
    dialogWindow = dialogHelper.window;
    if (dialogWindow) {
      options.onSettingsFocusReady?.(() =>
        focusPresentationSettingsDialog(dialogWindow!),
      );
    }
    await dialogHelper.dialogData.unloadLock?.promise;
  } catch (error) {
    ztoolkit.log(
      "[PresentationLaunchDialogs] Failed to open presentation settings:",
      error,
    );
    return null;
  }
  return selection;
}

export function createPresentationLaunchDialogs(
  options: PresentationLaunchDialogOptions = {},
): PresentationLaunchGuardDialogs {
  return {
    async confirmSwitchToPaperChat(): Promise<boolean> {
      return showTwoButtonDialog({
        title: getString("presentation-paperchat-required-title"),
        message: getString("presentation-paperchat-required-message"),
        primary: getString("presentation-switch-paperchat"),
        secondary: getString("auth-cancel"),
      }).accepted;
    },

    async showInsufficientBalance(
      balance: PresentationBalanceSnapshot,
    ): Promise<void> {
      const decision = showTwoButtonDialog({
        title: getString("presentation-insufficient-balance-title"),
        message: getString("presentation-insufficient-balance-message", {
          args: {
            current: formatPresentationBalance(balance.available),
            required: formatPresentationBalance(
              PRESENTATION_MINIMUM_REMAINING_TOKENS,
            ),
          },
        }),
        primary: getString("pref-get-redeem-code"),
        secondary: getString("auth-cancel"),
      });
      if (decision.accepted) {
        await openPaperChatPurchaseDialog();
      }
    },

    async configurePresentation(): Promise<PresentationLaunchSettings | null> {
      return showPresentationSettingsDialog(options);
    },
  };
}
