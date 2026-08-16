import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { PropsWithChildren } from "react";
import {
  colorThemes,
  createColorThemeVariables,
} from "../config/colorThemes";
import type {
  ColorTheme,
  ColorThemeId,
  ColorThemePreference,
} from "../types/colorTheme";

const preferenceStorageKey = "tingjing:color-theme";
const systemColorQuery = "(prefers-color-scheme: light)";

interface ColorThemeContextValue {
  theme: ColorTheme;
  resolvedThemeId: ColorThemeId;
  preference: ColorThemePreference;
  setPreference: (preference: ColorThemePreference) => void;
}

const ColorThemeContext =
  createContext<ColorThemeContextValue | null>(null);

function getSystemTheme(): ColorThemeId {
  return window.matchMedia(systemColorQuery).matches ? "light" : "dark";
}

function getStoredPreference(): ColorThemePreference {
  const storedPreference = window.localStorage.getItem(preferenceStorageKey);

  if (
    storedPreference === "system" ||
    storedPreference === "dark" ||
    storedPreference === "light"
  ) {
    return storedPreference;
  }

  return "system";
}

export function ColorThemeProvider({
  children,
}: PropsWithChildren) {
  const [preference, setPreferenceState] =
    useState<ColorThemePreference>(getStoredPreference);
  const [systemTheme, setSystemTheme] =
    useState<ColorThemeId>(getSystemTheme);

  useEffect(() => {
    const mediaQuery = window.matchMedia(systemColorQuery);
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? "light" : "dark");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const setPreference = useCallback(
    (nextPreference: ColorThemePreference) => {
      window.localStorage.setItem(preferenceStorageKey, nextPreference);
      setPreferenceState(nextPreference);
    },
    [],
  );

  const resolvedThemeId =
    preference === "system" ? systemTheme : preference;
  const theme = colorThemes[resolvedThemeId];

  useLayoutEffect(() => {
    const root = document.documentElement;
    const themeVariables = createColorThemeVariables(theme);

    root.dataset.colorTheme = resolvedThemeId;
    root.style.colorScheme = resolvedThemeId;

    Object.entries(themeVariables).forEach(([property, value]) => {
      root.style.setProperty(property, String(value));
    });
  }, [resolvedThemeId, theme]);

  const value = useMemo(
    () => ({
      theme,
      resolvedThemeId,
      preference,
      setPreference,
    }),
    [preference, resolvedThemeId, setPreference, theme],
  );

  return (
    <ColorThemeContext.Provider value={value}>
      {children}
    </ColorThemeContext.Provider>
  );
}

export function useColorTheme() {
  const context = useContext(ColorThemeContext);

  if (!context) {
    throw new Error(
      "useColorTheme must be used within ColorThemeProvider",
    );
  }

  return context;
}
