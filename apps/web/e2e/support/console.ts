import type { ConsoleMessage, Page } from "@playwright/test";

/** One `securitypolicyviolation` event, as recorded in the page. */
export interface CspViolation {
  directive: string;
  blockedURI: string;
  disposition: string;
  sourceFile: string;
  line: number;
  sample: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

export interface Problems {
  /** console errors (page and workers), failed loads, any CSP console report, and uncaught exceptions. */
  errors: string[];
  /** CSP violations seen by the page so far (report-only ones included). */
  cspViolations(): Promise<CspViolation[]>;
}

/**
 * Starts collecting problems on `page`; call before the first navigation.
 *
 * The CSP ships report-only, so a violation never breaks the page: it only
 * fires a `securitypolicyviolation` event (and a console report). An init
 * script records every event from the first byte of each document, so the
 * policy is actually tested rather than silently ignored.
 */
export async function watchProblems(page: Page, opts: { ignore?: (m: ConsoleMessage) => boolean } = {}): Promise<Problems> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // Chrome logs CSP reports at error, warning or info level depending on the
    // directive, and messages from workers (the decoders) arrive here too, with
    // m.worker() set. Any mention of the policy counts, at any level.
    const csp = /Content Security Policy/i.test(m.text());
    if ((m.type() !== "error" && !csp) || opts.ignore?.(m)) return;
    const at = m.location().url;
    errors.push(`console.${m.type()}${m.worker() ? " (worker)" : ""}: ${m.text()}${at ? ` (${at})` : ""}`);
  });
  await page.addInitScript(() => {
    const seen: CspViolation[] = [];
    window.__cspViolations = seen;
    // Capture on window: the event bubbles (and is composed) from the element
    // or document where it is dispatched.
    window.addEventListener(
      "securitypolicyviolation",
      (e) => {
        seen.push({
          directive: e.effectiveDirective,
          blockedURI: e.blockedURI,
          disposition: e.disposition,
          sourceFile: e.sourceFile,
          line: e.lineNumber,
          sample: e.sample,
        });
      },
      true,
    );
  });
  return {
    errors,
    cspViolations: () => page.evaluate(() => window.__cspViolations ?? []),
  };
}
