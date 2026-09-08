import { createElement } from "./ChatPanelBuilder";
import { chatFontSize } from "./ChatPanelTypography";
import { getString } from "../../../utils/locale";
import {
  getAnalyticsService,
  trackPaperChatPurchaseEntryClicked,
} from "../../analytics";

export function createTopupButton(doc: Document): HTMLElement {
  const btn = createElement(
    doc,
    "button",
    {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      marginTop: "12px",
      marginLeft: "auto",
      marginRight: "auto",
      padding: "7px 12px",
      borderRadius: "8px",
      border: "1px solid #f59e0b",
      background:
        "linear-gradient(135deg, rgba(255, 244, 214, 0.98), rgba(255, 223, 128, 0.98))",
      color: "#7c3e00",
      fontSize: chatFontSize(12),
      fontWeight: "700",
      lineHeight: "1.2",
      textAlign: "center",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(245, 158, 11, 0.2)",
    },
    { class: "paperchat-topup-btn" },
  );

  btn.setAttribute("type", "button");
  btn.textContent = getString("chat-error-paperchat-topup-action");
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    trackPaperChatPurchaseEntryClicked(
      getAnalyticsService(),
      "quota_error_card",
    );
    void import("../../preferences/UserAuthUI")
      .then((module) => module.openPaperChatSettingsForTopup())
      .catch((error) => {
        ztoolkit.log(
          "[Chat] Failed to open PaperChat settings for topup:",
          error,
        );
        Zotero.Utilities.Internal.openPreferences("paperchat-prefpane");
      });
  });
  return btn;
}
