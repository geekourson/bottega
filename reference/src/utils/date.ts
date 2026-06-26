/**
 * Parse a SQLite UTC datetime string as UTC.
 *
 * SQLite's CURRENT_TIMESTAMP produces 'YYYY-MM-DD HH:MM:SS' with no timezone
 * marker. JavaScript's Date constructor treats bare datetime strings as local
 * time, causing a systematic offset equal to the local UTC offset.
 * Appending 'Z' forces UTC interpretation.
 */
export function parseSqliteUTC(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}
