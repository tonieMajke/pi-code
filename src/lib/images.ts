import type { Attachment } from "../../shared/protocol";
import { t } from "../../shared/i18n";

const MAX_SIDE = 2048;
const KEEP_PNG_BELOW = 1_500_000;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** Image file → base64 attachment, downscaled so the longest side is ≤ 2048 px. */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (!file.type.startsWith("image/")) throw new Error(t("to nie jest obraz: {name}", { name: file.name }));
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < KEEP_PNG_BELOW) {
    bitmap.close();
    return { data: await blobToBase64(file), mimeType: file.type };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === "image/png" && file.size < KEEP_PNG_BELOW * 2 ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, 0.9),
  );
  return { data: await blobToBase64(blob), mimeType: type };
}

export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const item of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const f = item instanceof File ? item : item.kind === "file" ? item.getAsFile() : null;
    if (f && f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

export const dataUrl = (a: Attachment) => `data:${a.mimeType};base64,${a.data}`;
