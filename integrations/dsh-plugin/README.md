# Decision Stream dsh Plugin

This plugin targets DeepSeek Harness `0.1.3-alpha.1` at commit `d347e70390`. It is a DSH profile bundle: `dsh.bundle.patch` exports `cordis.patch.yml`, which inserts the function-form plugin into the 0.1.3 bundle composition.

Run `DSH_CLONE=/Users/sakimi/Desktop/DSH/deepseek-harness npm run link-dsh`, then `npm run typecheck`, `npm test`, and `npm run smoke`. The linker requires an explicit 0.1.3-alpha.1 checkout, links individual source packages into this repository's own `node_modules`, and never reads or writes `~/.dsh`. Do not run `npm install` while these external package symlinks exist; relink after installing repository-local dependencies instead.

The plugin posts one dsh step as `POST /api/sessions/:id/units`. A missing `/units` route is a hard integration failure, not an action-card fallback. Final outcomes are observed through `tools/post-execute` and `tools/result`, then sent as `tool-result` adapter events with output/error, evidence metadata, and external-side-effect flags when available. DSH `session/created` is projected as `session/start` or, when the 0.1.3 `SessionHeader.parentSession` is present, `session/fork`; turn, step, and durable message events continue through `session/event`. Agent injection and human cancellation are mirrored as `agent.inject` and `agent.cancel`.

`ask_user_question` remains visible when supplied by a dsh preset, but it is unconditionally denied in both `tools/pre-execute` and the monotonic tool guard. There is no environment or plugin configuration switch to re-enable it.

The plugin does not modify `~/.dsh`, repair an external dsh installation, or claim a real-model run when credentials or network access are unavailable.
