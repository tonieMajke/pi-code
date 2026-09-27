import { inTauri } from "./tauri";

/** Only these leave the app. file:, javascript:, data: and relative links from a model's reply do not. */
export function isExternalUrl(href: string | undefined): href is string {
  return !!href && /^(https?:\/\/|mailto:)/i.test(href.trim());
}

/**
 * Open a link in the user's browser. In the Tauri webview target=_blank does nothing on Linux,
 * so it goes through tauri-plugin-opener (xdg-open); in the dev browser a new tab.
 */
export async function openExternal(href: string): Promise<void> {
  if (!isExternalUrl(href)) return;
  if (inTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(href.trim());
  } else {
    window.open(href.trim(), "_blank", "noopener,noreferrer");
  }
}
