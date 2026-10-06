import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

/**
 * Single source of truth for the enquiries list — shared by the Overview
 * (stats) and Enquiries (table) pages so they never show two different
 * snapshots of the same data.
 */
export function useEnquiries() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMessage, setErrorMessage] = useState("");

  const load = useCallback(async () => {
    setStatus("loading");
    const { data, error } = await supabase
      .from("enquiries")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }
    setRows(data ?? []);
    setStatus("ready");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = useCallback(async (id) => {
    const { error } = await supabase.from("enquiries").delete().eq("id", id);
    if (error) return { error };
    setRows((current) => current.filter((row) => row.id !== id));
    return { error: null };
  }, []);

  return { rows, status, errorMessage, reload: load, remove };
}
