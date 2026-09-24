"use client";

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else {
        loading = null;
        reject(new Error("turnstile failed to load"));
      }
    };
    s.onerror = () => {
      loading = null;
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Cloudflare Turnstile, the bot check before the queue (spec). Calls
 * `onToken` with a single-use token, or null when it expires or fails. Mount
 * it again (a new `key`) for a fresh token.
 */
export function Turnstile({ siteKey, onToken, onError }: { siteKey: string; onToken: (t: string | null) => void; onError?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  const errCb = useRef(onError);
  useEffect(() => {
    cb.current = onToken;
    errCb.current = onError;
  });
  useEffect(() => {
    let id: string | null = null;
    let alive = true;
    loadTurnstile()
      .then((api) => {
        if (!alive || !box.current) return;
        id = api.render(box.current, {
          sitekey: siteKey,
          theme: "dark",
          callback: (t: string) => cb.current(t),
          "expired-callback": () => cb.current(null),
          "error-callback": () => {
            cb.current(null);
            errCb.current?.();
          },
        });
      })
      .catch(() => {
        cb.current(null);
        errCb.current?.();
      });
    return () => {
      alive = false;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey]);
  return <div ref={box} className="min-h-[65px]" data-testid="turnstile" />;
}
