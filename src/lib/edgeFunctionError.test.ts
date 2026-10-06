import { describe, expect, it } from 'vitest'

import { edgeFunctionFailure } from './edgeFunctionError'

describe('edgeFunctionFailure', () => {
  it('extracts a safe JSON error and status from invocation context', async () => {
    const context = Response.json({ error: 'This module is not part of your curriculum' }, { status: 403 })
    await expect(edgeFunctionFailure({ context }, 'Unavailable')).resolves.toEqual({
      message: 'This module is not part of your curriculum',
      status: 403,
    })
  })

  it('does not expose a non-JSON response body', async () => {
    const context = new Response('internal trace', { status: 500 })
    await expect(edgeFunctionFailure({ context }, 'Try again later.')).resolves.toEqual({
      message: 'Try again later.',
      status: 500,
    })
  })
})
