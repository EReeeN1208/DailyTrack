import { Stack } from "expo-router";

import { AuthProvider, useAuth } from "@/context/auth";

function RootNavigator() {
  const { session, isLoading } = useAuth();

  if (isLoading) return null;

  return (
    <Stack>
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
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
