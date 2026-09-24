// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppearanceSection } from "./Settings";
import { DEFAULT_APPEARANCE } from "../lib/appearance";

afterEach(cleanup);

describe("Settings → Wygląd", () => {
  it("picks a preset accent and switches the theme", () => {
    const onPatch = vi.fn();
    render(<AppearanceSection a={DEFAULT_APPEARANCE} onPatch={onPatch} onImage={vi.fn()} busy={false} />);
    fireEvent.click(screen.getAllByTitle("#5b8def")[0]);
    expect(onPatch).toHaveBeenCalledWith({ accent: "#5b8def" });
    fireEvent.click(screen.getByText("jasny"));
    expect(onPatch).toHaveBeenCalledWith({ theme: "light" });
  });

  it("image controls appear only with a picture; remove and sliders report changes", () => {
    const onPatch = vi.fn();
    const onImage = vi.fn();
    const { rerender } = render(<AppearanceSection a={DEFAULT_APPEARANCE} onPatch={onPatch} onImage={onImage} busy={false} />);
    expect(screen.queryByText("Rozmycie obrazu")).toBeNull();
    expect(screen.getByText("Wybierz obraz…")).toBeTruthy();

    rerender(
      <AppearanceSection a={{ ...DEFAULT_APPEARANCE, imageUrl: "data:image/jpeg;base64,AA==" }} onPatch={onPatch} onImage={onImage} busy={false} />,
    );
    fireEvent.change(screen.getAllByRole("slider")[1], { target: { value: "12" } });
    expect(onPatch).toHaveBeenCalledWith({ image: { blur: 12 } });
    fireEvent.click(screen.getByTitle("Usuń obraz"));
    expect(onImage).toHaveBeenCalledWith(null);
  });

  it("a picked file is handed over for import", () => {
    const onImage = vi.fn();
    const { container } = render(<AppearanceSection a={DEFAULT_APPEARANCE} onPatch={vi.fn()} onImage={onImage} busy={false} />);
    const file = new File(["x"], "tlo.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(onImage).toHaveBeenCalledWith(file);
  });
});
