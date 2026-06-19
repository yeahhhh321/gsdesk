import { expect, test, type Page } from "@playwright/test";

async function openApp(page: Page, options: { showGuide?: boolean } = {}) {
  await page.addInitScript((showGuide) => {
    window.sessionStorage.clear();
    if (!showGuide) window.sessionStorage.setItem("gsdesk.installGuide.seen", "1");
  }, options.showGuide === true);
  await page.goto("/");
  await expect(page.getByText("GSDesk").first()).toBeVisible();
}

async function closeInstallGuideIfVisible(page: Page) {
  const guide = page.getByTestId("install-guide");
  if (await guide.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.getByLabel("关闭首次安装引导").click();
    await expect(guide).toBeHidden();
  }
}

async function goTo(page: Page, label: string) {
  await closeInstallGuideIfVisible(page);
  await page.getByRole("menuitem", { name: new RegExp(label) }).click();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
}

test("overview and first install guide are usable", async ({ page }) => {
  await openApp(page, { showGuide: true });

  await expect(page.getByRole("heading", { name: "运行总控台" })).toBeVisible();
  await expect(page.getByText("Gsuid Core")).toBeVisible();
  await expect(page.getByText("端口策略")).toBeVisible();
  await expect(page.getByText("自动").first()).toBeVisible();
  await expect(page.getByText("NoneBot2")).toBeVisible();

  await expect(page.getByTestId("install-guide")).toBeVisible();
  await expect(page.getByTestId("install-guide").getByRole("heading", { name: "首次安装引导" })).toBeVisible();
  await expect(page.getByRole("button", { name: "一键安装启动" })).toBeVisible();

  await page.getByTestId("install-guide-close").click();
  await expect(page.getByTestId("install-guide")).toBeHidden();

  await page.getByRole("button", { name: "打开引导" }).click();
  await expect(page.getByTestId("install-guide")).toBeVisible();
  await expect(page.getByText("环境预检与代理")).toBeVisible();
});

test("logs page uses virtual rendering and structured filters", async ({ page }) => {
  await openApp(page);
  await goTo(page, "终端日志");

  await expect(page.getByText(/缓存 1200\/1200/)).toBeVisible();
  await expect(page.getByText("全部模块")).toBeVisible();
  await expect(page.getByText("日志目录")).toBeVisible();

  const renderedRows = await page.locator(".log-line").count();
  expect(renderedRows).toBeGreaterThan(0);
  expect(renderedRows).toBeLessThan(120);

  await page.getByPlaceholder("搜索日志").fill("早柚核心");
  await expect(page.getByText("早柚核心").first()).toBeVisible();
  await expect(page.getByText(/条匹配/)).toBeVisible();
});

test("network, environment and diagnostics flows expose v1 controls", async ({ page }) => {
  await openApp(page);

  await goTo(page, "网络与设置");
  await expect(page.getByText("源码源")).toBeVisible();
  await page.getByRole("button", { name: "探测 GitHub / CNB" }).click();
  await expect(page.getByText("CNB 国内镜像")).toBeVisible();

  await page.getByRole("tab", { name: "PyPI 镜像" }).click();
  await page.getByRole("button", { name: "测速镜像" }).click();
  await expect(page.getByText("https://mirrors.aliyun.com/pypi/simple/")).toBeVisible();

  await page.getByRole("tab", { name: "连通性诊断" }).click();
  await page.getByRole("button", { name: "测试 GitHub / CNB / PyPI / WebConsole" }).click();
  await expect(page.getByText("本机 WebConsole")).toBeVisible();

  await page.getByRole("tab", { name: "代理与设置" }).click();
  await expect(page.getByText("PyPI 镜像策略")).toBeVisible();
  await page.getByText("手动锁定", { exact: true }).click();
  await page.getByLabel("PyPI 镜像地址").fill("https://example.invalid/simple/");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.getByRole("tab", { name: "PyPI 镜像" }).click();
  await page.getByRole("button", { name: "测速镜像" }).click();
  await page.getByRole("tab", { name: "代理与设置" }).click();
  await expect(page.getByLabel("PyPI 镜像地址")).toHaveValue("https://example.invalid/simple/");
  await expect(page.getByText("Core 固定端口")).toBeVisible();
  await expect(page.getByPlaceholder("自动选择 8765-8865")).toBeVisible();

  await goTo(page, "环境与修复");
  await expect(page.getByText("环境预检")).toBeVisible();
  await expect(page.getByText("Core 更新与回滚")).toBeVisible();
  await expect(page.getByRole("button", { name: "导出备份快照" })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复最近备份" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出设置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入最近设置" })).toBeVisible();
  await expect(page.getByText("Core 配置编辑器")).toBeVisible();
  await expect(page.getByText("Core 主配置")).toBeVisible();
  const registerCodeRow = page.getByRole("row", { name: /REGISTER_CODE/ });
  await expect(registerCodeRow).toBeVisible();
  await expect(registerCodeRow.getByText("敏感", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存修改" })).toBeDisabled();
  await expect(page.getByText("任务历史")).toBeVisible();
  const runningTaskRow = page.getByRole("row", { name: /初始化运行时.*mock running/ });
  await expect(runningTaskRow.getByRole("button", { name: "取消" })).toBeVisible();
  await runningTaskRow.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("row", { name: /初始化运行时.*任务已取消/ })).toBeVisible();
  const failedTaskRow = page.getByRole("row", { name: /运行时修复.*mock failed/ });
  await expect(failedTaskRow.getByRole("button", { name: "重试" })).toBeVisible();
  await failedTaskRow.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("row", { name: /运行时修复.*开发预览模式修复完成/ })).toBeVisible();

  await goTo(page, "诊断导出");
  await expect(page.getByText("故障排查向导")).toBeVisible();
  await expect(page.getByText("uv：未检测到 uv")).toBeVisible();
  await expect(page.getByText("执行“安装/修复 uv”，然后重新运行初始化。")).toBeVisible();
  await expect(page.getByText("最近错误摘要")).toBeVisible();
  await expect(page.getByText("Python 依赖或 venv 不完整")).toBeVisible();
  await expect(page.getByTestId("failure-context").getByText("ModuleNotFoundError")).toBeVisible();
  await expect(page.getByText("隐私与遥测")).toBeVisible();
  await expect(page.getByText("自动上传：关闭")).toBeVisible();
  await expect(page.getByText("诊断包仅保存在本机 diagnostics 目录")).toBeVisible();
  await page.getByRole("button", { name: "检查壳更新" }).click();
  await expect(page.getByText("当前已是最新稳定版或暂无 Release")).toBeVisible();

  await page.getByRole("button", { name: "导出诊断包" }).click();
  const diagnosticsDialog = page.getByRole("dialog").filter({ hasText: "开发预览模式/diagnostics/gsdesk-diagnostics.zip" });
  await expect(diagnosticsDialog).toBeVisible();
});
