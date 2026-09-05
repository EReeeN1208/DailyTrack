import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";

import { useAuth } from "@/context/auth";
import { useTheme } from "@/context/theme";
import { formatDuration, fetchRecords, createNewRecord, type TableRecord } from "@/lib/entries";
import { getLocalRecords, getLocalTable } from "@/lib/localStore";
import { flushOutbox } from "@/lib/sync";
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

export default function TableMenu() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const { colors } = useTheme();
  const userId = session?.user.id;

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

  const applyTable = (freshTable: TableRow) => {
    setTable(freshTable);
    setTableName(freshTable.table_name ?? "");
    setTableDescription(freshTable.table_description ?? "");
    setEntryUnit(freshTable.entry_unit ?? "");
    setEntryNames(freshTable.record_entry_names?.split(",") ?? []);
    setIsPublic(!!freshTable.is_public);
  };

  const applyRecords = useCallback(
    (allRecords: Record<string, TableRecord>) => {
      setRecords(
        Object.values(allRecords)
          .filter((r) => r.table_id === id && r.has_data)
          .sort((a, b) => b.created_at - a.created_at)
      );
    },
    [id]
  );

  const load = useCallback(async () => {
    if (!id || !userId) return;
    try {
      // Instant paint from whatever's already known locally.
      const [localTable, localRecords] = await Promise.all([
        getLocalTable(userId, id),
        getLocalRecords(userId),
      ]);
      if (localTable) {
        applyTable(localTable);
        applyRecords(localRecords);
        setIsLoading(false);
      }

      await flushOutbox(userId);
      await Promise.all([fetchTable(userId, id), fetchRecords(userId, id)]);

      // Re-read from the local store rather than the raw fetch results —
      // fetchTable/fetchRecords skip overwriting rows with an unsynced local
      // edit pending, so the local store is the correct LWW-resolved view.
      const [reconciledTable, reconciledRecords] = await Promise.all([
        getLocalTable(userId, id),
        getLocalRecords(userId),
      ]);
      if (reconciledTable) applyTable(reconciledTable);
      applyRecords(reconciledRecords);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load table");
    } finally {
      setIsLoading(false);
    }
  }, [id, userId, applyRecords]);

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
    if (!table || !userId || tableName.trim().length === 0) return;
    setIsSaving(true);
    try {
      const updated = await updateTable(userId, table.table_id, {
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
    if (!table || !userId) return;
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
              await deleteTable(userId, table.table_id);
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
    if (!table || !userId) return;
    try {
      const created = await createNewRecord(userId, table);
      router.push(`/table/${table.table_id}/record/${created.record_id}`);
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to create record");
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !table) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={styles.error}>{error ?? "Table not found"}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          title: table.table_name ?? "Table",
          ...(Platform.OS !== "ios" && {
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
          }),
        }}
      />
      {Platform.OS === "ios" && (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            variant="plain"
            tintColor="#208AEF"
            disabled={!isDirty || isSaving}
            onPress={() => handleSave()}
          >
            Save
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Section label="Name" colors={colors}>
          <TextInput
            value={tableName}
            onChangeText={setTableName}
            style={[styles.textInput, { color: colors.text }]}
            autoCapitalize="words"
          />
        </Section>

        <Section label="Description" colors={colors}>
          <TextInput
            value={tableDescription}
            onChangeText={setTableDescription}
            placeholder="Instructions etc..."
            placeholderTextColor="#8E8E93"
            multiline
            numberOfLines={3}
            style={[styles.textInput, styles.multilineInput, { color: colors.text }]}
          />
        </Section>

        <Section label="Unit" colors={colors}>
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
            style={[
              styles.textInput,
              { color: table.entry_type === "duration" ? colors.secondaryText : colors.text },
            ]}
          />
        </Section>

        <Section label="Visibility" colors={colors}>
          <View style={styles.switchRow}>
            <Text style={[styles.switchLabel, { color: colors.text }]}>Public</Text>
            <Switch value={isPublic} onValueChange={setIsPublic} />
          </View>
        </Section>

        <Section label="Configuration" colors={colors}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Entry type</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {table.entry_type ? ENTRY_TYPE_LABEL[table.entry_type] ?? table.entry_type : "—"}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Frequency</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {table.record_frequency
                ? ENTRY_FREQUENCY_LABEL[table.record_frequency] ?? table.record_frequency
                : "—"}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Entries per record</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {table.record_entry_count ?? "—"}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Incremental</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {table.is_incremental ? "Yes" : "No"}
            </Text>
          </View>
        </Section>

        {entryCount > 1 && (
          <Section label="Entry names" colors={colors}>
            <View style={styles.entryNameList}>
              {Array.from({ length: entryCount }, (_, i) => i).map((i) => (
                <TextInput
                  key={i}
                  placeholder={`Entry ${i + 1}`}
                  placeholderTextColor="#8E8E93"
                  value={entryNames[i] ?? ""}
                  onChangeText={(text) => handleEntryNameChange(i, text)}
                  style={[styles.entryNameInput, { color: colors.text }]}
                />
              ))}
            </View>
          </Section>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionLabel, { color: colors.secondaryText }]}>Records</Text>
            {table.record_frequency === "aperiodic" && (
              <Pressable onPress={handleCreateRecord} hitSlop={8}>
                <Text style={styles.addRecordText}>+ New record</Text>
              </Pressable>
            )}
          </View>
          {records.length === 0 ? (
            <Text style={styles.emptyText}>No records yet.</Text>
          ) : (
            <View style={[styles.card, { backgroundColor: colors.card }]}>
              {records.map((record, index) => (
                <Pressable
                  key={record.record_id}
                  onPress={() => router.push(`/table/${table.table_id}/record/${record.record_id}`)}
                  style={[styles.recordRow, index > 0 && styles.recordRowBorder]}
                >
                  <Text style={styles.recordDate}>
                    {record.record_date ?? new Date(record.created_at).toLocaleDateString()}
                  </Text>
                  <Text
                    style={[styles.recordValue, { color: colors.text }]}
                    numberOfLines={1}
                  >
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
