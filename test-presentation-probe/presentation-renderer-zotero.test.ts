// Keep the real Zotero probe isolated from Node-only tests in test/.
// The scaffold treats each entry as a directory, so this thin entry imports
// the canonical test without duplicating its assertions.
import "../test/presentation-renderer-zotero.test.ts";
