export function displayText(value: string | null | undefined, fallback = "-") {
  if (value === null || value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

export function displayNumber(value: number | null | undefined, fallback = "-") {
  return value === null || value === undefined ? fallback : String(value);
}

export function displayValue(value: unknown, fallback = "-") {
  if (typeof value === "string") return displayText(value, fallback);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function displayMilliseconds(value: number | null | undefined, fallback = "-") {
  return value === null || value === undefined ? fallback : `${value}ms`;
}

export function displaySecondsFromMilliseconds(value: number | null | undefined, fallback = "-") {
  return value === null || value === undefined ? fallback : `${Math.round(value / 1000)}s`;
}

export function displayMegabytesPerSecond(value: number | null | undefined, fallback = "-") {
  return value === null || value === undefined ? fallback : `${value.toFixed(2)} MB/s`;
}

export function displayBytes(value: number | null | undefined, fallback = "-") {
  if (value === null || value === undefined) return fallback;
  if (value < 1024) return `${value} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MB`;
  const gib = mib / 1024;
  return `${gib.toFixed(1)} GB`;
}

export function firstText(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const displayed = displayText(value, "");
    if (displayed.length) return displayed;
  }
  return undefined;
}
