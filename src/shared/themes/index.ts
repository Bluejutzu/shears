import type { M3Prefs } from "./m3";

export type ThemeName = "shears" | "m3";

/** What the rest of the app can ask of the loaded theme. */
export type Theme = {
  name: ThemeName;
  /** blurred background image (Material 3 only) */
  banner: (url: string | null) => void;
  /** re-apply accent/intensity/brightness live (Material 3 only) */
  apply: (prefs: M3Prefs) => void;
};

const HUES: [number, string][] = [
  [15, "Red"],
  [40, "Orange"],
  [65, "Yellow"],
  [90, "Lime"],
  [150, "Green"],
  [175, "Teal"],
  [200, "Cyan"],
  [245, "Blue"],
  [265, "Indigo"],
  [290, "Purple"],
  [320, "Magenta"],
  [345, "Pink"],
  [360, "Red"],
];

export const hueName = (h: number) =>
  HUES.find(([max]) => h <= max)?.[1] ?? "Red";

/** Load only the chosen theme's styles and code. Switching themes needs a restart. */
export async function loadTheme(name: ThemeName, m3: M3Prefs): Promise<Theme> {
  if (name === "m3") {
    const m = await import("./m3");
    m.init(m3);
    return { name, ...m.api };
  }
  await import("./shears.css");
  return { name: "shears", banner: () => {}, apply: () => {} };
}
