import type { RunState } from '../shared/types.js'
import type { Store } from './store.js'

export function eventDetails(store: Store, run: RunState, sequence: number) {
  const events = store.events(run.id)
  const event = events.find((entry) => entry.seq === sequence)
  if (!event || event.type === 'run.control-reclassified') return undefined
  const data = event.data as any
  const gate = data?.gate ?? run.gates.find((entry) => entry.id === data?.gateId)
  const step = run.steps.find(
    (entry) => entry.id === (data?.step?.id ?? data?.stepId ?? gate?.stepId),
  )
  const unit = run.workUnits?.find((unit) => unit.id === (data?.unitId ?? step?.unitId))
  const related = step
    ? events.filter((entry) => {
        const value = entry.data as any
        return (
          value?.stepId === step.id ||
          value?.step?.id === step.id ||
          value?.gate?.stepId === step.id
        )
      })
    : []
  const request = events
    .filter((entry) => entry.type === 'model.request' && entry.seq <= sequence)
    .at(-1)
  const nextRequest =
    request && events.find((entry) => entry.type === 'model.request' && entry.seq > request.seq)
  const raw = request
    ? store
        .rawEvents(run.id)
        .filter(
          (entry) =>
            entry.time >= Date.parse(request.at) &&
            (!nextRequest || entry.time < Date.parse(nextRequest.at)),
        )
    : []
  const response = raw.find((entry) => entry.type === 'assistant/message')
  const message = response?.data.message
  return {
    event,
    ...(unit
      ? { workUnit: unit, unitSteps: run.steps.filter((step) => step.unitId === unit.id) }
      : {}),
    ...(step
      ? {
          action: step,
          relatedEvents: related,
          checks: run.verifications.filter((entry) => entry.stepId === step.id),
        }
      : {}),
    ...(gate ? { gate } : {}),
    ...(request && (event.type.startsWith('model.') || step || event.type === 'run.error')
      ? {
          modelRequest: request,
          ...(response
            ? {
                modelResponse: {
                  at: new Date(response.time).toISOString(),
                  elapsedMs: response.time - Date.parse(request.at),
                  model: message?.source?.model,
                  usage: response.data.usage,
                  reasoningCharacters: (message?.content ?? [])
                    .filter((block: any) => block.type === 'reasoning')
                    .reduce((count: number, block: any) => count + block.text.length, 0),
                  content: (message?.content ?? []).filter(
                    (block: any) => block.type !== 'reasoning',
                  ),
                },
              }
            : { modelResponse: null }),
          streamFailure: raw.find(
            (entry) =>
              entry.type === 'assistant/chunk' &&
              ['error', 'aborted'].includes(entry.data.chunk?.reason?.kind),
          )?.data.chunk,
        }
      : {}),
  }
}
