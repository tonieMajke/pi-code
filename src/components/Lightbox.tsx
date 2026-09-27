import { useEffect } from "react";
import type { Attachment } from "../../shared/protocol";
import { dataUrl } from "../lib/images";
import { useImage } from "../lib/image-store";

/** An image over the whole window; a click or Esc closes it. Fetches a history image by ref if needed. */
export function Lightbox({ img, onClose }: { img: Attachment; onClose: () => void }) {
  const full = useImage(img, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose}>
      {full && <img src={dataUrl(full)} alt="" />}
    </div>
  );
}
