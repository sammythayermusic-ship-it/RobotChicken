import type { Page } from "@playwright/test";

/**
 * How many objects built by the page's `ctor` are still alive after a full
 * garbage collection (Chromium only: it asks V8 through CDP). The results are
 * held in an object group that is released before returning, so counting
 * never keeps anything alive itself. (Same helper as smoke.spec.ts.)
 */
export async function liveObjects(page: Page, ctor: string): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  const objectGroup = "live-objects";
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const { result: proto } = await cdp.send("Runtime.evaluate", { expression: `${ctor}.prototype`, objectGroup });
    const { objects } = await cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.objectId as string, objectGroup });
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: objects.objectId as string,
      functionDeclaration: "function () { return this.length; }",
      returnByValue: true,
      objectGroup,
    });
    return result.value as number;
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup });
    await cdp.detach();
  }
}
