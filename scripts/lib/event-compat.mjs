export function normalizeEventRecord(record) {
  if (!record || typeof record !== "object") return record;

  const eventType =
    typeof record.event_type === "string" && record.event_type.trim()
      ? record.event_type
      : typeof record.event === "string" && record.event.trim()
        ? record.event
        : undefined;

  if (!eventType) return record;
  return {
    ...record,
    event_type: eventType,
    event: eventType,
  };
}
