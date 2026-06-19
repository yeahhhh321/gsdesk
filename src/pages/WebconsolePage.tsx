import { Button, Empty } from "antd";
import { Copy, ExternalLink, RefreshCcw } from "lucide-react";
import { PanelHeader, SectionActions } from "../ui/primitives";

interface WebconsolePageProps {
  webconsoleUrl: string;
  onRefreshFrame: () => void;
}

export default function WebconsolePage({ webconsoleUrl, onRefreshFrame }: WebconsolePageProps) {
  return (
    <section className="page-block">
      <PanelHeader
        title="WebConsole"
        description={webconsoleUrl || "Core 启动后加载 http://127.0.0.1:<port>/app"}
        actions={
          <SectionActions>
            <Button icon={<RefreshCcw size={16} />} onClick={onRefreshFrame} disabled={!webconsoleUrl}>
              刷新框架
            </Button>
            <Button icon={<Copy size={16} />} onClick={() => navigator.clipboard.writeText(webconsoleUrl)} disabled={!webconsoleUrl}>
              复制 URL
            </Button>
            <Button icon={<ExternalLink size={16} />} onClick={() => window.open(webconsoleUrl, "_blank")} disabled={!webconsoleUrl}>
              外部打开
            </Button>
          </SectionActions>
        }
      />
      {webconsoleUrl ? <iframe className="webconsole-frame" src={webconsoleUrl} title="GSDesk WebConsole" /> : <Empty description="Core 尚未启动" />}
    </section>
  );
}
