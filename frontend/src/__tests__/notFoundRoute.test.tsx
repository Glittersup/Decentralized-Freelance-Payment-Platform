/**
 * NotFound route (issue #29).
 *
 * Renders the real `App` at an address no route handles, so this fails if the
 * `path="*"` route is removed or mounted above the real routes. `App` uses
 * `BrowserRouter`, which reads `window.location`; jsdom lets the test set that
 * with `history.pushState`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "../App";

const UNKNOWN_PATH = "/a-page-that-does-not-exist";

beforeEach(() => {
  window.history.pushState({}, "", UNKNOWN_PATH);
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
});

describe("catch-all route", () => {
  it("renders the NotFound page for an unknown path", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeDefined();
    expect(
      screen.getByText(/the page you requested does not exist or has been moved/i),
    ).toBeDefined();
  });

  it("links back to the Dashboard", () => {
    render(<App />);

    const link = screen.getByRole("link", { name: /back to dashboard/i });
    expect(link.getAttribute("href")).toBe("/");
  });
});
