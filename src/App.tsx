import { WelcomeScreen } from "./features/welcome/WelcomeScreen";
import { LanguageProvider } from "./i18n/LanguageContext";
import { ColorThemeProvider } from "./theme/ColorThemeContext";

export default function App() {
  return (
    <LanguageProvider>
      <ColorThemeProvider>
        <WelcomeScreen />
      </ColorThemeProvider>
    </LanguageProvider>
  );
}
