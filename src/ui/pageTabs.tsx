import type { ReactNode } from "react";

export function WidePanel({ children }: { children: ReactNode }) {
  return <div className="wide-panel">{children}</div>;
}
