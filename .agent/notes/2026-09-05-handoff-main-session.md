# 交接笔记 · 2026-09-05 13:55 · 主会话（可能被中断）

## 当时状态
- `npm run typecheck` 通过；`npx vitest run` 67/70，3 个失败全在 `src/llm/spec-draft.test.ts`（LLM 线仍在改，属半成品）。
- 五条 subagent 线可能未跑完就被会话中断，各线产物以磁盘为准：
  - 后端线：`src/types.ts`、`src/judge.ts`（结构化约束解析器）、`src/stream.ts`、`src/server.ts`、`src/demo-runner.ts`、`src/sse.ts`、`src/ui-flow.ts` 已重写；**尚未**做 `docs/work-unit-design.md` 的工作单元层（`executeUnit` / `/units` / `/constraints` / 安全网）。
  - LLM 线：`src/llm/{config,client,judge,spec-draft,agent-runner}.ts` + 测试 + `.env.example`；server.ts 通过 guarded dynamic import 接它们。
  - 前端线：`src/public/{index.html,styles.css,js/}` 按 `~/.claude/skills/refactoring-ui/SKILL.md` 重做中；未做浏览器验收。
  - dsh 线：`integrations/dsh-plugin/`（是否可跑见 `docs/dsh-live-integration.md`，若无该文件则未完成）。
  - 文档线：`docs/项目说明.md`、`docs/路演台词.md`、`docs/demo-checklist.md` 已完成（按 v2 契约写，工作单元改动后需同步）。
- 两个 Workflow（审计 ~100 agent → `.agent/reviews/2026-09-05-ultra-audit.md`；成熟项目调研 → `docs/work-unit-design-review.md`）若被中断则文件不存在。

## 契约
- `docs/api-contract-v2.md` = 三线契约；`docs/work-unit-design.md` = §4 附录（用户 14:05 拍板：命令级判官 → 工作单元级决策 + 结构化约束匹配；dsh 侧禁用 `ask_user_question`）。

## 下一步（按序）
1. `npm run typecheck && npx vitest run && npm run build`，修掉 LLM 线残留失败。
2. 起服务 `PORT=4173 npm start`，浏览器走一遍 `/demo full` → 红卡裁决 → `/end` → 报告；对照 `docs/demo-checklist.md`。
3. 实现工作单元层（§4.7 后端线清单），再让前端渲染 `card.unit`。
4. 合并 `docs/README-draft-v2.md`（若存在）到 README，同步路演台词到单元级剧本。
5. 现场彩排 3 遍，录屏兜底。
