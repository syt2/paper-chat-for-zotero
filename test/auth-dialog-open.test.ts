import { assert } from "chai";
import type { DialogHelper } from "zotero-plugin-toolkit";

import { showAuthDialog } from "../src/modules/ui/AuthDialog";
import { openZToolkitDialog } from "../src/utils/dialog";

describe("auth dialog opening", function () {
  it("binds openDialog to the main window without changing other globals", function () {
    const openDialogReceivers: unknown[] = [];
    const getGlobalReceivers: unknown[] = [];
    const requestedGlobals: string[] = [];
    const openCalls: unknown[][] = [];
    const fallbackValue = {};
    const mainWindow = {
      openDialog(this: unknown) {
        openDialogReceivers.push(this);
      },
    } as unknown as Window;
    const dialogHelper = {
      getGlobal(this: unknown, name: string) {
        getGlobalReceivers.push(this);
        requestedGlobals.push(name);
        return fallbackValue;
      },
      open(this: DialogHelper, ...args: unknown[]) {
        openCalls.push(args);
        const openDialog = this.getGlobal("openDialog") as () => void;
        openDialog();
        return this;
      },
    } as unknown as DialogHelper;
    const features = { centerscreen: true, resizable: false };

    const result = openZToolkitDialog(
      dialogHelper,
      mainWindow,
      "Test dialog",
      features,
    );

    assert.strictEqual(result, dialogHelper);
    assert.deepEqual(openCalls, [["Test dialog", features]]);
    assert.deepEqual(openDialogReceivers, [mainWindow]);
    assert.strictEqual(dialogHelper.getGlobal("document"), fallbackValue);
    assert.deepEqual(getGlobalReceivers, [dialogHelper]);
    assert.deepEqual(requestedGlobals, ["document"]);
  });

  it("allows another attempt after synchronous setup failure", async function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: typeof Zotero;
    };
    const originalZotero = globalWithZotero.Zotero;
    const testZotero = (originalZotero || {}) as typeof Zotero;
    const originalGetMainWindow = testZotero.getMainWindow;
    let getMainWindowCalls = 0;
    globalWithZotero.Zotero = testZotero;
    testZotero.getMainWindow = () => {
      getMainWindowCalls += 1;
      return null as unknown as Window;
    };

    try {
      assert.isFalse(await showAuthDialog("login"));
      assert.isFalse(await showAuthDialog("login"));
      assert.equal(getMainWindowCalls, 2);
    } finally {
      if (originalZotero) {
        testZotero.getMainWindow = originalGetMainWindow;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });
});
