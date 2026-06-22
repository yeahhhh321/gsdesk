import { Alert, Button, Space, Steps, Typography } from "antd";
import { useEffect } from "react";
import { Play, X } from "lucide-react";
import { buildGuideSteps, type GuideAction, type GuideStep, type InstallGuideProps } from "./installGuideSteps";

const { Text, Title } = Typography;

export function InstallGuide(props: InstallGuideProps) {
  const { open, activeStep, loadingAction, setupRunning, onClose, onStepChange, onRunAll } = props;
  const steps = buildGuideSteps(props);
  const current = clampStep(activeStep, steps.length);
  const step = steps[current];
  const runningTask = props.appState?.taskHistory.find((task) => task.status === "running");

  useEffect(() => {
    if (!open) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="install-guide-overlay" role="dialog" aria-modal="true" aria-label="首次安装引导" data-testid="install-guide">
      <div className="install-guide-panel">
        <div className="install-guide-header">
          <Title level={4}>首次安装引导</Title>
          <Button
            type="text"
            icon={<X size={18} />}
            onClick={onClose}
            aria-label="关闭首次安装引导"
            data-testid="install-guide-close"
          />
        </div>
        <div className="install-guide-scroll">
          <div className="install-guide-body">
            <div className="guide-run-all">
              <div>
                <strong>一键初始化</strong>
                <Text type="secondary">自动测速源码源和 PyPI 镜像，然后初始化运行时、启动 Core、打开 WebConsole。</Text>
              </div>
              <Button
                type="primary"
                icon={<Play size={16} />}
                loading={setupRunning}
                disabled={Boolean(loadingAction)}
                onClick={onRunAll}
              >
                一键安装启动
              </Button>
            </div>
            {runningTask && (
              <Alert
                type="info"
                showIcon
                title={`当前任务：${runningTask.name} / ${runningTask.stage}`}
                description={runningTask.message}
              />
            )}
            <Steps
              current={current}
              size="small"
              items={steps.map((item, index) => ({
                title: item.title,
                status: stepStatus(current, index, item),
              }))}
              onChange={onStepChange}
              orientation="horizontal"
              responsive={false}
              className="install-steps"
            />
            <div className="guide-action-panel">{step.content}</div>
          </div>
        </div>
        <GuideFooter
          current={current}
          loadingAction={loadingAction}
          primary={step.primary}
          secondary={step.secondary}
          onStepChange={onStepChange}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function GuideFooter({
  current,
  loadingAction,
  primary,
  secondary,
  onStepChange,
  onClose,
}: {
  current: number;
  loadingAction?: string;
  primary: GuideAction;
  secondary?: GuideAction;
  onStepChange: (step: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="guide-footer">
      <Button onClick={onClose} data-testid="install-guide-dismiss">
        稍后再说
      </Button>
      <Space wrap>
        {secondary && (
          <Button icon={secondary.icon} onClick={secondary.onClick} data-testid="install-guide-secondary">
            {secondary.label}
          </Button>
        )}
        <Button disabled={current === 0} onClick={() => onStepChange(current - 1)} data-testid="install-guide-prev">
          上一步
        </Button>
        <Button
          type="primary"
          icon={primary.icon}
          loading={Boolean(primary.loadingKey && primary.loadingKey === loadingAction)}
          onClick={primary.onClick}
          data-testid="install-guide-primary"
        >
          {primary.label}
        </Button>
      </Space>
    </div>
  );
}

function clampStep(activeStep: number, length: number) {
  return Math.min(Math.max(activeStep, 0), length - 1);
}

function stepStatus(current: number, index: number, step: GuideStep) {
  if (step.error && current === index) return "error" as const;
  if (step.done) return "finish" as const;
  if (current === index) return "process" as const;
  return "wait" as const;
}
