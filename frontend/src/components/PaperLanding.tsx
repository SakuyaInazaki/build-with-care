import { useEffect, useRef, useState } from 'react'
import type { BufferGeometry, ShaderMaterial, Vector3, WebGLRenderer } from 'three'
import '../paper-landing.css'

interface PaperLandingProps {
  onEnter: () => void
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))
const smooth = (value: number) => {
  const bounded = clamp(value)
  return bounded * bounded * (3 - 2 * bounded)
}

export function PaperLandingPrelude() {
  return (
    <main className="paper-landing paper-landing--prelude" aria-label="正在打开看着办">
      <div className="paper-landing__ambient" aria-hidden="true" />
      <div className="paper-landing__labels" aria-hidden="true">
        <span>Build</span>
        <span>with Care</span>
      </div>
    </main>
  )
}

export function PaperLanding({ onEnter }: PaperLandingProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const storyRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const bottomBarRef = useRef<HTMLDivElement>(null)
  const entryRef = useRef<HTMLDivElement>(null)
  const leaveTimerRef = useRef<number | undefined>(undefined)
  const [three, setThree] = useState<typeof import('three') | null>(null)
  const [ready, setReady] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    let mounted = true
    void import('three').then((module) => {
      if (mounted) setThree(module)
    })
    return () => {
      mounted = false
      window.clearTimeout(leaveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!three) return
    const THREE = three
    const scroller = scrollRef.current
    const story = storyRef.current
    const stage = stageRef.current
    const canvas = canvasRef.current
    const fallback = fallbackRef.current
    const labels = labelsRef.current ? [...labelsRef.current.children] as HTMLElement[] : []
    const bottomBar = bottomBarRef.current
    const entry = entryRef.current
    if (!scroller || !story || !stage || !canvas || !fallback || !bottomBar || !entry) return

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = motionQuery.matches
    let formed = false
    const present = (progress: number, targetProgress: number) => {
      const fade = smooth(progress / 0.42)
      labels.forEach((label, index) => {
        label.style.opacity = String(1 - fade)
        label.style.transform = reduced ? 'none' : `translateX(${(index ? 1 : -1) * fade * 38}px)`
      })
      bottomBar.style.opacity = String(1 - smooth((progress - 0.72) / 0.2))
      const nextFormed = progress >= 0.9995 && targetProgress >= 0.9995
      if (nextFormed !== formed) {
        formed = nextFormed
        entry.classList.toggle('is-ready', formed)
        entry.inert = !formed
        entry.setAttribute('aria-hidden', String(!formed))
        setReady(formed)
      }
      stage.dataset.progress = progress.toFixed(5)
      stage.dataset.phase = formed ? 'formed' : progress <= 0.0005 ? 'start' : 'gather'
      if (!fallback.hidden) fallback.style.opacity = String(smooth((progress - 0.4) / 0.6))
    }
    const readProgress = () => {
      const distance = story.offsetHeight - stage.offsetHeight
      return clamp(scroller.scrollTop / Math.max(1, distance * 0.92))
    }

    let renderer: WebGLRenderer | undefined
    let geometry: BufferGeometry | undefined
    let material: ShaderMaterial | undefined
    let resizeObserver: ResizeObserver | undefined
    let visibilityObserver: IntersectionObserver | undefined
    let raf = 0
    let visible = true
    let progress = 0
    let targetProgress = readProgress()
    let lastTime = performance.now()

    const showFallback = () => {
      fallback.hidden = false
      canvas.hidden = true
      stage.dataset.renderer = 'fallback'
      present(targetProgress, targetProgress)
    }

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
      })
      renderer.setClearColor(0x000000, 0)
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 40)
      camera.position.z = 8.4
      const random = (() => {
        let seedValue = 62893
        return () => {
          seedValue = (Math.imul(1664525, seedValue) + 1013904223) >>> 0
          return seedValue / 4294967296
        }
      })()
      const gauss = () =>
        Math.sqrt(-2 * Math.log(Math.max(0.0001, random()))) * Math.cos(Math.PI * 2 * random())
      const count = window.innerWidth < 600 ? 3600 : 6200
      const position = new Float32Array(count * 3)
      const target = new Float32Array(count * 3)
      const color = new Float32Array(count * 3)
      const size = new Float32Array(count)
      const particleSeed = new Float32Array(count)
      const fixed = new Float32Array(count)
      const orientation = new Float32Array(count)

      const path = new THREE.CurvePath<Vector3>()
      const segments = [
        [[-1, -1.6], [-1, -0.55], [-1, 0.55], [-1, 1.6]],
        [[-1, 1.6], [-0.05, 1.6], [1.18, 1.6], [1.18, 0]],
        [[1.18, 0], [1.18, -1.6], [-0.05, -1.6], [-1, -1.6]],
      ]
      for (const segment of segments) {
        path.add(
          new THREE.CubicBezierCurve3(
            ...segment.map(([x, y]) => new THREE.Vector3(x, y, 0)) as [
              Vector3,
              Vector3,
              Vector3,
              Vector3,
            ],
          ),
        )
      }
      const samples = path.getSpacedPoints(2400)

      for (let index = 0; index < count; index += 1) {
        const offset = index * 3
        particleSeed[index] = random()
        fixed[index] = index < count * 0.07 ? 1 : 0
        const warm = random() < 0.2
        const tone = random()
        color.set(
          warm
            ? [0.57 + tone * 0.13, 0.35 + tone * 0.12, 0.21 + tone * 0.12]
            : [0.18 + tone * 0.17, 0.26 + tone * 0.15, 0.27 + tone * 0.16],
          offset,
        )
        const flake = random()
        size[index] = flake > 0.94 ? 8 + random() * 6 : flake > 0.58 ? 4 + random() * 4 : 1.8 + random() * 3
        orientation[index] = random() * Math.PI * 2
        if (fixed[index]) {
          position.set([(random() - 0.5) * 17, (random() - 0.5) * 10, -1 - random() * 6], offset)
          target.set(position.subarray(offset, offset + 3), offset)
          size[index] *= 0.55
          continue
        }
        const side = index % 2 ? 1 : -1
        const ribbon = random()
        const width = 0.16 + 0.3 * Math.sin(ribbon * Math.PI)
        position.set(
          [
            side * (1.4 + ribbon * 4.3) + gauss() * 0.23,
            side * (Math.sin(ribbon * 5.5) * 1.1 - 0.22) + gauss() * width,
            gauss() * 0.3,
          ],
          offset,
        )
        const sampleIndex = Math.floor(random() * samples.length)
        const sample = samples[sampleIndex]
        const before = samples[Math.max(0, sampleIndex - 1)]
        const after = samples[Math.min(samples.length - 1, sampleIndex + 1)]
        const dx = after.x - before.x
        const dy = after.y - before.y
        const length = Math.hypot(dx, dy) || 1
        orientation[index] = Math.atan2(dy, dx)
        const dust = random() < 0.22
        const across = dust ? gauss() * 0.19 : (random() - 0.5) * 0.34 + gauss() * 0.022
        const along = gauss() * (dust ? 0.1 : 0.025)
        target.set(
          [
            sample.x + (-dy * across + dx * along) / length,
            sample.y + (dx * across + dy * along) / length,
            gauss() * (dust ? 0.19 : 0.08),
          ],
          offset,
        )
      }

      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
      geometry.setAttribute('aTarget', new THREE.BufferAttribute(target, 3))
      geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
      geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(particleSeed, 1))
      geometry.setAttribute('aFixed', new THREE.BufferAttribute(fixed, 1))
      geometry.setAttribute('aAngle', new THREE.BufferAttribute(orientation, 1))
      const uniforms = {
        uProgress: { value: 0 },
        uDpr: { value: 1 },
        uWidth: { value: 1 },
        uReduced: { value: reduced ? 1 : 0 },
      }
      material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
        vertexShader: `
          attribute vec3 aTarget;
          attribute vec3 aColor;
          attribute float aSize;
          attribute float aSeed;
          attribute float aFixed;
          attribute float aAngle;
          uniform float uProgress;
          uniform float uDpr;
          uniform float uWidth;
          uniform float uReduced;
          varying vec3 vColor;
          varying float vAlpha;
          varying float vAngle;
          varying float vSeed;
          void main() {
            float p = smoothstep(aSeed * .1, .9 + aSeed * .1, uProgress);
            vec3 start = position;
            start.x *= uWidth;
            vec3 destination = aTarget;
            destination.xy *= mix(1.3, uWidth, aFixed);
            destination.y += .35 * (1.0 - aFixed);
            vec3 pos = mix(start, destination, p);
            float travel = sin(p * 3.14159265) * (1.0 - aFixed);
            pos.xy += vec2(-start.y, start.x) * travel * .12;
            pos.z += travel * sin(aSeed * 19.0) * .45;
            float fade = 1.0;
            if (uReduced > .5) {
              pos = uProgress < .5 ? start : destination;
              fade = mix(abs(uProgress * 2.0 - 1.0), 1.0, aFixed);
            }
            vec4 mv = modelViewMatrix * vec4(pos, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(aSize * uDpr * (8.4 / -mv.z), 1.0, 70.0);
            vColor = aColor;
            vAlpha = mix(.78, .22, aFixed) * fade;
            vAngle = uReduced > .5 ? aAngle : mix(aSeed * 6.283185, aAngle, p) + travel * sin(aSeed * 32.0 + p * 8.0) * .45;
            vSeed = aSeed;
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          varying float vAlpha;
          varying float vAngle;
          varying float vSeed;
          void main() {
            vec2 uv = gl_PointCoord - .5;
            float c = cos(vAngle);
            float s = sin(vAngle);
            vec2 q = mat2(c, -s, s, c) * uv;
            vec2 grain = vSeed > .64 ? vec2(.43, .115) : vec2(.25, .21);
            float d = length(q / grain);
            if (d > 1.0) discard;
            float tooth = .78 + .22 * fract(sin(dot(floor(q * 45.0), vec2(12.9898, 78.233))) * 43758.5453);
            float alpha = (1.0 - smoothstep(.65, 1.0, d)) * tooth * vAlpha;
            gl_FragColor = vec4(vColor, alpha);
          }
        `,
      })
      const points = new THREE.Points(geometry, material)
      points.frustumCulled = false
      scene.add(points)

      const wake = () => {
        if (!raf && visible && !document.hidden) raf = requestAnimationFrame(render)
      }
      const resize = () => {
        const width = stage.clientWidth
        const height = stage.clientHeight
        camera.aspect = width / Math.max(1, height)
        camera.position.z = width < 600 ? 12.6 : 8.4
        camera.updateProjectionMatrix()
        const dpr = Math.min(window.devicePixelRatio, 1.6)
        renderer?.setPixelRatio(dpr)
        renderer?.setSize(width, height, false)
        uniforms.uDpr.value = dpr
        uniforms.uWidth.value = Math.min(1, camera.aspect / 1.65)
        targetProgress = readProgress()
      }
      function render(now: number) {
        raf = 0
        if (!visible || document.hidden || !renderer) return
        const delta = Math.min((now - lastTime) / 1000, 0.05)
        lastTime = now
        progress = reduced
          ? targetProgress
          : progress + (targetProgress - progress) * (1 - Math.exp(-delta * 15))
        if (Math.abs(progress - targetProgress) < 0.00005) progress = targetProgress
        uniforms.uProgress.value = progress
        present(progress, targetProgress)
        renderer.render(scene, camera)
        if (progress !== targetProgress) wake()
      }
      const onScroll = () => {
        targetProgress = readProgress()
        if (!fallback.hidden) present(targetProgress, targetProgress)
        wake()
      }
      const onVisibility = () => {
        if (document.hidden) {
          cancelAnimationFrame(raf)
          raf = 0
        } else {
          lastTime = performance.now()
          wake()
        }
      }
      const onMotion = () => {
        reduced = motionQuery.matches
        uniforms.uReduced.value = reduced ? 1 : 0
        wake()
      }
      const onContextLost = (event: Event) => {
        event.preventDefault()
        cancelAnimationFrame(raf)
        raf = 0
        visible = false
        targetProgress = readProgress()
        showFallback()
      }
      const onContextRestored = () => {
        fallback.hidden = true
        canvas.hidden = false
        stage.dataset.renderer = 'three-webgl'
        visible = true
        lastTime = performance.now()
        wake()
      }

      scroller.addEventListener('scroll', onScroll, { passive: true })
      document.addEventListener('visibilitychange', onVisibility)
      motionQuery.addEventListener('change', onMotion)
      canvas.addEventListener('webglcontextlost', onContextLost)
      canvas.addEventListener('webglcontextrestored', onContextRestored)
      resizeObserver = new ResizeObserver(() => {
        resize()
        wake()
      })
      resizeObserver.observe(stage)
      visibilityObserver = new IntersectionObserver((entries) => {
        visible = entries[0]?.isIntersecting ?? true
        if (!visible) {
          cancelAnimationFrame(raf)
          raf = 0
        } else {
          lastTime = performance.now()
          wake()
        }
      })
      visibilityObserver.observe(stage)
      resize()
      stage.dataset.renderer = 'three-webgl'
      stage.dataset.particles = String(count)
      wake()

      return () => {
        cancelAnimationFrame(raf)
        scroller.removeEventListener('scroll', onScroll)
        document.removeEventListener('visibilitychange', onVisibility)
        motionQuery.removeEventListener('change', onMotion)
        canvas.removeEventListener('webglcontextlost', onContextLost)
        canvas.removeEventListener('webglcontextrestored', onContextRestored)
        resizeObserver?.disconnect()
        visibilityObserver?.disconnect()
        geometry?.dispose()
        material?.dispose()
        renderer?.dispose()
      }
    } catch {
      renderer?.dispose()
      geometry?.dispose()
      material?.dispose()
      showFallback()
      const updateFallback = () => {
        targetProgress = readProgress()
        present(targetProgress, targetProgress)
      }
      scroller.addEventListener('scroll', updateFallback, { passive: true })
      window.addEventListener('resize', updateFallback)
      updateFallback()
      return () => {
        scroller.removeEventListener('scroll', updateFallback)
        window.removeEventListener('resize', updateFallback)
      }
    }
  }, [three])

  const enterWorkspace = () => {
    if (!ready || leaving) return
    setLeaving(true)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    leaveTimerRef.current = window.setTimeout(onEnter, reduced ? 120 : 680)
  }

  return (
    <main className={`paper-landing ${leaving ? 'is-leaving' : ''}`}>
      <div className="paper-landing__scroll" ref={scrollRef} tabIndex={0}>
        <section
          className="paper-landing__story"
          ref={storyRef}
          aria-label="滚动驱动的纸墨粒子汇聚"
        >
          <div className="paper-landing__stage" ref={stageRef} data-progress="0" data-phase="start">
            <div className="paper-landing__ambient" aria-hidden="true" />
            <canvas className="paper-landing__canvas" ref={canvasRef} aria-hidden="true" />
            <div className="paper-landing__vignette" aria-hidden="true" />
            <div className="paper-landing__fallback" ref={fallbackRef} hidden aria-hidden="true">
              D
            </div>
            <h1 className="paper-landing__sr-only">
              Build with Care。向下滚动，纸墨粒子汇聚成字母 D，完成后进入看着办。
            </h1>
            <div className="paper-landing__labels" ref={labelsRef} aria-hidden="true">
              <span>Build</span>
              <span>with Care</span>
            </div>
            <div
              className="paper-landing__entry"
              ref={entryRef}
              inert={!ready}
              aria-hidden={!ready}
            >
              <p className="paper-landing__entry-name">
                DELEGATE<span>交给它办</span>
              </p>
              <button type="button" onClick={enterWorkspace} tabIndex={ready ? 0 : -1}>
                进入「看着办」 <span aria-hidden="true">→</span>
              </button>
            </div>
            <div className="paper-landing__bottom" ref={bottomBarRef} aria-hidden="true">
              <span>↓</span>
            </div>
          </div>
        </section>
      </div>
      <div className="paper-landing__departure" aria-hidden="true" />
      <p className="paper-landing__sr-only" role="status" aria-live="polite">
        {ready ? '字母 D 已汇聚完成，可以进入看着办。' : ''}
      </p>
    </main>
  )
}
