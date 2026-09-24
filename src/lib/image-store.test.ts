import { describe, expect, it, vi } from "vitest";
import { imageStore } from "./image-store";

describe("imageStore", () => {
  it("asks the sidecar once per image, again only after a failure or a new session", () => {
    const fetch = vi.fn();
    imageStore.setFetcher(fetch);
    imageStore.request("s/c/0");
    imageStore.request("s/c/0");
    expect(fetch).toHaveBeenCalledTimes(1);
    imageStore.fail("s/c/0");
    imageStore.request("s/c/0");
    expect(fetch).toHaveBeenCalledTimes(2);
    imageStore.resolve("s/c/0", { data: "x", mimeType: "image/png", ref: "s/c/0" });
    imageStore.request("s/c/0");
    expect(fetch).toHaveBeenCalledTimes(2);
    imageStore.clear();
    imageStore.request("s/c/0");
    expect(fetch).toHaveBeenCalledTimes(3);
    imageStore.setFetcher(null);
  });
});
