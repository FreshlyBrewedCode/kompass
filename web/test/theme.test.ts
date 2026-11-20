import { expect, test } from "bun:test";
import { parsePreference, resolveTheme } from "../src/lib/theme";

test("a stored value is a preference; anything else is system", () => {
  expect(parsePreference("dark")).toBe("dark");
  expect(parsePreference("light")).toBe("light");
  expect(parsePreference("system")).toBe("system");
  expect(parsePreference(null)).toBe("system");
  expect(parsePreference("sepia")).toBe("system");
});

test("system follows the OS setting; light and dark ignore it", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
});
