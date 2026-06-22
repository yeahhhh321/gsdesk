import { Alert, Button, Space, Typography } from "antd";
import { useEffect, useRef } from "react";
import { Play, X } from "lucide-react";
import { buildGuideSteps, type GuideAction, type GuideStep, type InstallGuideProps } from "./installGuideSteps";

const { Text, Title } = Typography;

export function InstallGuide(props: InstallGuideProps) {
  const { open, activeStep, loadingAction, setupRunning, onClose, onStepChange, onRunAll } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [current, open]);

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
        <div className="install-guide-scroll" ref={scrollRef}>
          <div className="install-guide-body">
            <div className="guide-top-strip">
              <div className="guide-run-all">
                <div>
                  <strong>一键初始化</strong>
                  <Text type="secondary">测速源码源和 PyPI 镜像，初始化运行时，启动 Core 并打开 WebConsole。</Text>
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
                  className="guide-running-alert"
                  type="info"
                  showIcon
                  title={`当前任务：${runningTask.name} / ${runningTask.stage}`}
                  description={runningTask.message}
                />
              )}
            </div>
            <GuideStepRail steps={steps} current={current} onStepChange={onStepChange} />
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

function GuideStepRail({
  steps,
  current,
  onStepChange,
}: {
  steps: GuideStep[];
  current: number;
  onStepChange: (step: number) => void;
}) {
  return (
    <div className="install-step-rail" role="list" aria-label="安装步骤">
      {steps.map((item, index) => (
        <button
          key={item.title}
          type="button"
          className={guideStepClassName(item, index, current)}
          onClick={() => onStepChange(index)}
          aria-current={current === index ? "step" : undefined}
        >
          <span>{item.error ? "!" : item.done ? "✓" : index + 1}</span>
          <strong>{item.title}</strong>
        </button>
      ))}
    </div>
  );
}

function guideStepClassName(step: GuideStep, index: number, current: number) {
  const names = ["install-step-tab"];
  if (index === current) names.push("is-current");
  if (step.done) names.push("is-done");
  if (step.error) names.push("is-error");
  return names.join(" ");
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
