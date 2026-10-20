import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Logo, { LogoIcon } from "./Logo";

describe("Logo component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the logo icon and brand name by default", () => {
    const { container } = render(<Logo />);
    expect(screen.getByText("StellarFreelance")).toBeDefined();
    const svg = container.querySelector("svg");
    expect(svg).toBeDefined();
    expect(svg?.getAttribute("width")).toBe("28");
    expect(svg?.getAttribute("height")).toBe("28");
  });

  it("supports custom size and hiding brand name", () => {
    const { container } = render(<Logo size={36} showText={false} className="custom-logo" />);
    expect(screen.queryByText("StellarFreelance")).toBeNull();
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("36");
    expect(svg?.getAttribute("height")).toBe("36");
    expect(container.querySelector(".custom-logo")).toBeDefined();
  });

  it("renders LogoIcon standalone with custom size", () => {
    const { container } = render(<LogoIcon size={40} data-testid="standalone-logo" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("40");
    expect(svg?.getAttribute("data-testid")).toBe("standalone-logo");
  });
});
