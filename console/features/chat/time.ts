/** Event time in the verified terminal's timezone; malformed history gets no invented time. */
export function chatTime(ts: string, locale: string, timeZone?: string): { label: string; full: string; iso: string } | null {
  const at = new Date(ts);
  if (!Number.isFinite(at.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) };
  try {
    return { label: new Intl.DateTimeFormat(locale, options).format(at), full: new Intl.DateTimeFormat(locale, { ...options, second: '2-digit', timeZoneName: 'short' }).format(at), iso: at.toISOString() };
  } catch { return chatTime(ts, 'en', undefined); }
}
