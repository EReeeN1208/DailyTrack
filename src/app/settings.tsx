import { Pressable, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";

import { useAuth } from "@/context/auth";
import { useTheme, type ThemePreference } from "@/context/theme";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function Section({
  label,
  colors,
  children,
}: {
  label: string;
  colors: Record<string, string>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: colors.secondaryText }]}>{label}</Text>
      <View style={[styles.card, { backgroundColor: colors.card }]}>{children}</View>
    </View>
  );
}

export default function Settings() {
  const { colors, preference, setPreference } = useTheme();
  const { signOut } = useAuth();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: "Settings" }} />

      <Section label="Appearance" colors={colors}>
        <View>
          {THEME_OPTIONS.map((option, index) => {
            const selected = option.value === preference;
            return (
              <Pressable
                key={option.value}
                onPress={() => setPreference(option.value)}
                style={[styles.optionRow, index > 0 && styles.optionRowBorder]}
              >
                <Text style={[styles.optionLabel, { color: colors.text }]}>{option.label}</Text>
                {selected && <Text style={[styles.checkmark, { color: colors.tint }]}>✓</Text>}
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section label="Account" colors={colors}>
        <Pressable onPress={() => signOut()} style={styles.optionRow}>
          <Text style={[styles.optionLabel, styles.signOutLabel]}>Sign out</Text>
        </Pressable>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { marginHorizontal: 16, marginTop: 20 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  card: { borderRadius: 12, overflow: "hidden" },
  optionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  optionRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.3)",
  },
  optionLabel: { fontSize: 16 },
  checkmark: { fontSize: 16, fontWeight: "600" },
  signOutLabel: { color: "#FF3B30", fontWeight: "600" },
});
