import { LlmAdapter, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import type { RunState } from '../shared/types.js'
import { responseChunks, type Completion } from './models.js'

export function demoHtml(storage: 'none' | 'memory' | 'local', capacity = 20) {
  const script =
    storage === 'none'
      ? ''
      : `<script>
const form = document.querySelector('form');
const status = document.querySelector('#status');
let registrations = ${storage === 'local' ? "JSON.parse(localStorage.getItem('registrations') || '[]')" : '[]'};
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (registrations.length >= ${capacity}) { status.textContent = '报名已满，感谢关注'; return; }
  registrations.push({ name: form.elements.namedItem('name').value });
  ${storage === 'local' ? "localStorage.setItem('registrations', JSON.stringify(registrations));" : '// 仅在当前页面内存中保存，刷新后清空。'}
  status.textContent = '报名成功！已报名 ' + registrations.length + ' 人';
  form.reset();
});
document.querySelector('#count').textContent = '共 ' + ${capacity} + ' 个名额';
</script>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>周末共创 · 活动报名</title><style>
*{box-sizing:border-box}body{margin:0;background:#eff5ef;color:#20392e;font-family:system-ui,"Microsoft YaHei",sans-serif;padding:36px 20px}main{max-width:520px;margin:auto}small{letter-spacing:2px;color:#617869}.tag{display:inline-block;background:#dcebcf;border-radius:20px;padding:7px 12px;font-size:12px}h1{font-size:38px;line-height:1.25;margin:24px 0 14px}p{line-height:1.8;color:#66776d}.box{background:#fff;border:1px solid #d8e3d6;padding:24px;border-radius:18px;margin-top:24px}label{font-size:13px;display:block;margin-bottom:9px}input{width:100%;border:1px solid #d1dccf;padding:13px;border-radius:8px;font-size:15px}button{background:#274e3a;color:#fff;border:0;border-radius:8px;width:100%;padding:14px;font-size:14px;margin-top:14px;cursor:pointer}#status{min-height:24px;font-size:13px}footer{display:flex;justify-content:space-between;font-size:12px;margin-top:28px;color:#708275}</style></head><body><main><span class="tag">一起，把想法做出来</span><h1>周末共创<br>留一个位置给你。</h1><p>带上一个想法，和有趣的人一起动手。<br>周六 14:00 · 校园创客空间</p><section class="box"><form><label for="name">怎么称呼你？</label><input id="name" name="name" placeholder="输入你的名字" required maxlength="30"><button type="submit">加入这次共创 →</button></form><p id="status" role="status">无需登录，直接报名。</p></section><footer><span>BUILD WITH CARE</span><span id="count">共 ${capacity} 个名额</span></footer></main>${script}</body></html>`
}

/** Explicitly scripted executor. It exercises the real dsh loop and filesystem, not a live model. */
export class DemoAdapter extends LlmAdapter {
  private stage = 0
  private handledCorrections = new Set<string>()
  constructor(
    private state: () => RunState,
    private delayMs: number,
    private onRequest: (options: GenerateOptions) => void,
  ) {
    super()
    if (state().steps.length) this.stage = 4
  }
  async *stream(options: GenerateOptions) {
    this.onRequest(options)
    await delay(this.delayMs, undefined, { signal: options.signal })
    const state = this.state()
    const capacity = Math.max(
      1,
      Math.min(
        500,
        Number(
          state.constraints
            .filter((c) => c.active)
            .map((c) => c.text.match(/(\d+)\s*(人|个|位|名额)/)?.[1])
            .filter(Boolean)
            .at(-1) ?? 20,
        ),
      ),
    )
    const call = (name: string, args: Record<string, unknown>): Completion => ({
      content: '',
      calls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
      finishReason: 'tool_calls',
    })
    let response: Completion
    if (this.stage === 0) {
      response = call('write_file', {
        path: 'index.html',
        content: demoHtml('none'),
        intent: '采用单栏卡片式报名页，先完成页面布局',
      })
    } else if (this.stage === 1) {
      response = call('write_file', {
        path: 'index.html',
        content: demoHtml('local'),
        intent: '使用 localStorage 保存报名信息，刷新后仍保留',
      })
    } else if (this.stage === 2) {
      const previous = state.steps.at(-1)
      if (previous?.status === 'denied')
        response = call('write_file', {
          path: 'index.html',
          content: demoHtml('memory', capacity),
          intent: '按人的纠正改为页面内存，刷新清空，不改动已完成的页面布局',
        })
      else response = call('verify_app', { path: 'index.html' })
    } else if (this.stage === 3 && state.steps.at(-1)?.tool === 'write_file') {
      response = call('verify_app', { path: 'index.html' })
    } else if (
      this.stage > 3 &&
      state.interventions.some(
        (i) =>
          i.progress === 'delivered' &&
          ['correct', 'followup'].includes(i.action) &&
          !this.handledCorrections.has(i.id),
      )
    ) {
      const latest = state.interventions
        .filter(
          (i) =>
            i.progress === 'delivered' &&
            ['correct', 'followup'].includes(i.action) &&
            !this.handledCorrections.has(i.id),
        )
        .at(0)
      if (latest) this.handledCorrections.add(latest.id)
      response =
        latest?.additionKind === 'idea' ||
        !/内存|刷新|持久化|\d+\s*(人|个|位|名额)/.test(latest?.text ?? '')
          ? {
              content:
                latest?.additionKind === 'idea'
                  ? `想法已收到：“${latest.text}”。已作为参考保留，未修改有效要求或页面。演示模式无法评估任意想法；配置真实模型后可讨论可行性。`
                  : `新要求已记录：“${latest?.text}”。固定演示仅支持存储和名额调整，当前页面尚未按这条要求改动。其他要求请使用真实模型。`,
              calls: [],
              finishReason: 'stop',
            }
          : call('write_file', {
              path: 'index.html',
              content: demoHtml('memory', capacity),
              intent: '演示修补：内存保存，按可识别的名额数字更新页面',
            })
    } else if (state.steps.at(-1)?.tool === 'write_file') {
      response = call('verify_app', { path: 'index.html' })
    } else {
      response = {
        content:
          '本轮演示已完成。可在“成果展示”验收页面，在“判断与复盘”查看检查。你可以继续补充要求或想法；演示执行器支持存储纠正和名额调整，其他任务请使用真实运行。',
        calls: [],
        finishReason: 'stop',
      }
    }
    this.stage++
    yield* responseChunks(response)
  }
}
