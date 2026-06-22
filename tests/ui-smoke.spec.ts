import { expect, test, type Page } from "@playwright/test";

const consoleIssues = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const issues: string[] = [];
  consoleIssues.set(page, issues);
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[antd") || text.toLowerCase().includes("deprecated")) {
      issues.push(`${message.type()}: ${text}`);
    }
  });
});

test.afterEach(({ page }) => {
  expect(consoleIssues.get(page) ?? []).toEqual([]);
});

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
  await expect(page.getByRole("banner").getByRole("heading", { name: label })).toBeVisible();
}

async function enableAdvancedMode(page: Page) {
  await goTo(page, "偏好设置");
  const modeItem = page.locator(".ant-form-item").filter({ hasText: "小白模式" });
  const switchControl = modeItem.locator(".ant-switch");
  const checked = await switchControl.evaluate((element) => element.classList.contains("ant-switch-checked"));
  if (checked) {
    await switchControl.click();
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText("设置已保存")).toBeVisible();
  }
  await expect(page.getByRole("menuitem", { name: "网络设置" })).toBeVisible();
}

test("overview and first install guide are usable", async ({ page }) => {
  await openApp(page, { showGuide: true });

  await expect(page.getByRole("heading", { name: "运行总控台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gsuid Core 总控" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "网络与源" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "环境与修复" })).toHaveCount(0);
  const controlStrip = page.locator(".overview-control-strip");
  await expect(controlStrip.getByText("端口", { exact: true })).toBeVisible();
  await expect(controlStrip.getByText("WebConsole", { exact: true })).toBeVisible();
  await expect(controlStrip.getByText("工具链", { exact: true })).toBeVisible();
  await expect(page.getByText("Core 内存")).toHaveCount(0);
  await expect(page.getByText("壳内存")).toHaveCount(0);
  await expect(page.getByText("自动").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "服务状态" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "预检与阻断项" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "当前自动配置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行路径" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "任务历史" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近 Core 日志" })).toHaveCount(0);
  await expect(page.getByText("NoneBot2", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Core 目录")).toHaveCount(0);
  await expect(page.getByText("uv sync 网络超时")).toBeVisible();
  await expect(controlStrip.getByRole("button", { name: "启动 Core" })).toBeVisible();
  await expect(controlStrip.getByRole("button", { name: "停止" })).toHaveCount(0);
  await expect(controlStrip.getByRole("button", { name: "重启" })).toHaveCount(0);
  await expect(controlStrip.getByRole("button", { name: "打开 WebConsole" })).toBeVisible();

  await expect(page.getByTestId("install-guide")).toBeVisible();
  await expect(page.getByTestId("install-guide").getByRole("heading", { name: "首次安装引导" })).toBeVisible();
  await expect(page.getByRole("button", { name: "一键安装启动" })).toBeVisible();

  await page.getByTestId("install-guide-close").click();
  await expect(page.getByTestId("install-guide")).toBeHidden();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await expect(page.locator(".sidebar.ant-layout-sider-collapsed")).toBeVisible();
  await page.getByRole("button", { name: "展开侧边栏" }).click();
  await expect(page.locator(".sidebar.ant-layout-sider-collapsed")).toHaveCount(0);

  await page.getByRole("button", { name: "打开引导" }).click();
  await expect(page.getByTestId("install-guide")).toBeVisible();
  await expect(page.getByText("环境预检与代理")).toBeVisible();
});

test("logs page uses virtual rendering and structured filters", async ({ page }) => {
  await openApp(page);
  await goTo(page, "Core 日志");

  await expect(page.getByRole("heading", { name: "Core JSONL 日志" })).toBeVisible();
  await expect(page.getByText(/JSONL 1200\/1200/)).toBeVisible();
  await expect(page.getByText("全部来源")).toHaveCount(0);
  await expect(page.getByText("全部模块")).toBeVisible();
  await page.getByRole("button", { name: "更多" }).click();
  await expect(page.getByText("打开日志目录")).toBeVisible();

  const renderedRows = await page.locator(".log-line").count();
  expect(renderedRows).toBeGreaterThan(0);
  expect(renderedRows).toBeLessThan(120);

  await page.getByPlaceholder("搜索日志").fill("早柚核心");
  await expect(page.getByText("早柚核心").first()).toBeVisible();
  await expect(page.getByText(/条匹配/)).toBeVisible();
});

test("webconsole toolbar actions are wired", async ({ page }) => {
  await openApp(page);

  await page.getByRole("button", { name: "打开 WebConsole" }).click();
  await expect(page.getByRole("main").getByRole("heading", { name: "WebConsole" })).toBeVisible();
  await expect(page.getByText("http://127.0.0.1:8765/app")).toBeVisible();

  const frame = page.locator("iframe.webconsole-frame");
  await expect(frame).toHaveAttribute("src", "http://127.0.0.1:8765/app");
  await expect(frame).toHaveAttribute("data-frame-version", "1");

  await page.getByRole("button", { name: "刷新框架" }).click();
  await expect(frame).toHaveAttribute("data-frame-version", "2");
  await expect(page.getByText("WebConsole 框架已刷新")).toBeVisible();

  await page.getByRole("button", { name: "复制 URL" }).click();
  await expect(page.getByText("URL 已复制")).toBeVisible();

  await page.getByRole("button", { name: "外部打开" }).click();
  await expect(page.getByText("已交给系统浏览器打开")).toBeVisible();
});

test("preferences and shell update are separated", async ({ page }) => {
  await openApp(page);
  await goTo(page, "偏好设置");

  await expect(page.getByRole("main").getByRole("heading", { name: "偏好设置" })).toBeVisible();
  await expect(page.getByText("小白模式", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("点击 X 关闭窗口")).toBeVisible();
  await expect(page.getByText("退出 GSDesk 时 Core")).toBeVisible();
  await expect(page.getByRole("button", { name: "检查更新" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开引导" })).toHaveCount(0);

  await page.locator(".ant-form-item").filter({ hasText: "小白模式" }).locator(".ant-switch").click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存")).toBeVisible();

  await page.locator(".ant-form-item").filter({ hasText: "点击 X 关闭窗口" }).getByText("退出 GSDesk", { exact: true }).click();
  await page.locator(".ant-form-item").filter({ hasText: "退出 GSDesk 时 Core" }).getByText("后台保留", { exact: true }).click();
  await page.locator(".ant-form-item").filter({ hasText: "启动时检查壳更新" }).getByText("关闭", { exact: true }).click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存")).toBeVisible();

  await goTo(page, "壳更新");
  await expect(page.getByRole("main").getByRole("heading", { name: "壳更新" })).toBeVisible();
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText("发现可安装更新 0.2.0")).toBeVisible();
  await page.getByRole("button", { name: "下载并安装" }).click();
  await expect(page.getByRole("dialog").filter({ hasText: "下载并安装 GSDesk 更新" })).toBeVisible();
  await page.getByRole("button", { name: "安装更新" }).click();
  await expect(page.getByText("预览数据：壳更新 0.2.0 已安装，正在重启 GSDesk")).toBeVisible();
});

test("network, environment and diagnostics flows expose v1 controls", async ({ page }) => {
  await openApp(page);
  await enableAdvancedMode(page);

  await goTo(page, "网络检测");
  await expect(page.getByRole("tab", { name: "源码源" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("heading", { name: "网络检测" })).toBeVisible();
  await expect(page.getByText("PyPI 镜像策略")).toHaveCount(0);
  await page.getByRole("button", { name: "探测 GitHub / CNB" }).click();
  await expect(page.getByText("CNB 国内镜像")).toBeVisible();

  await page.getByRole("button", { name: "测速 PyPI" }).click();
  await expect(page.getByText("https://mirrors.aliyun.com/pypi/simple/")).toBeVisible();

  await page.getByRole("button", { name: "连通性诊断" }).click();
  await expect(page.getByRole("row", { name: /本机 WebConsole.*Core 未启动/ })).toBeVisible();

  await goTo(page, "网络设置");
  await expect(page.getByRole("main").getByRole("heading", { name: "网络设置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "探测 GitHub / CNB" })).toHaveCount(0);
  await expect(page.getByText("PyPI 镜像策略")).toBeVisible();
  await page.getByText("手动锁定", { exact: true }).click();
  await page.getByLabel("PyPI 镜像地址").fill("https://example.invalid/simple/");
  await expect(page.getByText("Core 源码路径")).toBeVisible();
  await page.getByLabel("Core 源码路径").fill("D:\\portable\\gsuid_core");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByLabel("PyPI 镜像地址")).toHaveValue("https://example.invalid/simple/");
  await expect(page.getByLabel("Core 源码路径")).toHaveValue("D:\\portable\\gsuid_core");
  await expect(page.getByText("当前生效路径：D:\\portable\\gsuid_core")).toBeVisible();
  await expect(page.getByText("Core 固定端口")).toBeVisible();
  await expect(page.getByPlaceholder("自动选择 8765-8865")).toBeVisible();

  await goTo(page, "环境预检");
  await expect(page.getByRole("tab", { name: "预检与修复" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("heading", { name: "环境预检" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { name: "运行时修复" })).toHaveCount(0);
  await expect(page.getByRole("main").getByText("Core 更新与回滚")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "高级修复" })).toHaveCount(0);

  await goTo(page, "运行时修复");
  await expect(page.getByRole("main").getByRole("heading", { name: "运行时修复" })).toBeVisible();
  await page.getByRole("button", { name: "高级修复" }).click();
  await expect(page.getByRole("menuitem", { name: /强杀端口 .* 占用/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await goTo(page, "Core 更新");
  await expect(page.getByRole("main").getByText("Core 更新与回滚")).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { name: "环境预检" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "更多更新操作" })).toBeVisible();
  await page.getByRole("button", { name: "更多更新操作" }).click();
  await expect(page.getByRole("menuitem", { name: "清理更新差异" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "选择 commit 回滚" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "刷新 commit 列表" })).toBeVisible();
  await expect(page.getByRole("main").getByText("deadc0d")).toBeVisible();
  await expect(page.getByRole("main").getByText("prev123")).toBeVisible();
  await expect(page.getByRole("main").getByText("当前")).toBeVisible();
  await expect(page.getByRole("main").getByText("回滚点", { exact: true })).toBeVisible();
  const rollbackRow = page.getByRole("row", { name: /prev123.*调整依赖同步流程/ });
  await rollbackRow.getByRole("button", { name: /回\s*滚/ }).click();
  const rollbackDialog = page.getByRole("dialog").filter({ hasText: "回滚 Core 到该 commit" });
  await expect(rollbackDialog).toBeVisible();
  await rollbackDialog.getByRole("button", { name: /回\s*滚/ }).click();
  await expect(page.getByText("预览数据：Core 已回滚")).toBeVisible();

  await goTo(page, "运行时备份");
  await expect(page.getByRole("button", { name: "导出备份" })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复备份" })).toBeVisible();
  await expect(page.getByRole("main").getByText("Core 更新与回滚")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "备份与设置" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开目录" })).toHaveCount(0);
  await expect(page.getByText("导入最近设置")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "清理所有数据" })).toBeVisible();
  await page.getByRole("button", { name: "清理所有数据" }).click();
  const clearDataDialog = page.getByRole("dialog").filter({ hasText: "清理所有 GSDesk 本机数据" });
  await expect(clearDataDialog).toBeVisible();
  await clearDataDialog.getByRole("button", { name: /取\s*消/ }).click();

  await expect(page.getByRole("tab", { name: "Core 配置" })).toHaveCount(0);
  await expect(page.getByText("Core 配置编辑器")).toHaveCount(0);

  await goTo(page, "任务历史");
  await expect(page.getByRole("main").getByRole("heading", { name: "任务历史" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("button", { name: "清理所有数据" })).toHaveCount(0);
  const runningTaskRow = page.getByRole("row", { name: /初始化运行时.*正在同步 Python 依赖/ });
  await expect(runningTaskRow.getByRole("button", { name: "取消" })).toBeVisible();
  await runningTaskRow.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("row", { name: /初始化运行时.*任务已取消/ })).toBeVisible();
  const failedTaskRow = page.getByRole("row", { name: /运行时修复.*uv sync 网络超时/ });
  await expect(failedTaskRow.getByRole("button", { name: "重试" })).toBeVisible();
  await failedTaskRow.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("row", { name: /运行时修复.*预览数据修复完成/ })).toBeVisible();

  await goTo(page, "诊断导出");
  await expect(page.getByRole("tab", { name: "导出与更新" })).toHaveCount(0);
  await expect(page.getByRole("main").getByText("诊断导出")).toBeVisible();
  await expect(page.getByRole("main").getByText("故障摘要")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "检查壳更新" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载并安装" })).toHaveCount(0);
  await expect(page.getByText("诊断包只保存在本机 diagnostics 目录")).toBeVisible();
  await page.getByRole("button", { name: "导出诊断包" }).click();
  const diagnosticsDialog = page.getByRole("dialog").filter({ hasText: "预览数据目录/diagnostics/gsdesk-diagnostics.zip" });
  await expect(diagnosticsDialog).toBeVisible();
  await page.keyboard.press("Escape");

  await goTo(page, "故障摘要");
  await expect(page.getByRole("main").getByText("故障摘要")).toBeVisible();
  await expect(page.getByRole("main").getByText("诊断导出")).toHaveCount(0);
  await expect(page.getByText("uv：未检测到 uv")).toBeVisible();
  await expect(page.getByText("执行“安装/更新 uv”，然后重新运行初始化。")).toBeVisible();
  await expect(page.getByText("Python 依赖或 venv 不完整")).toBeVisible();
  await expect(page.getByTestId("failure-context").getByText("ModuleNotFoundError")).toBeVisible();
});

test("clear app data is confirmed and resets local state", async ({ page }) => {
  await openApp(page);
  await enableAdvancedMode(page);
  await goTo(page, "运行时备份");
  await page.getByRole("button", { name: "清理所有数据" }).click();
  const clearDataDialog = page.getByRole("dialog").filter({ hasText: "清理所有 GSDesk 本机数据" });
  await expect(clearDataDialog).toBeVisible();
  await clearDataDialog.getByRole("button", { name: "清理所有数据" }).click();
  await expect(page.getByText(/本机数据已清理/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行总控台" })).toBeVisible();
  await expect(page.getByText("未初始化").first()).toBeVisible();
});
