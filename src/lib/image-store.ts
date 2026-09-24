import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import type { Attachment } from "../../shared/protocol";

/**
 * Tool-result images history() sent only as references (Attachment.ref):
 * fetched once when their thumbnail becomes visible, cached for the session.
 */
const cache = new Map<string, Attachment>();
const requested = new Set<string>();
const listeners = new Set<() => void>();
let fetcher: ((ref: string) => void) | null = null;

export const imageStore = {
  /** App wires this to the history_image command. */
  setFetcher(fn: ((ref: string) => void) | null) {
    fetcher = fn;
  },
  resolve(ref: string, img: Attachment) {
    cache.set(ref, img);
    listeners.forEach((l) => l());
  },
  /** A failed fetch may be retried on the next view. */
  fail(ref: string) {
    requested.delete(ref);
  },
  clear() {
    cache.clear();
    requested.clear();
  },
  request(ref: string) {
    if (cache.has(ref) || requested.has(ref) || !fetcher) return;
    requested.add(ref);
    fetcher(ref);
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The full image: inline data as is, a reference once it is fetched (null until then). */
export function useImage(img: Attachment, want: boolean): Attachment | null {
  const cached = useSyncExternalStore(subscribe, () => (img.ref ? cache.get(img.ref) : undefined));
  useEffect(() => {
    if (want && img.ref && !img.data) imageStore.request(img.ref);
  }, [want, img.ref, img.data]);
  if (img.data) return img;
  return cached ?? null;
}

/** True once the element has been near the viewport (stays true). */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    }, { root: el.closest(".scroll"), rootMargin: "400px" }); // prefetch within the transcript's own scroller
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}
