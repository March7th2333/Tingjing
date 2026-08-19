import { useLanguage } from "../../i18n/LanguageContext";
import type { AppLanguage } from "../../i18n/language";
import "./language-selector.css";

interface LanguageSelectorProps {
  compact?: boolean;
  className?: string;
  showLabel?: boolean;
}
const languageOptions: readonly AppLanguage[] = ["zh-CN", "en-US"];

export function LanguageSelector({
  compact = false,
  className = "",
  showLabel = true,
}: LanguageSelectorProps) {
  const { language, setLanguage, t } = useLanguage();

  return (
    <section
      className={`language-selector ${className}`.trim()}
      data-compact={compact}
    >
      {showLabel && (
        <span className="language-selector__label">
          {t("language.label")}
        </span>
      )}
      <div
        className="language-selector__options"
        role="radiogroup"
        aria-label={t("language.aria")}
      >
        {languageOptions.map((option) => (
          <button
            type="button"
            role="radio"
            aria-checked={language === option}
            data-active={language === option}
            lang={option}
            key={option}
            onClick={() => setLanguage(option)}
          >
            {option === "zh-CN"
              ? t("language.chinese")
              : t("language.english")}
          </button>
        ))}
      </div>
    </section>
  );
}
