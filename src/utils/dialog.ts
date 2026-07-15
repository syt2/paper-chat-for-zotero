import type { DialogHelper } from "zotero-plugin-toolkit";

/**
 * Open a ztoolkit dialog while keeping Window.openDialog's receiver.
 * This also preserves compatibility with extensions that wrap openDialog and
 * delegate to the native implementation using their incoming `this` value.
 */
export function openZToolkitDialog(
  dialogHelper: DialogHelper,
  mainWindow: Window,
  ...args: Parameters<DialogHelper["open"]>
): ReturnType<DialogHelper["open"]> {
  const openDialog = mainWindow.openDialog.bind(mainWindow);
  const getGlobal = dialogHelper.getGlobal.bind(dialogHelper);

  dialogHelper.getGlobal = ((name: string) =>
    name === "openDialog"
      ? openDialog
      : getGlobal(name)) as DialogHelper["getGlobal"];

  return dialogHelper.open(...args);
}
