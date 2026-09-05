import { Stack, ThemeProvider as NavigationThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { AuthProvider, useAuth } from "@/context/auth";
import { ThemeProvider, useTheme } from "@/context/theme";

export function ErrorBoundary({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <View style={styles.errorContainer}>
      <Text style={styles.errorTitle}>Something went wrong</Text>
      <Text style={styles.errorMessage}>{error.message}</Text>
      <Pressable onPress={retry} style={styles.retryButton}>
        <Text style={styles.retryButtonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function RootNavigator() {
  const { session, isLoading } = useAuth();
  const { colorScheme, colors, navigationTheme } = useTheme();

  if (isLoading) return null;

  return (
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="index" />
          <Stack.Screen
            name="create-table"
            options={{
              presentation: "formSheet",
              // A single detent avoids dragging across the "elevated" (partial
              // height) vs "base" (full height) presentation boundary, which
              // is what was causing grouped-list colors (backgrounds, tints)
              // to visibly swap mid-gesture as the sheet was pulled up.
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen name="table/[id]/index" />
          <Stack.Screen
            name="table/[id]/record/[recordId]"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen name="settings" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  errorMessage: {
    textAlign: "center",
    color: "#8E8E93",
  },
  retryButton: {
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: "#208AEF",
  },
  retryButtonText: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
});
