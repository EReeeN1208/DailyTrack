import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SystemUI from "expo-system-ui";
import { DarkTheme, DefaultTheme, type Theme as NavigationTheme } from "expo-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Appearance } from "react-native";

export type ThemePreference = "system" | "light" | "dark";
type ColorScheme = "light" | "dark";

const THEME_PREFERENCE_KEY = "dailytrack:theme-preference";

const PALETTES: Record<ColorScheme, Record<string, string>> = {
  light: {
    background: "#FFFFFF",
    text: "#000000",
    secondaryText: "#8E8E93",
    card: "rgba(120,120,128,0.12)",
    tint: "#208AEF",
    danger: "#FF3B30",
  },
  dark: {
    background: "#000000",
    text: "#FFFFFF",
    secondaryText: "#8E8E93",
    card: "rgba(120,120,128,0.16)",
    tint: "#208AEF",
    danger: "#FF3B30",
  },
};

type ThemeContextValue = {
  preference: ThemePreference;
  colorScheme: ColorScheme;
  colors: Record<string, string>;
  navigationTheme: NavigationTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveScheme(preference: ThemePreference, systemScheme: ColorScheme): ColorScheme {
  return preference === "system" ? systemScheme : preference;
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [systemScheme, setSystemScheme] = useState<ColorScheme>(() =>
    Appearance.getColorScheme() === "dark" ? "dark" : "light"
  );

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme === "dark" ? "dark" : "light");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") {
        setPreferenceState(stored);
      }
    });
  }, []);

  const colorScheme = resolveScheme(preference, systemScheme);
  const colors = PALETTES[colorScheme];

  // Drives the native header/tab-bar chrome, which React Navigation themes
  // independently of our own `colors` palette — without this, they stay on
  // the light `DefaultTheme` regardless of the app's resolved color scheme.
  const navigationTheme = useMemo<NavigationTheme>(() => {
    const base = colorScheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: colors.tint,
        background: colors.background,
        card: colors.background,
        text: colors.text,
      },
    };
  }, [colorScheme, colors]);

  useEffect(() => {
    Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
  }, [preference]);

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(THEME_PREFERENCE_KEY, next);
  };

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, colorScheme, colors, navigationTheme, setPreference }),
    [preference, colorScheme, colors, navigationTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
