import { describe, expect, it } from "vitest";
import { bytesToImageFile, sniffImageType } from "./images";

const bytes = (...v: number[]) => new Uint8Array([...v, ...new Array(16).fill(0)]);

describe("sniffImageType", () => {
  it("knows the formats the clipboard and file picker hand over", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(sniffImageType(bytes(0x42, 0x4d))).toBe("image/bmp");
  });

  it("a RIFF that is not WebP (a WAV) is no image", () => {
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
  });
});

describe("bytesToImageFile", () => {
  it("an empty answer (no image in the clipboard) is no file", () => {
    expect(bytesToImageFile(new ArrayBuffer(0), "clipboard.png")).toBeNull();
  });

  it("gives the file the sniffed type, whatever the name says", () => {
    const f = bytesToImageFile(bytes(0xff, 0xd8, 0xff).buffer, "clipboard.png");
    expect(f?.type).toBe("image/jpeg");
    expect(f?.name).toBe("clipboard.png");
  });
});
