import { useEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";

import {
  createNewRecord,
  draftRecord,
  formatDuration,
  getOrCreateCurrentRecord,
  incrementEntry,
  resetTimerEntry,
  startTimerEntry,
  stopTimerEntry,
  todayDateString,
  toggleTimestampEntry,
  type TableRecord,
  type TimerEntryState,
} from "@/lib/entries";
import { getEntryLabel, type TableRow } from "@/lib/tables";

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

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function TableCard({
  table,
  record,
  recordCount,
  onMutate,
}: {
  table: TableRow;
  record: TableRecord | null;
  recordCount: number;
  onMutate: (tableId: string, record: TableRecord) => void;
}) {
  const [isBusy, setIsBusy] = useState(false);

  const isDaily = table.record_frequency === "daily";
  const isCurrent = !!record && (!isDaily || record.record_date === todayDateString());
  const current = isCurrent ? record : null;
  // Daily tables always show an open, interactive entry — even before any
  // real row exists — so the user can start adding data immediately. The
  // draft is purely client-side; getOrCreateCurrentRecord only creates the
  // real row on the first actual mutation below.
  const displayRecord = current ?? (isDaily ? draftRecord(table, record) : null);

  const anyRunning = !!displayRecord?.timer_state?.some((entry) => entry.running);
  useTicker(anyRunning);

  const runMutation = async (fn: (rec: TableRecord) => Promise<TableRecord>) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const base = await getOrCreateCurrentRecord(table, record);
      const updated = await fn(base);
      onMutate(table.table_id, updated);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const openRecord = async () => {
    if (isBusy) return;
    if (current) {
      router.push(`/table/${table.table_id}/record/${current.record_id}`);
      return;
    }
    setIsBusy(true);
    try {
      const ensured = await getOrCreateCurrentRecord(table, record);
      onMutate(table.table_id, ensured);
      router.push(`/table/${table.table_id}/record/${ensured.record_id}`);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  const createRecord = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const created = await createNewRecord(table, record);
      onMutate(table.table_id, created);
      router.push(`/table/${table.table_id}/record/${created.record_id}`);
    } catch (err) {
      reportError(err);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Pressable onPress={() => router.push(`/table/${table.table_id}`)}>
        <View style={styles.titleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {table.table_name ?? "Untitled table"}
          </Text>
          <Text style={styles.recordCount}>
            {recordCount} {recordCount === 1 ? "record" : "records"}
          </Text>
        </View>
        <Text style={styles.cardMeta}>
          {[
            table.entry_type && (ENTRY_TYPE_LABEL[table.entry_type] ?? table.entry_type),
            table.record_frequency &&
              (ENTRY_FREQUENCY_LABEL[table.record_frequency] ?? table.record_frequency),
            table.entry_unit,
          ]
            .filter(Boolean)
            .join(", ")}
        </Text>
      </Pressable>

      <RecordPreview
        table={table}
        record={displayRecord}
        isBusy={isBusy}
        onOpenRecord={openRecord}
        onCreateRecord={createRecord}
        onIncrement={(entryIndex, delta) =>
          runMutation((rec) => incrementEntry(rec, entryIndex, delta))
        }
        onToggleTimestamp={(entryIndex) =>
          runMutation((rec) => toggleTimestampEntry(rec, entryIndex))
        }
        onStartTimer={(entryIndex) => runMutation((rec) => startTimerEntry(rec, entryIndex))}
        onStopTimer={(entryIndex) => runMutation((rec) => stopTimerEntry(rec, entryIndex))}
        onResetTimer={(entryIndex) => runMutation((rec) => resetTimerEntry(rec, entryIndex))}
      />
    </View>
  );
}

function RecordPreview({
  table,
  record,
  isBusy,
  onOpenRecord,
  onCreateRecord,
  onIncrement,
  onToggleTimestamp,
  onStartTimer,
  onStopTimer,
  onResetTimer,
}: {
  table: TableRow;
  record: TableRecord | null;
  isBusy: boolean;
  onOpenRecord: () => void;
  onCreateRecord: () => void;
  onIncrement: (entryIndex: number, delta: number) => void;
  onToggleTimestamp: (entryIndex: number) => void;
  onStartTimer: (entryIndex: number) => void;
  onStopTimer: (entryIndex: number) => void;
  onResetTimer: (entryIndex: number) => void;
}) {
  const isAperiodic = table.record_frequency === "aperiodic";

  if (!record) {
    return (
      <View style={styles.previewRow}>
        <Pressable onPress={onOpenRecord} disabled={isBusy} style={styles.entryCard}>
          <Text style={styles.placeholderText}>No entries yet — tap to add</Text>
        </Pressable>
      </View>
    );
  }

  const count = table.record_entry_count ?? 1;
  const entryIndexes = Array.from({ length: count }, (_, i) => i);
  let content: ReactNode;

  if (table.entry_type === "string") {
    if (count <= 3) {
      content = (
        <Pressable onPress={onOpenRecord} disabled={isBusy} style={styles.stringList}>
          {entryIndexes.map((entryIndex) => {
            const value =
              typeof record.data[entryIndex] === "string" ? record.data[entryIndex] : null;
            return (
              <View key={entryIndex} style={styles.entryCard}>
                {count > 1 && (
                  <Text style={styles.entryLabel}>{getEntryLabel(table, entryIndex)}</Text>
                )}
                <Text style={styles.previewValue} numberOfLines={2}>
                  {value || "Tap to add"}
                </Text>
              </View>
            );
          })}
        </Pressable>
      );
    } else {
      const filled = record.data.filter((v) => typeof v === "string" && v.length > 0).length;
      content = (
        <Pressable onPress={onOpenRecord} disabled={isBusy} style={styles.entryCard}>
          <Text style={styles.previewValue}>
            {filled}/{count} logged
          </Text>
        </Pressable>
      );
    }
  } else if (table.entry_type === "numerical") {
    const value = typeof record.data[0] === "number" ? record.data[0] : null;
    content = (
      <View style={[styles.entryCard, styles.previewInlineRow]}>
        <Pressable onPress={onOpenRecord} disabled={isBusy}>
          <Text style={styles.previewValue}>
            {value != null
              ? `${value}${table.entry_unit ? ` ${table.entry_unit}` : ""}`
              : "Tap to add"}
          </Text>
        </Pressable>
        {table.is_incremental && (
          <Pressable
            onPress={() => onIncrement(0, 1)}
            disabled={isBusy}
            hitSlop={8}
            style={styles.incrementButton}
          >
            <Text style={styles.incrementButtonText}>+1</Text>
          </Pressable>
        )}
      </View>
    );
  } else if (table.entry_type === "duration") {
    if (count <= 2) {
      content = (
        <View style={styles.timerList}>
          {entryIndexes.map((entryIndex) => {
            const entry = record.timer_state?.[entryIndex];
            const seconds = entryElapsedSeconds(entry);
            const canReset = !!entry?.running || seconds > 0;
            return (
              <View key={entryIndex} style={styles.entryCard}>
                {count > 1 && (
                  <Text style={styles.entryLabel}>{getEntryLabel(table, entryIndex)}</Text>
                )}
                <View style={styles.timerRow}>
                  <Text style={styles.previewValue}>{formatDuration(seconds)}</Text>
                  <View style={styles.timerButtonGroup}>
                    <Pressable
                      onPress={() => onResetTimer(entryIndex)}
                      disabled={isBusy || !canReset}
                      hitSlop={8}
                      style={[styles.timerButton, !canReset && styles.timerButtonDisabled]}
                    >
                      <Text style={styles.timerButtonText}>Reset</Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        entry?.running ? onStopTimer(entryIndex) : onStartTimer(entryIndex)
                      }
                      disabled={isBusy}
                      hitSlop={8}
                      style={[styles.timerButton, entry?.running && styles.timerButtonActive]}
                    >
                      <Text style={styles.timerButtonText}>
                        {entry?.running ? "Stop" : "Start"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      );
    } else {
      const total = (record.timer_state ?? []).reduce(
        (sum, entry) => sum + entryElapsedSeconds(entry),
        0
      );
      content = (
        <Pressable onPress={onOpenRecord} disabled={isBusy} style={styles.entryCard}>
          <Text style={styles.previewValue}>
            {formatDuration(total)} total — tap to view timers
          </Text>
        </Pressable>
      );
    }
  } else if (table.entry_type === "timestamp") {
    if (count <= 4) {
      content = (
        <View style={[styles.entryCard, styles.checkpointList]}>
          {entryIndexes.map((entryIndex) => {
            const value = record.data[entryIndex];
            const ticked = value != null;
            return (
              <Pressable
                key={entryIndex}
                onPress={() => onToggleTimestamp(entryIndex)}
                disabled={isBusy}
                style={styles.checkpointRow}
              >
                <View style={styles.checkpointLeft}>
                  <View style={[styles.tickIcon, ticked && styles.tickIconActive]}>
                    <Text style={[styles.tickIconText, ticked && styles.tickIconTextActive]}>
                      {ticked ? "✓" : entryIndex + 1}
                    </Text>
                  </View>
                  <Text style={styles.checkpointLabel} numberOfLines={1}>
                    {getEntryLabel(table, entryIndex)}
                  </Text>
                </View>
                <Text style={styles.checkpointTime}>
                  {ticked ? formatClockTime(value as number) : "—"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      );
    } else {
      const done = record.data.filter((v) => v != null).length;
      content = (
        <Pressable onPress={onOpenRecord} disabled={isBusy} style={styles.entryCard}>
          <Text style={styles.previewValue}>
            {done}/{count} logged
          </Text>
        </Pressable>
      );
    }
  }

  return (
    <View style={styles.previewRow}>
      <View style={styles.previewContent}>{content}</View>
      {isAperiodic && (
        <Pressable
          onPress={onCreateRecord}
          disabled={isBusy}
          hitSlop={8}
          style={styles.addRecordButton}
        >
          <Text style={styles.addRecordButtonText}>+</Text>
        </Pressable>
      )}
      <Pressable onPress={onOpenRecord} disabled={isBusy} hitSlop={8} style={styles.chevronButton}>
        <Text style={styles.chevronText}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 16,
    backgroundColor: "rgba(120,120,128,0.12)",
    gap: 10,
  },
  titleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  cardTitle: { fontSize: 17, fontWeight: "600", flexShrink: 1 },
  recordCount: { fontSize: 12, color: "#8E8E93", flexShrink: 0 },
  cardMeta: { fontSize: 13, color: "#8E8E93", marginTop: 4 },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  previewContent: { flex: 1 },
  // Nested "card within a card" so the interactive entries stand out from
  // the table card's own background.
  entryCard: {
    backgroundColor: "rgba(120,120,128,0.20)",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  entryLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#8E8E93",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  placeholderText: { fontSize: 15, color: "#8E8E93" },
  previewValue: { fontSize: 16, fontWeight: "500" },
  previewInlineRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  incrementButton: {
    backgroundColor: "#208AEF",
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  incrementButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  stringList: { gap: 8 },
  timerList: { gap: 8 },
  timerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  timerButtonGroup: { flexDirection: "row", gap: 6 },
  timerButton: {
    backgroundColor: "rgba(120,120,128,0.16)",
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  timerButtonActive: { backgroundColor: "#FF3B30" },
  timerButtonDisabled: { opacity: 0.4 },
  timerButtonText: { fontSize: 13, fontWeight: "600" },
  checkpointList: { gap: 10 },
  checkpointRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  checkpointLeft: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 },
  checkpointLabel: { fontSize: 14, fontWeight: "500", flexShrink: 1 },
  checkpointTime: { fontSize: 13, color: "#8E8E93", marginLeft: 8 },
  tickIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.16)",
  },
  tickIconActive: { backgroundColor: "#208AEF" },
  tickIconText: { fontSize: 12, fontWeight: "600", color: "#8E8E93" },
  tickIconTextActive: { color: "#FFFFFF" },
  addRecordButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.16)",
  },
  addRecordButtonText: { fontSize: 18, color: "#208AEF", fontWeight: "600" },
  chevronButton: { paddingLeft: 2 },
  chevronText: { fontSize: 20, color: "#8E8E93" },
});
