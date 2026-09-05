import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";

import { useAuth } from "@/context/auth";
import { useTheme } from "@/context/theme";
import {
  deleteRecord,
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
import { getLocalRecord, getLocalTable } from "@/lib/localStore";
import { flushOutbox } from "@/lib/sync";
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

function EntryField({
  label,
  colors,
  children,
}: {
  label: string;
  colors: Record<string, string>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.entryField}>
      <Text style={[styles.entryFieldLabel, { color: colors.secondaryText }]}>{label}</Text>
      {children}
    </View>
  );
}

export default function RecordEdit() {
  const { id, recordId } = useLocalSearchParams<{ id: string; recordId: string }>();
  const { session } = useAuth();
  const { colors } = useTheme();
  const userId = session?.user.id;

  const [table, setTable] = useState<TableRow | null>(null);
  const [record, setRecord] = useState<TableRecord | null>(null);
  const [textValues, setTextValues] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const anyRunning = !!record?.timer_state?.some((entry) => entry.running);
  useTicker(anyRunning);

  const applyRecord = (freshRecord: TableRecord) => {
    setRecord(freshRecord);
    setTextValues(freshRecord.data.map((v) => (v == null ? "" : String(v))));
  };

  const load = useCallback(async () => {
    if (!id || !recordId || !userId) return;
    const numericRecordId = Number(recordId);
    try {
      // Instant paint from whatever's already known locally.
      const [localTable, localRecord] = await Promise.all([
        getLocalTable(userId, id),
        getLocalRecord(userId, numericRecordId),
      ]);
      if (localTable) setTable(localTable);
      if (localRecord) {
        applyRecord(localRecord);
        setIsLoading(false);
      }

      await flushOutbox(userId);
      await Promise.all([fetchTable(userId, id), fetchRecord(userId, numericRecordId)]);

      // Re-read from the local store rather than the raw fetch results —
      // fetchTable/fetchRecord skip overwriting a row with an unsynced local
      // edit pending, so the local store is the correct LWW-resolved view.
      const [reconciledTable, reconciledRecord] = await Promise.all([
        getLocalTable(userId, id),
        getLocalRecord(userId, numericRecordId),
      ]);
      if (reconciledTable) setTable(reconciledTable);
      if (reconciledRecord) applyRecord(reconciledRecord);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load record");
    } finally {
      setIsLoading(false);
    }
  }, [id, recordId, userId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleTextBlur = async (entryIndex: number) => {
    if (!record || !table || !userId) return;
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
      const updated = await setEntryValue(userId, record, entryIndex, value);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    }
  };

  // The native "Done" header button (Stack.Toolbar) lives outside React
  // Native's own responder tree, so tapping it doesn't reliably blur a
  // focused TextInput first — the per-field onBlur save can be skipped
  // entirely. Flush any unsaved text/numerical edits here before navigating
  // back, so Done always persists what's on screen regardless of blur timing.
  const handleDone = async () => {
    if (
      !record ||
      !table ||
      !userId ||
      (table.entry_type !== "string" && table.entry_type !== "numerical")
    ) {
      router.back();
      return;
    }
    let current = record;
    try {
      for (let entryIndex = 0; entryIndex < textValues.length; entryIndex++) {
        const { value, valid } = parseEntryValue(table.entry_type, textValues[entryIndex] ?? "");
        if (!valid || value === current.data[entryIndex]) continue;
        current = await setEntryValue(userId, current, entryIndex, value);
      }
      if (current !== record) setRecord(current);
    } catch (err) {
      reportError(err);
      return;
    }
    router.back();
  };

  const handleIncrement = async (entryIndex: number, delta: number) => {
    if (!record || !userId || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await incrementEntry(userId, record, entryIndex, delta);
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
    if (!record || !userId || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await toggleTimestampEntry(userId, record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartTimer = async (entryIndex: number) => {
    if (!record || !userId || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await startTimerEntry(userId, record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleStopTimer = async (entryIndex: number) => {
    if (!record || !userId || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await stopTimerEntry(userId, record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetTimer = async (entryIndex: number) => {
    if (!record || !userId || isBusy) return;
    setIsBusy(true);
    try {
      const updated = await resetTimerEntry(userId, record, entryIndex);
      setRecord(updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = () => {
    if (!record || !userId) return;
    Alert.alert("Delete record", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteRecord(userId, record.record_id);
            router.back();
          } catch (err) {
            reportError(err);
          }
        },
      },
    ]);
  };

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !table || !record) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={styles.error}>{error ?? "Record not found"}</Text>
      </View>
    );
  }

  const count = table.record_entry_count ?? 1;
  const entryIndexes = Array.from({ length: count }, (_, i) => i);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: table.table_name ?? "Record",
          ...(Platform.OS !== "ios" && {
            headerRight: () => (
              <Pressable onPress={handleDone} hitSlop={8}>
                <Text style={[styles.headerButtonText, styles.headerButtonStrong]}>Done</Text>
              </Pressable>
            ),
          }),
        }}
      />
      {Platform.OS === "ios" && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button variant="plain" tintColor="#208AEF" onPress={() => handleDone()}>
            Done
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {entryIndexes.map((entryIndex) => {
          const label = count > 1 ? getEntryLabel(table, entryIndex) : "Value";

          if (table.entry_type === "string") {
            return (
              <EntryField key={entryIndex} label={label} colors={colors}>
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
                  style={[
                    styles.textInput,
                    styles.multilineInput,
                    { backgroundColor: colors.card, color: colors.text },
                  ]}
                />
              </EntryField>
            );
          }

          if (table.entry_type === "numerical") {
            return (
              <EntryField key={entryIndex} label={label} colors={colors}>
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
                    style={[
                      styles.textInput,
                      styles.numericInput,
                      { backgroundColor: colors.card, color: colors.text },
                    ]}
                  />
                  {table.entry_unit && (
                    <Text style={[styles.unitText, { color: colors.secondaryText }]}>
                      {table.entry_unit}
                    </Text>
                  )}
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
              <EntryField key={entryIndex} label={label} colors={colors}>
                <View style={[styles.timerRow, { backgroundColor: colors.card }]}>
                  <Text style={[styles.timerValue, { color: colors.text }]}>
                    {formatDuration(seconds)}
                  </Text>
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
              <EntryField key={entryIndex} label={label} colors={colors}>
                <View style={[styles.timestampRow, { backgroundColor: colors.card }]}>
                  <Text style={[styles.timestampValue, { color: colors.text }]}>
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

        <Pressable onPress={handleDelete} style={styles.deleteButton}>
          <Text style={styles.deleteButtonText}>Delete record</Text>
        </Pressable>
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
  deleteButton: { marginTop: 16, alignItems: "center", paddingVertical: 12 },
  deleteButtonText: { fontSize: 16, color: "#FF3B30", fontWeight: "600" },
});
