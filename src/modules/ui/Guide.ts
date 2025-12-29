/**
 * Guide - 新用户引导
 *
 * 在用户首次安装插件时显示引导弹窗
 */

import { config, version } from "../../../package.json";
import { getPref, setPref } from "../../utils/prefs";
import { getString } from "../../utils/locale";

/**
 * 引导状态枚举（使用位掩码，便于扩展）
 */
export enum GuideStatus {
  toolbarButtonGuide = 1,
  // 未来可以添加更多引导步骤
  // nextGuide = 2,
}

/**
 * Guide 类 - 管理用户引导
 */
export class Guide {
  /**
   * 初始化 prefs，记录首次安装版本
   */
  static initPrefs(): void {
    if (!getPref("firstInstalledVersion")) {
      setPref("firstInstalledVersion", version);
    }
  }

  /**
   * 在主窗口显示工具栏按钮引导（如果需要）
   */
  static showToolbarGuideIfNeed(win: Window): void {
    if (!this.checkNeedGuide(GuideStatus.toolbarButtonGuide)) {
      return;
    }

    const toolbarButton = win.document.getElementById(`${config.addonRef}-toolbar-button`);
    if (!toolbarButton) {
      return;
    }

    const guide = new ztoolkit.Guide();
    guide
      .addStep({
        title: getString("guide-toolbar-title"),
        description: getString("guide-toolbar-description"),
        element: toolbarButton,
        showButtons: ["close"],
        closeBtnText: getString("guide-got-it"),
        position: "after_end",
      })
      .show(win.document);

    // 标记引导已完成
    setPref(
      "guideStatus",
      ((getPref("guideStatus") as number) ?? 0) | GuideStatus.toolbarButtonGuide,
    );
  }

  /**
   * 检查是否需要显示指定的引导
   */
  private static checkNeedGuide(guideStatus: GuideStatus): boolean {
    const firstInstalledVersion = getPref("firstInstalledVersion");
    if (!firstInstalledVersion) {
      return false;
    }

    // 如果不是首次安装当前版本（升级用户），不显示引导
    if (Services.vc.compare(firstInstalledVersion as string, version) < 0) {
      return false;
    }

    // 检查是否已经显示过该引导
    const alreadyGuideStatus = (getPref("guideStatus") as number) ?? 0;
    if (alreadyGuideStatus & guideStatus) {
      return false;
    }

    return true;
  }
}
