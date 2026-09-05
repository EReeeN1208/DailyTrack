import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Appearance,
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
import { readCache, writeCache } from "@/lib/cache";
import {
  createTable,
  fetchEnumValues,
  type EntryFrequency,
  type EntryType,
} from "@/lib/tables";

const ENTRY_TYPE_CACHE_KEY = "dailytrack:cache:entry_type_options";
const ENTRY_FREQUENCY_CACHE_KEY = "dailytrack:cache:entry_frequency_options";

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

  const [colorScheme, setColorScheme] = useState<"light" | "dark">(() =>
    Appearance.getColorScheme() === "dark" ? "dark" : "light"
  );

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme: scheme }) => {
      setColorScheme(scheme === "dark" ? "dark" : "light");
    });
    return () => subscription.remove();
  }, []);

  const textColor = colorScheme === "dark" ? "#FFFFFF" : "#000000";
  const backgroundColor = colorScheme === "dark" ? "#000000" : "#FFFFFF";

  const [entryTypeOptions, setEntryTypeOptions] = useState<EntryType[]>([]);
  const [entryFrequencyOptions, setEntryFrequencyOptions] = useState<
    EntryFrequency[]
  >([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tableName, setTableName] = useState("");
  const [entryType, setEntryType] = useState<EntryType | null>(null);
  const [entryUnit, setEntryUnit] = useState("");
  const [entryFrequency, setEntryFrequency] = useState<EntryFrequency | null>(
    null
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

  useEffect(() => {
    (async () => {
      // Hydrate instantly from the on-device cache so the form is usable
      // offline, before the network round-trip below even has a chance to run.
      const [cachedTypes, cachedFrequencies] = await Promise.all([
        readCache<EntryType[]>(ENTRY_TYPE_CACHE_KEY),
        readCache<EntryFrequency[]>(ENTRY_FREQUENCY_CACHE_KEY),
      ]);
      if (cachedTypes?.length && cachedFrequencies?.length) {
        setEntryTypeOptions(cachedTypes);
        setEntryFrequencyOptions(cachedFrequencies);
        setEntryType(cachedTypes[0]);
        setEntryFrequency(cachedFrequencies[0]);
        setIsLoadingOptions(false);
      }

      try {
        const [types, frequencies] = await Promise.all([
          fetchEnumValues("entry_type"),
          fetchEnumValues("entry_frequency"),
        ]);
        setEntryTypeOptions(types as EntryType[]);
        setEntryFrequencyOptions(frequencies as EntryFrequency[]);
        setEntryType((types[0] as EntryType) ?? null);
        setEntryFrequency((frequencies[0] as EntryFrequency) ?? null);
        writeCache(ENTRY_TYPE_CACHE_KEY, types);
        writeCache(ENTRY_FREQUENCY_CACHE_KEY, frequencies);
      } catch (err) {
        // Offline or the request failed — fall back to the cached options
        // hydrated above; only surface a hard error when there's no cache.
        if (!cachedTypes?.length || !cachedFrequencies?.length) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load form options"
          );
        }
      } finally {
        setIsLoadingOptions(false);
      }
    })();
  }, []);

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
              <Pressable
                onPress={handleCreate}
                disabled={isSubmitting || isLoadingOptions}
                hitSlop={8}
              >
                <Text
                  style={[
                    styles.headerButtonText,
                    styles.headerButtonStrong,
                    (isSubmitting || isLoadingOptions) && styles.headerButtonDisabled,
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
              disabled={isSubmitting || isLoadingOptions}
              onPress={() => handleCreate()}
            >
              Create
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      )}

      {isLoadingOptions ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : loadError ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{loadError}</Text>
        </View>
      ) : (
        <ScrollView
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
              options={entryTypeOptions}
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
              options={entryFrequencyOptions}
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
      )}

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
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { color: "#FF3B30" },
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
