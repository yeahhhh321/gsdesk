import type { Settings } from "../types";

export function isBeginnerMode(settings?: Pick<Settings, "beginnerMode">) {
  return settings?.beginnerMode !== false;
}
