import { useEffect, useRef } from 'react'
import ShuffleText from 'shuffle-text'

export function ShuffleLabel({ children }: { children: string }) {
  const visual = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = visual.current
    if (!element) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const effect = new ShuffleText(element)
    effect.setText(children)
    effect.duration = 480
    effect.sourceRandomCharacter = '＋－＝／０１２３４５６７８９'
    effect.emptyCharacter = '　'
    const finish = () => {
      effect.stop()
      element.textContent = children
    }
    // Restoring the full text is immediate if the user changes their motion preference.
    const onPreference = () => {
      if (preference.matches) finish()
    }
    preference.addEventListener('change', onPreference)
    if (preference.matches) finish()
    else effect.start()
    return () => {
      preference.removeEventListener('change', onPreference)
      effect.dispose()
      element.textContent = children
    }
  }, [children])
  return (
    <span className="shuffle-label">
      <span className="shuffle-static">{children}</span>
      <span className="shuffle-visual" aria-hidden="true" ref={visual}>
        {children}
      </span>
    </span>
  )
}
