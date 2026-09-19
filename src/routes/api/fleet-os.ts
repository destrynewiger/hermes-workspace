import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { handleFleetHttp } from '../../server/fleet-os/api-handlers'
import { getFleetPlane } from '../../server/fleet-os/runtime'

export const Route = createFileRoute('/api/fleet-os')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const result = await handleFleetHttp(getFleetPlane(), 'GET', url.searchParams, null)
        return json(result.body, { status: result.status })
      },
      POST: async ({ request }) => {
        let body: Record<string, unknown>
        try {
          body = await request.json() as Record<string, unknown>
        } catch {
          return json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        const result = await handleFleetHttp(getFleetPlane(), 'POST', new URL(request.url).searchParams, body)
        return json(result.body, { status: result.status })
      },
    },
  },
})
