import { supabase } from "@/lib/supabase";

export type EntryType = "string" | "numerical" | "duration" | "timestamp";
export type EntryFrequency = "daily" | "aperiodic";

export type TableRow = {
  table_id: string;
  user_id: string | null;
  created_at: number | null;
  updated_at: number | null;
  is_public: boolean | null;
  entry_type: EntryType | null;
  entry_unit: string | null;
  record_frequency: EntryFrequency | null;
  table_name: string | null;
  record_entry_count: number | null;
  record_entry_names: string | null;
  is_incremental: boolean | null;
  table_description: string | null;
};

// record_entry_names is stored as a flat comma-separated string, positionally
// aligned with each entry's index (an empty segment means that entry has no
// custom name yet) — falls back to "Entry N" wherever a name is blank.
export function getEntryLabel(table: TableRow, entryIndex: number): string {
  const names = table.record_entry_names ? table.record_entry_names.split(",") : [];
  const name = names[entryIndex]?.trim();
  return name || `Entry ${entryIndex + 1}`;
}

export async function fetchTables(): Promise<TableRow[]> {
  const { data, error } = await supabase
    .from("table")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function fetchTable(tableId: string): Promise<TableRow> {
  const { data, error } = await supabase
    .from("table")
    .select("*")
    .eq("table_id", tableId)
    .single();
  if (error) throw error;
  return data;
}

export async function fetchEnumValues(
  enumName: "entry_type" | "entry_frequency"
): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_enum_values", {
    enum_name: enumName,
  });
  if (error) throw error;
  return data ?? [];
}

export type CreateTableInput = {
  table_name: string;
  entry_type: EntryType;
  entry_unit: string | null;
  record_frequency: EntryFrequency;
  record_entry_count: number;
  record_entry_names: string | null;
  is_public: boolean;
  is_incremental: boolean;
  table_description: string | null;
};

export async function createTable(input: CreateTableInput): Promise<TableRow> {
  const now = Date.now();
  const { data, error } = await supabase
    .from("table")
    .insert({
      table_name: input.table_name,
      entry_type: input.entry_type,
      entry_unit: input.entry_unit,
      record_frequency: input.record_frequency,
      record_entry_count: input.record_entry_count,
      record_entry_names: input.record_entry_names,
      is_public: input.is_public,
      is_incremental: input.is_incremental,
      table_description: input.table_description,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export type UpdateTableInput = {
  table_name?: string;
  table_description?: string | null;
  entry_unit?: string | null;
  record_entry_names?: string | null;
  is_public?: boolean;
};

export async function updateTable(
  tableId: string,
  patch: UpdateTableInput
): Promise<TableRow> {
  const { data, error } = await supabase
    .from("table")
    .update({ ...patch, updated_at: Date.now() })
    .eq("table_id", tableId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteTable(tableId: string): Promise<void> {
  const { error } = await supabase.from("table").delete().eq("table_id", tableId);
  if (error) throw error;
}
