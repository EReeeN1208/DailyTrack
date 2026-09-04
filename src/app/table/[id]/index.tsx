import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";

import { formatDuration, fetchRecords, createNewRecord, type TableRecord } from "@/lib/entries";
import {
  deleteTable,
  fetchTable,
  updateTable,
  type TableRow,
} from "@/lib/tables";

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

function summarizeRecord(table: TableRow, record: TableRecord): string {
  switch (table.entry_type) {
    case "string": {
      const value = typeof record.data[0] === "string" ? record.data[0] : null;
      return value || "(empty)";
    }
    case "numerical": {
      const value = typeof record.data[0] === "number" ? record.data[0] : null;
      return value != null ? `${value}${table.entry_unit ? ` ${table.entry_unit}` : ""}` : "(empty)";
    }
    case "duration": {
      const total = (record.timer_state ?? []).reduce(
        (sum, entry) => sum + (typeof entry?.base_seconds === "number" ? entry.base_seconds : 0),
        0
      );
      return formatDuration(total);
    }
    case "timestamp": {
      const done = record.data.filter((v) => v != null).length;
      return `${done}/${record.data.length} logged`;
    }
    default:
      return "";
  }
}

function sanitizeEntryName(text: string) {
  return text.replace(/,/g, "");
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

export default function TableMenu() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [table, setTable] = useState<TableRow | null>(null);
  const [records, setRecords] = useState<TableRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [tableName, setTableName] = useState("");
  const [tableDescription, setTableDescription] = useState("");
  const [entryUnit, setEntryUnit] = useState("");
  const [entryNames, setEntryNames] = useState<string[]>([]);
  const [isPublic, setIsPublic] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [freshTable, freshRecords] = await Promise.all([
        fetchTable(id),
        fetchRecords(id),
      ]);
      setTable(freshTable);
      setRecords(freshRecords.filter((r) => r.has_data));
      setTableName(freshTable.table_name ?? "");
      setTableDescription(freshTable.table_description ?? "");
      setEntryUnit(freshTable.entry_unit ?? "");
      setEntryNames(freshTable.record_entry_names?.split(",") ?? []);
      setIsPublic(!!freshTable.is_public);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load table");
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const entryCount = table?.record_entry_count ?? 1;
  const trimmedEntryNames = entryNames.slice(0, entryCount).map((n) => n.trim());
  const recordEntryNames =
    entryCount > 1 && trimmedEntryNames.some((n) => n.length > 0)
      ? trimmedEntryNames.join(",")
      : null;

  const isDirty =
    !!table &&
    (tableName.trim() !== (table.table_name ?? "") ||
      tableDescription.trim() !== (table.table_description ?? "") ||
      (table.entry_type !== "duration" && entryUnit.trim() !== (table.entry_unit ?? "")) ||
      recordEntryNames !== (table.record_entry_names ?? null) ||
      isPublic !== !!table.is_public);

  const handleEntryNameChange = (index: number, text: string) => {
    const sanitized = sanitizeEntryName(text);
    setEntryNames((prev) => {
      const next = [...prev];
      while (next.length <= index) next.push("");
      next[index] = sanitized;
      return next;
    });
  };

  const handleSave = async () => {
    if (!table || tableName.trim().length === 0) return;
    setIsSaving(true);
    try {
      const updated = await updateTable(table.table_id, {
        table_name: tableName.trim(),
        table_description: tableDescription.trim() ? tableDescription.trim() : null,
        entry_unit:
          table.entry_type === "duration" || !entryUnit.trim() ? null : entryUnit.trim(),
        record_entry_names: recordEntryNames,
        is_public: isPublic,
      });
      setTable(updated);
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to save table");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = () => {
    if (!table) return;
    Alert.alert(
      "Delete table",
      `Delete "${table.table_name ?? "this table"}" and all of its records? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteTable(table.table_id);
              router.back();
            } catch (err) {
              Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete table");
            }
          },
        },
      ]
    );
  };

  const handleCreateRecord = async () => {
    if (!table) return;
    try {
      const created = await createNewRecord(table, records[0] ?? null);
      router.push(`/table/${table.table_id}/record/${created.record_id}`);
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to create record");
    }
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !table) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error ?? "Table not found"}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: table.table_name ?? "Table",
          headerRight: () => (
            <Pressable onPress={handleSave} disabled={!isDirty || isSaving} hitSlop={8}>
              <Text
                style={[
                  styles.headerButtonText,
                  styles.headerButtonStrong,
                  (!isDirty || isSaving) && styles.headerButtonDisabled,
                ]}
              >
                Save
              </Text>
            </Pressable>
          ),
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: "Save",
              variant: "plain",
              hidesSharedBackground: true,
              tintColor: "#208AEF",
              disabled: !isDirty || isSaving,
              onPress: () => handleSave(),
            },
          ],
        }}
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Section label="Name">
          <TextInput
            value={tableName}
            onChangeText={setTableName}
            style={styles.textInput}
            autoCapitalize="words"
          />
        </Section>

        <Section label="Description">
          <TextInput
            value={tableDescription}
            onChangeText={setTableDescription}
            placeholder="Instructions etc..."
            placeholderTextColor="#8E8E93"
            multiline
            numberOfLines={3}
            style={[styles.textInput, styles.multilineInput]}
          />
        </Section>

        <Section label="Unit">
          <TextInput
            value={table.entry_type === "duration" ? "" : entryUnit}
            onChangeText={setEntryUnit}
            placeholder={
              table.entry_type === "duration"
                ? "Always recorded in hours/minutes/seconds"
                : "Optional, e.g. kg, minutes"
            }
            placeholderTextColor="#8E8E93"
            autoCapitalize="none"
            editable={table.entry_type !== "duration"}
            style={[styles.textInput, table.entry_type === "duration" && styles.textInputDisabled]}
          />
        </Section>

        <Section label="Visibility">
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Public</Text>
            <Switch value={isPublic} onValueChange={setIsPublic} />
          </View>
        </Section>

        <Section label="Configuration">
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Entry type</Text>
            <Text style={styles.infoValue}>
              {table.entry_type ? ENTRY_TYPE_LABEL[table.entry_type] ?? table.entry_type : "—"}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Frequency</Text>
            <Text style={styles.infoValue}>
              {table.record_frequency
                ? ENTRY_FREQUENCY_LABEL[table.record_frequency] ?? table.record_frequency
                : "—"}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Entries per record</Text>
            <Text style={styles.infoValue}>{table.record_entry_count ?? "—"}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Incremental</Text>
            <Text style={styles.infoValue}>{table.is_incremental ? "Yes" : "No"}</Text>
          </View>
        </Section>

        {entryCount > 1 && (
          <Section label="Entry names">
            <View style={styles.entryNameList}>
              {Array.from({ length: entryCount }, (_, i) => i).map((i) => (
                <TextInput
                  key={i}
                  placeholder={`Entry ${i + 1}`}
                  placeholderTextColor="#8E8E93"
                  value={entryNames[i] ?? ""}
                  onChangeText={(text) => handleEntryNameChange(i, text)}
                  style={styles.entryNameInput}
                />
              ))}
            </View>
          </Section>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>Records</Text>
            {table.record_frequency === "aperiodic" && (
              <Pressable onPress={handleCreateRecord} hitSlop={8}>
                <Text style={styles.addRecordText}>+ New record</Text>
              </Pressable>
            )}
          </View>
          {records.length === 0 ? (
            <Text style={styles.emptyText}>No records yet.</Text>
          ) : (
            <View style={styles.card}>
              {records.map((record, index) => (
                <Pressable
                  key={record.record_id}
                  onPress={() => router.push(`/table/${table.table_id}/record/${record.record_id}`)}
                  style={[styles.recordRow, index > 0 && styles.recordRowBorder]}
                >
                  <Text style={styles.recordDate}>
                    {record.record_date ?? new Date(record.created_at).toLocaleDateString()}
                  </Text>
                  <Text style={styles.recordValue} numberOfLines={1}>
                    {summarizeRecord(table, record)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <Pressable onPress={handleDelete} style={styles.deleteButton}>
          <Text style={styles.deleteButtonText}>Delete table</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  error: { color: "#FF3B30" },
  scrollContent: { padding: 16, paddingBottom: 48, gap: 4 },
  headerButtonText: { fontSize: 15, color: "#208AEF" },
  headerButtonStrong: { fontWeight: "600" },
  headerButtonDisabled: { opacity: 0.4 },
  section: { marginTop: 16 },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8E8E93",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  card: {
    backgroundColor: "rgba(120,120,128,0.12)",
    borderRadius: 12,
    padding: 14,
  },
  textInput: { fontSize: 16, padding: 0 },
  textInputDisabled: { color: "#8E8E93" },
  multilineInput: { minHeight: 70, textAlignVertical: "top" },
  entryNameList: { gap: 10 },
  entryNameInput: {
    fontSize: 16,
    backgroundColor: "rgba(120,120,128,0.16)",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  switchLabel: { fontSize: 16 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  infoLabel: { fontSize: 15, color: "#8E8E93" },
  infoValue: { fontSize: 15, fontWeight: "500" },
  addRecordText: { fontSize: 14, color: "#208AEF", fontWeight: "600" },
  emptyText: { fontSize: 14, color: "#8E8E93" },
  recordRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
  },
  recordRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.3)",
  },
  recordDate: { fontSize: 14, color: "#8E8E93" },
  recordValue: { fontSize: 14, fontWeight: "500", flexShrink: 1, marginLeft: 12 },
  deleteButton: { marginTop: 32, alignItems: "center", paddingVertical: 12 },
  deleteButtonText: { fontSize: 16, color: "#FF3B30", fontWeight: "600" },
});
