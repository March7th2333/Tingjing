export type ColorThemeId = "dark" | "light";

export type ColorThemePreference = "system" | ColorThemeId;

export interface ColorTheme {
  id: ColorThemeId;
  background: string;
  surface: string;
  foreground: string;
  mutedText: string;
  subtleText: string;
  accent: string;
  glow: string;
  border: string;
  grainIntensity: number;
  transitionDuration: number;
}
