# TypeScript React Skill

## 目标

用于 GSDesk 前端改动。要求类型清晰、组件边界干净、中文 UI 文案稳定。

## 规则

- 页面组件只做布局和状态编排；复杂表格列、规则判断、mock 数据拆到独立文件。
- 使用 `type` import；禁止 `any`、`as any`、`@ts-ignore`。
- 不写无意义 fallback 链。默认值用命名函数或显式分支。
- React effect 必须能解释依赖；不要用空依赖绕过状态同步。
- UI 文案中文优先，错误提示要可执行。

## 验证

```powershell
pnpm lint:ts
pnpm build
pnpm test:ui
```
