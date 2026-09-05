import { expect, it } from 'vitest'
import { parseReviewResult } from '../server/reviewer.js'

const constraints = [
  { id: 'memory', text: '刷新后清空', source: 'human', revision: 1, active: true },
]
const response = {
  classification: 'conflict',
  title: '保留数据',
  summary: '刷新后仍保留数据',
  impact: '与要求冲突',
  constraintIds: ['memory'],
  evidence: 'localStorage.setItem',
  options: [],
  topic: 'storage',
}
it('preserves multiple evidence strings without changing the conflict verdict', () => {
  const evidence = ['localStorage.setItem', '读取保存记录'.repeat(300)]
  const result = parseReviewResult(JSON.stringify({ ...response, evidence }), constraints)
  expect(result.evidence).toBe(evidence.join('\n'))
  expect(result.classification).toBe('conflict')
  expect(result.constraintIds).toEqual(['memory'])
  expect(parseReviewResult(JSON.stringify(response), constraints).evidence).toBe(response.evidence)
})
it('rejects absent evidence, invalid citations and arbitrary objects without leaking schema errors', () => {
  for (const evidence of [[], ['', '  ']])
    expect(() => parseReviewResult(JSON.stringify({ ...response, evidence }), constraints)).toThrow(
      '未提供冲突所需',
    )
  expect(() =>
    parseReviewResult(JSON.stringify({ ...response, constraintIds: ['invented'] }), constraints),
  ).toThrow('不存在或已失效')
  for (const evidence of [null, {}, [42], [{ quote: 'x' }]]) {
    expect(() => parseReviewResult(JSON.stringify({ ...response, evidence }), constraints)).toThrow(
      '证据格式不完整',
    )
    try {
      parseReviewResult(JSON.stringify({ ...response, evidence }), constraints)
    } catch (error) {
      expect(String(error)).not.toMatch(/invalid_type|expected|Zod|path/)
    }
  }
})
