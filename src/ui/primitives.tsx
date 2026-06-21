import { Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";

const { Text, Title } = Typography;

export function PanelHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="panel-title-row">
      <div className="panel-title-copy">
        <Title level={4}>{title}</Title>
        {description && <Text type="secondary">{description}</Text>}
      </div>
      {actions && <div className="panel-title-actions">{actions}</div>}
    </div>
  );
}

export function SectionActions({ children }: { children: ReactNode }) {
  return (
    <Space wrap className="section-actions">
      {children}
    </Space>
  );
}

export function ResultTag({ ok }: { ok: boolean }) {
  return <Tag color={ok ? "success" : "error"}>{ok ? "可用" : "失败"}</Tag>;
}
