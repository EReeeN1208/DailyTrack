import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";

import { useAuth } from "@/context/auth";
import { useTheme } from "@/context/theme";
import { createTable, type EntryFrequency, type EntryType } from "@/lib/tables";

// Fixed, compile-time-known sets — not fetched from the DB. These mirror the
// EntryType/EntryFrequency union types exactly (and the label maps below),
// so a network round-trip bought no real safety net: a backend enum change
// would need this file updated regardless. Fetching them was also the
// source of a real bug — a bad/empty response got cached and then kept
// reappearing (with no fields to pick) on every later visit that session.
const ENTRY_TYPE_OPTIONS: EntryType[] = ["string", "numerical", "duration", "timestamp"];
const ENTRY_FREQUENCY_OPTIONS: EntryFrequency[] = ["daily", "aperiodic"];

const ENTRY_TYPE_LABEL: Record<string, string> = {
  string: "Text",
  numerical: "Number",
  duration: "Duration",
  timestamp: "Timestamp",
};

const ENTRY_FREQUENCY_LABEL: Record<string, string> = {
  daily: "Daily",
  aperiodic: "As needed",
};

function minEntryCount(entryType: EntryType | null) {
  return entryType === "timestamp" ? 2 : 1;
}

// Duration is always incremental (start/stop totals across records) and
// string/timestamp never are — only numerical leaves it up to the user.
function incrementalLock(entryType: EntryType | null): boolean | null {
  if (entryType === "duration") return true;
  if (entryType === "string" || entryType === "timestamp") return false;
  return null;
}

function sanitizeEntryName(text: string) {
  return text.replace(/,/g, "");
}

function Section({
  label,
  required,
  footer,
  textColor,
  children,
}: {
  label: string;
  required?: boolean;
  footer?: string;
  textColor: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionLabel}>{label}</Text>
        {required && <Text style={styles.requiredLabel}>Required</Text>}
      </View>
      <View style={styles.card}>{children}</View>
      {footer && (
        <Text style={[styles.footerText, { color: "#8E8E93" }]}>{footer}</Text>
      )}
    </View>
  );
}

function ChoiceChips<T extends string>({
  options,
  value,
  labels,
  onChange,
  textColor,
}: {
  options: T[];
  value: T | null;
  labels: Record<string, string>;
  onChange: (value: T) => void;
  textColor: string;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const selected = option === value;
        return (
          <Pressable
            key={option}
            onPress={() => onChange(option)}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text
              style={[
                styles.chipText,
                { color: selected ? "#FFFFFF" : textColor },
              ]}
            >
              {labels[option] ?? option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function CreateTable() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  useFocusEffect(
    useCallback(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [])
  );

  // The ScrollView's very first mount, while the formSheet is still
  // animating in, sometimes ends up with its content rendered but
  // invisible (confirmed on-device: a plain View never has this problem,
  // and forcing a second ScrollView instance always fixes it). Remounting
  // it once, shortly after the sheet has settled, works around this
  // reliably. Native issue, not fixable from here.
  const [scrollViewSettled, setScrollViewSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setScrollViewSettled(true), 500);
    return () => clearTimeout(timer);
  }, []);

  const { colorScheme, colors } = useTheme();
  const textColor = colors.text;
  const backgroundColor = colors.background;

  const [tableName, setTableName] = useState("");
  const [entryType, setEntryType] = useState<EntryType | null>(ENTRY_TYPE_OPTIONS[0]);
  const [entryUnit, setEntryUnit] = useState("");
  const [entryFrequency, setEntryFrequency] = useState<EntryFrequency | null>(
    ENTRY_FREQUENCY_OPTIONS[0]
  );
  const [entryDataCount, setEntryDataCount] = useState("1");
  const [entryNames, setEntryNames] = useState<string[]>([]);
  const [isPublic, setIsPublic] = useState(false);
  const [isIncremental, setIsIncremental] = useState(false);
  const [tableDescription, setTableDescription] = useState("");

  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const [toastAnim] = useState(() => new Animated.Value(0));

  const dismissToast = () => {
    Animated.timing(toastAnim, {
      toValue: 0,
      duration: 150,
      useNativeDriver: true,
    }).start(() => setFormError(null));
  };

  useEffect(() => {
    if (!formError) return;
    Animated.timing(toastAnim, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(dismissToast, 3500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formError, toastAnim]);

  const trimmedName = tableName.trim();
  const nameMissing = trimmedName.length === 0;
  const entryTypeMissing = !entryType;
  const entryFrequencyMissing = !entryFrequency;
  const minCount = minEntryCount(entryType);
  const parsedCount = Number(entryDataCount);
  const countInvalid = !Number.isInteger(parsedCount) || parsedCount < minCount;
  const isFormValid =
    !nameMissing && !entryTypeMissing && !entryFrequencyMissing && !countInvalid;

  const handleEntryTypeChange = (value: EntryType) => {
    setEntryType(value);
    const min = minEntryCount(value);
    if (Number(entryDataCount) < min) setEntryDataCount(String(min));
  };

  const handleEntryNameChange = (index: number, text: string) => {
    const sanitized = sanitizeEntryName(text);
    setEntryNames((prev) => {
      const next = [...prev];
      while (next.length <= index) next.push("");
      next[index] = sanitized;
      return next;
    });
  };

  const handleCreate = async () => {
    setHasAttemptedSubmit(true);

    if (!isFormValid) {
      setFormError("Please fill in all required fields.");
      return;
    }
    if (!userId) return;

    const lock = incrementalLock(entryType);
    const trimmedNames = entryNames.slice(0, parsedCount).map((n) => n.trim());
    const recordEntryNames =
      parsedCount > 1 && trimmedNames.some((n) => n.length > 0)
        ? trimmedNames.join(",")
        : null;

    setFormError(null);
    setIsSubmitting(true);
    try {
      await createTable(userId, {
        table_name: trimmedName,
        entry_type: entryType!,
        entry_unit: entryType === "duration" || !entryUnit.trim() ? null : entryUnit.trim(),
        record_frequency: entryFrequency!,
        record_entry_count: parsedCount,
        record_entry_names: recordEntryNames,
        is_public: isPublic,
        is_incremental: lock ?? isIncremental,
        table_description: tableDescription.trim() ? tableDescription.trim() : null,
      });
      router.back();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create table"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: "New Table",
          ...(Platform.OS !== "ios" && {
            headerLeft: () => (
              <Pressable onPress={() => router.back()} hitSlop={8}>
                <Text style={styles.headerButtonText}>Cancel</Text>
              </Pressable>
            ),
            headerRight: () => (
              <Pressable onPress={handleCreate} disabled={isSubmitting} hitSlop={8}>
                <Text
                  style={[
                    styles.headerButtonText,
                    styles.headerButtonStrong,
                    isSubmitting && styles.headerButtonDisabled,
                  ]}
                >
                  Create
                </Text>
              </Pressable>
            ),
          }),
        }}
      />
      {Platform.OS === "ios" && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button variant="plain" tintColor="#208AEF" onPress={() => router.back()}>
              Cancel
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button
              variant="plain"
              tintColor="#208AEF"
              disabled={isSubmitting}
              onPress={() => handleCreate()}
            >
              Create
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      )}

      <ScrollView
        key={scrollViewSettled ? "settled" : "initial"}
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={{ paddingTop: 60, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Section
          label="Name"
          required={hasAttemptedSubmit && nameMissing}
          textColor={textColor}
        >
          <TextInput
            placeholder="e.g. Water intake"
            placeholderTextColor="#8E8E93"
            value={tableName}
            onChangeText={setTableName}
            autoCapitalize="words"
            style={[styles.textInput, { color: textColor }]}
          />
        </Section>

        <Section
          label="Entry Type"
          required={hasAttemptedSubmit && entryTypeMissing}
          textColor={textColor}
        >
          <ChoiceChips
            options={ENTRY_TYPE_OPTIONS}
            value={entryType}
            labels={ENTRY_TYPE_LABEL}
            onChange={handleEntryTypeChange}
            textColor={textColor}
          />
        </Section>

        <Section
          label="Unit"
          textColor={textColor}
          footer={
            entryType === "duration"
              ? "Duration is always recorded in hours/minutes/seconds."
              : undefined
          }
        >
          <TextInput
            placeholder="Optional, e.g. kg, minutes"
            placeholderTextColor="#8E8E93"
            value={entryType === "duration" ? "" : entryUnit}
            onChangeText={setEntryUnit}
            autoCapitalize="none"
            editable={entryType !== "duration"}
            style={[
              styles.textInput,
              { color: entryType === "duration" ? "#8E8E93" : textColor },
            ]}
          />
        </Section>

        <Section label="Description" textColor={textColor}>
          <TextInput
            placeholder="Instructions etc..."
            placeholderTextColor="#8E8E93"
            value={tableDescription}
            onChangeText={setTableDescription}
            multiline
            numberOfLines={3}
            style={[styles.textInput, styles.multilineInput, { color: textColor }]}
          />
        </Section>

        <Section
          label="Increment"
          textColor={textColor}
          footer={
            entryType === "duration"
              ? "Duration entries are always incremental — start/stop keeps adding to the running total."
              : entryType === "numerical"
                ? "Enable incrementation on top of most recent entry"
                : "Only available for numerical and duration tables."
          }
        >
          <View style={styles.switchRow}>
            <Text style={[styles.switchLabel, { color: textColor }]}>
              Incremental
            </Text>
            <Switch
              value={incrementalLock(entryType) ?? isIncremental}
              onValueChange={setIsIncremental}
              disabled={incrementalLock(entryType) !== null}
            />
          </View>
        </Section>

        <Section
          label="Frequency"
          required={hasAttemptedSubmit && entryFrequencyMissing}
          textColor={textColor}
        >
          <ChoiceChips
            options={ENTRY_FREQUENCY_OPTIONS}
            value={entryFrequency}
            labels={ENTRY_FREQUENCY_LABEL}
            onChange={setEntryFrequency}
            textColor={textColor}
          />
        </Section>

        <Section
          label="Entries per record"
          required={hasAttemptedSubmit && countInvalid}
          textColor={textColor}
          footer={
            entryType === "timestamp"
              ? "Timestamp tables need at least 2 entries per record."
              : "Minimum of 1 entry per record."
          }
        >
          <TextInput
            placeholder="1"
            placeholderTextColor="#8E8E93"
            value={entryDataCount}
            onChangeText={setEntryDataCount}
            keyboardType="number-pad"
            style={[styles.textInput, { color: textColor }]}
          />
        </Section>

        {parsedCount > 1 && (
          <Section
            label="Entry names"
            textColor={textColor}
            footer="Optional. Names each entry within a record, e.g. 'Wake up', 'Lunch'. Commas aren't allowed."
          >
            <View style={styles.entryNameList}>
              {Array.from({ length: parsedCount }, (_, i) => i).map((i) => (
                <TextInput
                  key={i}
                  placeholder={`Entry ${i + 1}`}
                  placeholderTextColor="#8E8E93"
                  value={entryNames[i] ?? ""}
                  onChangeText={(text) => handleEntryNameChange(i, text)}
                  style={[styles.textInput, styles.entryNameInput, { color: textColor }]}
                />
              ))}
            </View>
          </Section>
        )}

        <Section label="Visibility" textColor={textColor}>
          <View style={styles.switchRow}>
            <Text style={[styles.switchLabel, { color: textColor }]}>
              Public
            </Text>
            <Switch value={isPublic} onValueChange={setIsPublic} />
          </View>
        </Section>
      </ScrollView>

      {formError && (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.toastContainer, { paddingBottom: insets.bottom + 12 }]}
        >
          <Pressable onPress={dismissToast}>
            <Animated.View
              style={[
                styles.toastCard,
                {
                  backgroundColor: colorScheme === "dark" ? "#1C1C1E" : "#FFFFFF",
                  opacity: toastAnim,
                  transform: [
                    {
                      translateY: toastAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [16, 0],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Text style={[styles.toastText, { color: textColor }]}>
                {formError}
              </Text>
            </Animated.View>
          </Pressable>
        </Animated.View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  headerButtonText: { fontSize: 15, color: "#208AEF" },
  headerButtonStrong: { fontWeight: "600" },
  headerButtonDisabled: { opacity: 0.4 },
  section: { marginHorizontal: 16, marginTop: 20 },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8E8E93",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  requiredLabel: { fontSize: 12, fontWeight: "600", color: "#FF3B30" },
  card: {
    backgroundColor: "rgba(120,120,128,0.12)",
    borderRadius: 12,
    padding: 14,
  },
  footerText: { fontSize: 12, marginTop: 6, paddingHorizontal: 4 },
  textInput: { fontSize: 16, padding: 0 },
  multilineInput: { minHeight: 70, textAlignVertical: "top" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "rgba(120,120,128,0.16)",
  },
  chipSelected: { backgroundColor: "#208AEF" },
  chipText: { fontSize: 14, fontWeight: "500" },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  switchLabel: { fontSize: 16 },
  entryNameList: { gap: 10 },
  entryNameInput: {
    backgroundColor: "rgba(120,120,128,0.16)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  toastContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
  },
  toastCard: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  toastText: { fontSize: 14, lineHeight: 19 },
});
