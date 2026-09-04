import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";

import {
  fetchRecord,
  formatDuration,
  incrementEntry,
  resetTimerEntry,
  setEntryValue,
  startTimerEntry,
  stopTimerEntry,
  toggleTimestampEntry,
  type TableRecord,
  type TimerEntryState,
} from "@/lib/entries";
import { fetchTable, getEntryLabel, type TableRow } from "@/lib/tables";

function parseEntryValue(
  entryType: TableRow["entry_type"],
  raw: string
): { value: string | number | null; valid: boolean } {
  const trimmed = raw.trim();
  if (entryType === "numerical") {
    if (trimmed.length === 0) return { value: null, valid: true };
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) return { value: null, valid: false };
    return { value: parsed, valid: true };
  }
  return { value: trimmed.length === 0 ? null : raw, valid: true };
}

function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

function entryElapsedSeconds(entry?: TimerEntryState): number {
  if (!entry) return 0;
  if (entry.running && entry.started_at != null) {
    return entry.base_seconds + (Date.now() - entry.started_at) / 1000;
  }
  return entry.base_seconds;
}

function reportError(err: unknown) {
  Alert.alert("Error", err instanceof Error ? err.message : "Something went wrong");
}

function EntryField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.entryField}>
      <Text style={styles.entryFieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

export default function RecordEdit() {
  const { id, recordId } = useLocalSearchParams<{ id: string; recordId: string }>();

  const [table, setTable] = useState<TableRow | null>(null);
  const [record, setRecord] = useState<TableRecord | null>(null);
  const [textValues, setTextValues] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const anyRunning = !!record?.timer_state?.some((entry) => entry.running);
  useTicker(anyRunning);

  const load = useCallback(async () => {
    if (!id || !recordId) return;
    try {
      const [freshTable, freshRecord] = await Promise.all([
        fetchTable(id),
        fetchRecord(Number(recordId)),
      ]);
      setTable(freshTable);
      setRecord(freshRecord);
      setTextValues(freshRecord.data.map((v) => (v == null ? "" : String(v))));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load record");
    } finally {
      setIsLoading(false);
    }
  }, [id, recordId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleTextBlur = async (entryIndex: number) => {
    if (!record || !table) return;
    const raw = textValues[entryIndex] ?? "";
    const { value, valid } = parseEntryValue(table.entry_type, raw);
    if (!valid) {
      // revert to the last saved value rather than persisting garbage
      setTextValues((prev) => {
        const next = [...prev];
        const current = record.data[entryIndex];
        next[entryIndex] = current == null ? "" : String(current);
        return next;
      });
      return;
    }

    if (value === record.data[entryIndex]) return;
    try {
      const updated = await setEntryValue(record, entryIndex, value);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    }
  };

  // The native "Done" header button (unstable_headerRightItems) lives outside
  // React Native's own responder tree, so tapping it doesn't reliably blur a
  // focused TextInput first — the per-field onBlur save can be skipped
  // entirely. Flush any unsaved text/numerical edits here before navigating
  // back, so Done always persists what's on screen regardless of blur timing.
  const handleDone = async () => {
    if (!record || !table || (table.entry_type !== "string" && table.entry_type !== "numerical")) {
      router.back();
      return;
    }
    let current = record;
    try {
      for (let entryIndex = 0; entryIndex < textValues.length; entryIndex++) {
        const { value, valid } = parseEntryValue(table.entry_type, textValues[entryIndex] ?? "");
        if (!valid || value === current.data[entryIndex]) continue;
        current = await setEntryValue(current, entryIndex, value);
      }
      if (current !== record) setRecord(current);
    } catch (err) {
      reportError(err);
      return;
    }
    router.back();
  };

  const handleIncrement = async (entryIndex: number, delta: number) => {
    if (!record || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await incrementEntry(record, entryIndex, delta);
      setRecord(updated);
      setTextValues((prev) => {
        const next = [...prev];
        next[entryIndex] = String(updated.data[entryIndex] ?? "");
        return next;
      });
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleToggleTimestamp = async (entryIndex: number) => {
    if (!record || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await toggleTimestampEntry(record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartTimer = async (entryIndex: number) => {
    if (!record || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await startTimerEntry(record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleStopTimer = async (entryIndex: number) => {
    if (!record || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await stopTimerEntry(record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetTimer = async (entryIndex: number) => {
    if (!record || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await resetTimerEntry(record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !table || !record) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error ?? "Record not found"}</Text>
      </View>
    );
  }

  const count = table.record_entry_count ?? 1;
  const entryIndexes = Array.from({ length: count }, (_, i) => i);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: table.table_name ?? "Record",
          headerRight: () => (
            <Pressable onPress={handleDone} hitSlop={8}>
              <Text style={[styles.headerButtonText, styles.headerButtonStrong]}>Done</Text>
            </Pressable>
          ),
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: "Done",
              variant: "plain",
              hidesSharedBackground: true,
              tintColor: "#208AEF",
              onPress: () => handleDone(),
            },
          ],
        }}
      />
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {entryIndexes.map((entryIndex) => {
          const label = count > 1 ? getEntryLabel(table, entryIndex) : "Value";

          if (table.entry_type === "string") {
            return (
              <EntryField key={entryIndex} label={label}>
                <TextInput
                  value={textValues[entryIndex] ?? ""}
                  onChangeText={(text) =>
                    setTextValues((prev) => {
                      const next = [...prev];
                      next[entryIndex] = text;
                      return next;
                    })
                  }
                  onBlur={() => handleTextBlur(entryIndex)}
                  multiline
                  style={[styles.textInput, styles.multilineInput]}
                />
              </EntryField>
            );
          }

          if (table.entry_type === "numerical") {
            return (
              <EntryField key={entryIndex} label={label}>
                <View style={styles.numericRow}>
                  <TextInput
                    value={textValues[entryIndex] ?? ""}
                    onChangeText={(text) =>
                      setTextValues((prev) => {
                        const next = [...prev];
                        next[entryIndex] = text;
                        return next;
                      })
                    }
                    onBlur={() => handleTextBlur(entryIndex)}
                    keyboardType="decimal-pad"
                    style={[styles.textInput, styles.numericInput]}
                  />
                  {table.entry_unit && <Text style={styles.unitText}>{table.entry_unit}</Text>}
                  {table.is_incremental && (
                    <Pressable
                      onPress={() => handleIncrement(entryIndex, 1)}
                      disabled={isBusy}
                      style={styles.incrementButton}
                    >
                      <Text style={styles.incrementButtonText}>+1</Text>
                    </Pressable>
                  )}
                </View>
              </EntryField>
            );
          }

          if (table.entry_type === "duration") {
            const entry = record.timer_state?.[entryIndex];
            const seconds = entryElapsedSeconds(entry);
            const canReset = !!entry?.running || seconds > 0;
            return (
              <EntryField key={entryIndex} label={label}>
                <View style={styles.timerRow}>
                  <Text style={styles.timerValue}>{formatDuration(seconds)}</Text>
                  <View style={styles.timerButtonGroup}>
                    <Pressable
                      onPress={() => handleResetTimer(entryIndex)}
                      disabled={isBusy || !canReset}
                      style={[styles.timerButton, !canReset && styles.timerButtonDisabled]}
                    >
                      <Text style={styles.timerButtonText}>Reset</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        entry?.running ? handleStopTimer(entryIndex) : handleStartTimer(entryIndex)
                      }
                      disabled={isBusy}
                      style={[styles.timerButton, entry?.running && styles.timerButtonActive]}
                    >
                      <Text style={styles.timerButtonText}>{entry?.running ? "Stop" : "Start"}</Text>
                    </Pressable>
                  </View>
                </View>
              </EntryField>
            );
          }

          if (table.entry_type === "timestamp") {
            const value = record.data[entryIndex];
            const ticked = value != null;
            return (
              <EntryField key={entryIndex} label={label}>
                <View style={styles.timestampRow}>
                  <Text style={styles.timestampValue}>
                    {ticked ? new Date(value as number).toLocaleString() : "Not yet"}
                  </Text>
                  <Pressable
                    onPress={() => handleToggleTimestamp(entryIndex)}
                    disabled={isBusy}
                    style={[styles.tickButton, ticked && styles.tickButtonActive]}
                  >
                    <Text style={[styles.tickButtonText, ticked && styles.tickButtonTextActive]}>
                      {ticked ? "Clear" : "Log now"}
                    </Text>
                  </Pressable>
                </View>
              </EntryField>
            );
          }

          return null;
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { color: "#FF3B30" },
  headerButtonText: { fontSize: 15, color: "#208AEF" },
  headerButtonStrong: { fontWeight: "600" },
  scrollContent: { padding: 16, paddingTop: 80, paddingBottom: 48, gap: 16 },
  entryField: { gap: 8 },
  entryFieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8E8E93",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  textInput: {
    fontSize: 16,
    backgroundColor: "rgba(120,120,128,0.12)",
    borderRadius: 12,
    padding: 14,
  },
  multilineInput: { minHeight: 70, textAlignVertical: "top" },
  numericRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  numericInput: { flex: 1 },
  unitText: { fontSize: 15, color: "#8E8E93" },
  incrementButton: {
    backgroundColor: "#208AEF",
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  incrementButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  timerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(120,120,128,0.12)",
    borderRadius: 12,
    padding: 14,
  },
  timerValue: { fontSize: 18, fontWeight: "600" },
  timerButtonGroup: { flexDirection: "row", gap: 8 },
  timerButton: {
    backgroundColor: "rgba(120,120,128,0.16)",
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  timerButtonActive: { backgroundColor: "#FF3B30" },
  timerButtonDisabled: { opacity: 0.4 },
  timerButtonText: { fontSize: 15, fontWeight: "600" },
  timestampRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(120,120,128,0.12)",
    borderRadius: 12,
    padding: 14,
  },
  timestampValue: { fontSize: 15, flexShrink: 1 },
  tickButton: {
    backgroundColor: "rgba(120,120,128,0.16)",
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  tickButtonActive: { backgroundColor: "#208AEF" },
  tickButtonText: { fontSize: 15, fontWeight: "600" },
  tickButtonTextActive: { color: "#FFFFFF" },
});
