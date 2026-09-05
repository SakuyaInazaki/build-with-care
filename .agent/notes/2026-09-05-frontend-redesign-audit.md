# 前端重设计前置调研

日期：2026-09-05。

用户要求先安装仓库 design skill、使用本机 refactoring-ui，以 `docs/requirements-v1-frozen.md` 为准，先了解赛道和目前情况。

## 已完成

- 将 `.agent/skills/design/SKILL.md` 安装到 `/Users/sakimi/.codex/skills/apple-design/SKILL.md`，校验内容一致。
- 读取本机 `/Users/sakimi/Desktop/self-projects/refactoring-ui/SKILL.md`。
- 阅读冻结需求、赛事资料、历史方案与两套实现，核对实际页面和现有测试。
- 新增 `docs/frontend-redesign-audit-2026-09-05.md`，记录差距、证据边界与后续设计主线。
- 新工程按锁文件安装依赖，TypeScript/Vite 构建通过，19 项测试通过；根工程 typecheck 通过，77 项测试在沙箱通过，5 项 HTTP 测试解除监听限制后重跑通过。
- 在临时数据目录运行旧脚本演示以检查界面。1280×720 首屏的待处理面板从约 790px 开始，核心判断被上方统计与输入区推到屏外。截图位于 `decision-desk/.artifacts/design-audit/`。

## 后续必须保留的认识

- `decision-desk/` 是前后端独立工程，与根工程 `/api/sessions`、WorkUnit、dsh 插件并非同一条运行链。
- 两套实现均不能直接视为冻结版：新工程缺多轮 Grill、状态看板、工作单元隔离等；根界面公开旧分支模式，部分故障回退策略也需核对。
- 首版允许同一模型承担执行与隔离审查；不能继续强制不同 family。
- 红卡四动作按冻结业务语义实现，蓝卡不阻塞，绿灯只认有效受控证据。
- 真实演示任务未提供，旧报名页固定脚本不计入三次真实闭环。
- 本轮只有调研及设计建议，没有人工确认的新语义；冻结文件继续原样有效。

没有修改前端／运行时代码、冻结需求或旧来源文档，没有提交 commit。
