// SPDX-License-Identifier: Apache-2.0
import type { ToolExtension } from '../extensions.js'

/** Bounded arithmetic only: no JavaScript, functions, assignments or exponents. */
export function calculate(expression: string): number {
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > 256) {
    throw new Error('Expression must contain 1..256 characters')
  }
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%]|\S/g) ?? []
  if (tokens.length > 128) throw new Error('Expression has too many tokens')
  let index = 0
  let depth = 0
  const checked = (value: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new Error('Arithmetic result is out of range')
    return value
  }
  const atom = (): number => {
    if (++depth > 24) throw new Error('Expression is too deeply nested')
    try {
      const token = tokens[index++]
      if (token === '+' || token === '-') return checked((token === '-' ? -1 : 1) * atom())
      if (token === '(') {
        const value = sum()
        if (tokens[index++] !== ')') throw new Error('Expected closing parenthesis')
        return value
      }
      if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new Error('Expected a number or parenthesis')
      return checked(Number(token))
    } finally { depth-- }
  }
  const product = (): number => {
    let value = atom()
    while (['*', '/', '%'].includes(tokens[index] ?? '')) {
      const operation = tokens[index++]
      const right = atom()
      if ((operation === '/' || operation === '%') && right === 0) throw new Error('Division by zero')
      value = checked(operation === '*' ? value * right : operation === '/' ? value / right : value % right)
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operation = tokens[index++]
      const right = product()
      value = checked(operation === '+' ? value + right : value - right)
    }
    return value
  }
  const result = sum()
  if (index !== tokens.length) throw new Error('Unexpected arithmetic token')
  return result
}

/** Pure tool pack shared by CLI and desktop; no host capabilities or lifecycle hooks. */
export const calculatorExtension: ToolExtension = {
  id: 'vivi.calculator',
  apiVersion: 1,
  tools: [{
    definition: {
      name: 'calculate',
      description: 'Evaluate bounded arithmetic (+ - * / % and parentheses). No code execution.',
      parameters: {
        type: 'object', properties: { expression: { type: 'string', maxLength: 256 } },
        required: ['expression'], additionalProperties: false
      }
    },
    validateArguments(arguments_) {
      if (Object.keys(arguments_).some((key) => key !== 'expression')) throw new Error('Unexpected argument')
      if (typeof arguments_.expression !== 'string') throw new Error('expression must be a string')
      // Preserve CLI validation errors (including invalid expressions) as invalid_arguments.
      calculate(arguments_.expression)
    },
    execute(call, { signal }) {
      signal.throwIfAborted()
      return { content: JSON.stringify({ result: calculate(call.arguments.expression as string) }) }
    }
  }]
}
