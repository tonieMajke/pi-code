import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Appearance, AppearancePatch, ThemeChoice } from "../../shared/protocol.js";

type Stored = Omit<Appearance, "imageUrl"> & { imageMime: string | null };

const DEFAULTS: Stored = {
  theme: "system",
  accent: null,
  background: null,
  image: { dim: 0.55, blur: 0 },
  imageMime: null,
};

const THEMES = new Set<ThemeChoice>(["system", "dark", "light"]);
const HEX = /^#[0-9a-f]{6}$/i;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
/** The UI downscales before sending; this only stops a runaway payload. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

const color = (v: unknown, fallback: string | null) =>
  v === null ? null : typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fallback;

/**
 * GUI look (theme, colours, background picture). Kept apart from pi-gui.json
 * because it is needed before a session exists and the picture is a binary file.
 */
export class AppearanceStore {
  private state: Stored;
  private readonly file: string;
  private readonly imageFile: string;

  constructor(dir: string) {
    this.file = join(dir, "pi-gui-appearance.json");
    this.imageFile = join(dir, "pi-gui-background");
    let raw: Partial<Stored> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
    } catch {
      /* missing or unreadable — defaults */
    }
    this.state = this.sanitize(raw, DEFAULTS);
  }

  get(): Appearance {
    const { imageMime, ...rest } = this.state;
    let imageUrl: string | null = null;
    if (imageMime) {
      try {
        imageUrl = `data:${imageMime};base64,${readFileSync(this.imageFile).toString("base64")}`;
      } catch {
        /* file removed by hand — behave as if there is no picture */
      }
    }
    return { ...rest, image: { ...rest.image }, imageUrl };
  }

  update(patch: AppearancePatch): Appearance {
    this.state = this.sanitize(
      { ...this.state, ...patch, image: { ...this.state.image, ...patch.image } },
      this.state,
    );
    this.save();
    return this.get();
  }

  setImage(dataUrl: string | null): Appearance {
    if (dataUrl === null) {
      rmSync(this.imageFile, { force: true });
      this.state = { ...this.state, imageMime: null };
    } else {
      const m = DATA_URL.exec(dataUrl);
      if (!m) throw new Error("unsupported image (expected a base64 jpeg/png/webp/gif data: URL)");
      const bytes = Buffer.from(m[2], "base64");
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image too large");
      mkdirSync(join(this.imageFile, ".."), { recursive: true });
      writeFileSync(this.imageFile, bytes);
      this.state = { ...this.state, imageMime: m[1] };
    }
    this.save();
    return this.get();
  }

  private sanitize(raw: Partial<Stored>, base: Stored): Stored {
    return {
      theme: raw.theme && THEMES.has(raw.theme) ? raw.theme : base.theme,
      accent: color(raw.accent, base.accent),
      background: color(raw.background, base.background),
      image: {
        dim: clamp(raw.image?.dim, 0, 0.95, base.image.dim),
        blur: clamp(raw.image?.blur, 0, 40, base.image.blur),
      },
      imageMime: typeof raw.imageMime === "string" ? raw.imageMime : raw.imageMime === null ? null : base.imageMime,
    };
  }

  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
