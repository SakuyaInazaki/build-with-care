// Client-side scripted demo for backends without a server-side runner (v1).
// Drives: blue card → red card (waits for the HUMAN to adjudicate in the dock) → corrected write → executor evidence.

const STAGES = [
  { id: 'blue', label: '蓝卡 · 自主选择' },
  { id: 'red', label: '红卡 · 执行前阻断' },
  { id: 'correction', label: '人的纠偏' },
  { id: 'tool', label: '执行修正' },
  { id: 'evidence', label: '证据 → green' },
  { id: 'complete', label: '回放与报告' },
]

export const DEMO_SPEC = {
  id: 'demo-spec',
  request: '做一个可验证的学生报名存储功能',
  constraints: ['存储必须使用 Postgres，不允许 SQLite', '核心流程必须可验证'],
  confirmed: true,
}

/**
 * ctx: { api, mode, toast(msg, kind), setRunner(status), selectSession(id), waitFor(pred, timeoutMs) }
 * waitFor(pred) must poll the session state and resolve with pred(state) once truthy.
 */
export async function runLegacyDemo(ctx) {
  const { api, mode, setRunner, selectSession, waitFor, toast } = ctx
  const status = (activeId, message, state = 'running') => {
    const activeIndex = STAGES.findIndex((s) => s.id === activeId)
    setRunner({
      kind: 'demo', state, scenario: 'full', message,
      stages: STAGES.map((s, i) => ({ ...s, status: state === 'done' ? 'done' : i < activeIndex ? 'done' : i === activeIndex ? (state === 'failed' ? 'failed' : 'active') : 'pending' })),
    })
  }
  let id = ''
  try {
    status('blue', '新建演示会话并确认 spec…')
    const created = await api.createSession(mode, '演示：学生报名存储')
    id = created.sessionId
    await selectSession(id)
    await api.confirmSpec(id, DEMO_SPEC)
    await waitFor((s) => s && s.spec, 5000)

    status('blue', '蓝卡：agent 自主选择缓存方案，不阻断，进入侧栏')
    await api.action(id, { id: 'demo-blue', tool: 'choose_cache', kind: 'write', description: '选择内存缓存方案', args: { provider: 'memory' }, agentId: 'agent-research' })
    await waitFor((s) => s.cards.find((c) => c.id === 'demo-blue' && c.state !== 'pending' && c.executionStatus !== 'running'), 8000)

    status('red', '红卡：SQLite 与 spec 冲突，执行前阻断——请在右侧裁决', 'waiting-human')
    await api.action(id, { id: 'demo-red', tool: 'write_file', kind: 'write', description: '选择 SQLite 存储报名信息', args: { path: 'store/db.sqlite' }, agentId: 'agent-builder' })
    await waitFor((s) => s.cards.find((c) => c.id === 'demo-red'), 8000)
    const red = await waitFor((s) => { const c = s.cards.find((x) => x.id === 'demo-red'); return c && c.state !== 'pending' ? c : null }, 15 * 60 * 1000)
    if (red.state === 'cancelled') { status('red', '你叫停了这一步，演示结束。', 'cancelled'); return }

    if (red.state === 'allowed') status('correction', '你放行了原动作；继续后续步骤')
    else status('correction', mode === 'forward-only' ? '约束已注入，只影响后续步骤；历史不改写' : '已从已完成的 turn 边界 fork 新分支，原分支暂存')
    await new Promise((r) => setTimeout(r, 600))

    status('tool', '执行修正后的 Postgres 写入（本地受控 executor）')
    await api.action(id, { id: 'demo-postgres', tool: 'write_file', kind: 'write', description: '使用 Postgres 兼容 schema 保存报名信息', args: { path: 'store/db.sql', content: '-- demo schema\nCREATE TABLE registrations (id text primary key);' }, specified: true, agentId: 'agent-builder' })
    await waitFor((s) => s.cards.find((c) => c.id === 'demo-postgres' && c.state !== 'pending' && c.executionStatus !== 'running'), 8000)

    status('evidence', '运行本地检查，只有执行器证据才能变绿')
    await api.action(id, { id: 'demo-evidence', tool: 'local_check', kind: 'validate', description: '运行报名 schema 本地检查', args: { target: 'store/db.sql' }, specified: true, agentId: 'agent-verifier' })
    await waitFor((s) => s.cards.find((c) => c.id === 'demo-evidence' && c.state !== 'pending' && c.executionStatus !== 'running'), 8000)

    status('complete', '演示完成：回放时间线，查看一页报告', 'done')
    toast('演示完成。用时间线回放人的裁决，或结束会话出报告。', 'success')
  } catch (error) {
    status(null, `演示中断：${error.message}`, 'failed')
    throw error
  }
}
