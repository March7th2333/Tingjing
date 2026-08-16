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
  appLanguageStorageKey,
  defaultAppLanguage,
  normalizeAppLanguage,
  type AppLanguage,
} from "./language";
import {
  translate,
  type MessageKey,
  type TranslationValues,
} from "./messages";

interface LanguageContextValue {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (key: MessageKey, values?: TranslationValues) => string;
}
const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLanguage() {
  if (typeof window === "undefined") {
    return defaultAppLanguage;
  }

  try {
    return normalizeAppLanguage(
      window.localStorage.getItem(appLanguageStorageKey),
    );
  } catch {
    return defaultAppLanguage;
  }
}

export function LanguageProvider({ children }: PropsWithChildren) {
  const [language, setLanguageState] = useState<AppLanguage>(readStoredLanguage);

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    const normalizedLanguage = normalizeAppLanguage(nextLanguage);
    try {
      window.localStorage.setItem(
        appLanguageStorageKey,
        normalizedLanguage,
      );
    } catch {
      // The selected language remains active for the current session.
    }
    setLanguageState(normalizedLanguage);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== appLanguageStorageKey) {
        return;
      }
      setLanguageState(normalizeAppLanguage(event.newValue));
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = language;
    root.dataset.language = language;
  }, [language]);

  const t = useCallback(
    (key: MessageKey, values?: TranslationValues) =>
      translate(language, key, values),
    [language],
  );

  const value = useMemo(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}
