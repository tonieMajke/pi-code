import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { bytesToImageFile } from "./images";

/**
 * WebKitGTK (the Tauri webview on Linux) hides images from the page: a paste event carries
 * only text/html, a drop never reaches it (Tauri takes it), and the hidden `<input type=file>`
 * did nothing for the user in the AppImage (the dialog plugin, as for folders, does). These go through the Rust side instead.
 */

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

export const isImagePath = (p: string) => IMAGE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase() ?? "");

const baseName = (p: string) => p.split("/").pop() || p;

/** The image in the system clipboard, or null when there is none. */
export async function clipboardImage(): Promise<File | null> {
  return bytesToImageFile(await invoke<ArrayBuffer>("clipboard_image"), "clipboard.png");
}

export async function readImagePaths(paths: string[]): Promise<File[]> {
  const out: File[] = [];
  for (const p of paths.filter(isImagePath)) {
    const f = bytesToImageFile(await invoke<ArrayBuffer>("read_image_file", { path: p }), baseName(p));
    if (f) out.push(f);
  }
  return out;
}

/** Native file dialog for images; [] when cancelled. */
export async function pickImages(title: string, filterName: string): Promise<File[]> {
  const picked = await openDialog({ multiple: true, title, filters: [{ name: filterName, extensions: IMAGE_EXTENSIONS }] });
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  return readImagePaths(paths);
}
