# Light paper landing integration

## Source

Integrated the light-only prototype from:

- `/Users/sakimi/.codex/visualizations/2026/09/05/01a071ee-c2e2-7231-a057-6987cea4b564/astra-scroll-lab/paper/index.html`
- `/Users/sakimi/.codex/visualizations/2026/09/05/01a071ee-c2e2-7231-a057-6987cea4b564/astra-scroll-lab/paper/style.css`
- `/Users/sakimi/.codex/visualizations/2026/09/05/01a071ee-c2e2-7231-a057-6987cea4b564/astra-scroll-lab/paper/main.mjs`
- `/Users/sakimi/.codex/visualizations/2026/09/05/01a071ee-c2e2-7231-a057-6987cea4b564/astra-scroll-lab/paper/README.md`

The application dependency is pinned to Three.js `0.180.0` with its matching types. The generated Three.js code remains a lazy production chunk and is requested only while the landing component is mounted.

## Product behavior

- `/welcome` is an app-owned route that opens the paper story directly. The existing brand button navigates there without a reload.
- A user who has not entered before is sent to `/welcome` after bootstrap unless an unfinished task exists. Completed or stopped history alone does not suppress the first landing visit.
- The entry button records `kanzheban.landing-entered`, pushes `/`, and reveals the existing React workspace without a hardcoded host or page reload. Browser Back returns to `/welcome`.
- Explicitly opening `/welcome` while work needs attention keeps the existing attention card above the landing. Its action enters the workspace at the relevant task.
- The story uses its own scroll container. Forward scroll removes `Build with Care` and gathers paper-ink grains into a thick `D`; reverse scroll restores the earlier state.
- Reduced motion uses endpoint crossfades rather than particle travel. WebGL construction failure and context loss expose a CSS `D` driven by the same scroll progress, including the entry action.
- Unmount removes scroll, media-query, visibility, and context listeners; cancels animation frames; disconnects observers; and disposes geometry, material, and renderer resources.

## Settings feedback

Connection success now reads `连接成功，服务已返回响应`; save success reads `设置已保存`. Both render in the existing live status region, strengthened into a high-visibility green success surface.

## Verification

- `npm --prefix frontend run build` passed (TypeScript and Vite production build).
- `npm --prefix frontend test` passed: 3 files, 14 tests.
- Existing isolated `frontend/tests/intake.browser.mjs` and `frontend/tests/notifications.browser.mjs` both passed against the production build.
- A one-off headless Chrome exploration used a separate production server on port 4394 with an empty temporary data directory. It confirmed start → formed D, reverse restoration to the start with the entry hidden, internal `/welcome` → `/` entry, Back restoration to `/welcome`, a usable reduced-motion endpoint, a usable forced-WebGL-failure endpoint, and no page errors. The isolated server was stopped after the check.
- No new test files or cases were added.
- Independent browser acceptance passed desktop initial/mid/formed composition, reverse restoration, keyboard End, internal entry without reload, direct `/welcome`, Back/Forward, returning-session lazy loading, attention-overlay task entry, reduced motion, forced WebGL fallback, and 390 px mobile layout with 3600 particles. Desktop and mobile screenshots showed no D/button overlap or horizontal overflow.
- The same independent pass confirmed the strengthened Settings success and failure surfaces, mobile modal fit, key clearing, and custom configuration persistence across reopen/reload.

The running service on port 4322, its task data, and the background idle deployment were not stopped, restarted, or changed. Real-device GPU performance and cross-browser rendering remain outside this local verification.
