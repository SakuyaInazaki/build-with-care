import type { RequestHandler } from 'express'
import type { Manager } from './manager.js'

/**
 * 公开展示站。工作台本身没有改动，这里只做一件事：把它变成只读。
 *
 * 单实例、匿名访问的部署里，写操作没有一条是安全的——模型密钥是全服务器共享的，
 * 真实模式下的 run_command 会在宿主机执行任务自带的脚本，记录也是所有访客共用的。
 * 与其逐条设防，不如只开放读：访客看真实跑出来的会话记录，想自己跑就用离线包。
 */
export const publicDemoEnabled = process.env.PUBLIC_DEMO === '1'

const KEEP_RUNS = Number(process.env.PUBLIC_DEMO_KEEP ?? 40)
const MAX_AGE_MS = Number(process.env.PUBLIC_DEMO_MAX_AGE_HOURS ?? 12) * 3600_000
/** 预置展示记录：真实模型跑出来的会话，开箱即见，永不清理。 */
const pinned = new Set(
  (process.env.PUBLIC_DEMO_PINNED ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
)

export function publicDemoGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET') {
      res.status(403).json({
        error: '这是只读的公开展示站。想自己跑一遍，请下载离线包在本机运行。',
      })
      return
    }
    next()
  }
}

/** 保留预置记录，清掉其余陈旧记录，避免共享环境无限堆积。 */
export function startDemoJanitor(manager: Manager) {
  const sweep = async () => {
    const candidates = manager.list().filter((run) => !pinned.has(run.id))
    const stale = candidates.filter(
      (run, index) => index >= KEEP_RUNS || Date.now() - Date.parse(run.createdAt) > MAX_AGE_MS,
    )
    for (const run of stale) {
      if (run.status === 'running') continue
      try {
        await manager.delete(run.id)
      } catch {
        // 已经不存在的记录不需要再处理。
      }
    }
  }
  void sweep()
  const timer = setInterval(() => void sweep(), 600_000)
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * 共享的展示站不是私人工作台，访客在页面上就该知道这一点。
 * 同时注入一个同步可读的标记：展示站每次都要从纸墨欢迎页进入，
 * 靠 bootstrap 返回的能力位判断会先闪一帧工作空间。
 */
export function demoBanner(html: string) {
  const flag = `<script>window.__KANZHEBAN_SHOWCASE__=true</script>`
  const banner = `<div id="public-demo-banner" style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,720px);display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:12px;background:rgba(24,28,26,.92);color:#f2f5f2;font:13px/1.6 system-ui,-apple-system,'PingFang SC',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28)"><span>公开展示站 · 只读：这里是真实模型跑出来的会话记录，可以翻看每一张决策卡、时间线和结束报告。想自己跑一遍，<a href="/downloads/" style="color:#cfe3d4;text-decoration:underline">下载离线包</a>在本机运行。</span><button type="button" onclick="this.parentNode.remove()" style="flex:none;border:0;border-radius:8px;padding:6px 10px;background:#3c4a42;color:#f2f5f2;cursor:pointer;font:inherit">知道了</button></div>`
  return html.includes('</body>')
    ? html.replace('</body>', `${flag}${banner}</body>`)
    : html + flag + banner
}
