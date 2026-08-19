import type { CSSProperties } from "react";
import type {
  ColorTheme,
  ColorThemeId,
} from "../types/colorTheme";

export const colorThemes: Record<ColorThemeId, ColorTheme> = {
  dark: {
    id: "dark",
    background: "#0d0d0f",
    surface: "#111214",
    foreground: "#f5f5f2",
    mutedText: "#b8b8b4",
    subtleText: "#81817d",
    accent: "#d8d8d4",
    glow: "#ffffff",
    border: "rgba(245, 245, 242, 0.24)",
    grainIntensity: 0.026,
    transitionDuration: 320,
  },
  light: {
    id: "light",
    background: "#f4f3ee",
    surface: "#e8e7e1",
    foreground: "#111111",
    mutedText: "#50504d",
    subtleText: "#787875",
    accent: "#292929",
    glow: "#000000",
    border: "rgba(17, 17, 17, 0.22)",
    grainIntensity: 0.014,
    transitionDuration: 320,
  },
};

type ThemeVariables = CSSProperties &
  Record<
    | "--theme-background"
    | "--theme-surface"
    | "--theme-foreground"
    | "--theme-muted"
    | "--theme-subtle"
    | "--theme-accent"
    | "--theme-glow"
    | "--theme-border"
    | "--theme-grain"
    | "--theme-transition",
    string
  >;

export function createColorThemeVariables(
  theme: ColorTheme,
): ThemeVariables {
  return {
    "--theme-background": theme.background,
    "--theme-surface": theme.surface,
    "--theme-foreground": theme.foreground,
    "--theme-muted": theme.mutedText,
    "--theme-subtle": theme.subtleText,
    "--theme-accent": theme.accent,
    "--theme-glow": theme.glow,
    "--theme-border": theme.border,
    "--theme-grain": `${theme.grainIntensity}`,
    "--theme-transition": `${theme.transitionDuration}ms`,
  };
}

export function createGrayscaleParticlePalette(theme: ColorTheme) {
  return [
    theme.foreground,
    theme.mutedText,
    theme.accent,
    theme.subtleText,
  ] as const;
}
