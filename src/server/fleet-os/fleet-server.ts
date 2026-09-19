#!/usr/bin/env node
/**
 * Standalone Fleet OS HTTP control plane.
 *
 *   pnpm fleet-server --port 8787
 *   FLEET_OS_HOME=~/.hermes/fleet-os FLEET_LEDGER_PATH=... pnpm fleet-server
 *
 * Tailscale hosts then set:
 *   FLEET_OS_URL=http://oakland-mini:8787
 */
import { createServer } from 'node:http'
import { getFleetPlane } from './runtime'
import { handleFleetHttp } from './api-handlers'
import { fleetOsHome } from './store'

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

async function main() {
  const plane = getFleetPlane({ seed: true })
  const home = process.env.FLEET_OS_HOME ?? fleetOsHome()

  const port = Number(arg('port', process.env.FLEET_OS_PORT ?? '8787'))
  const host = arg('host', process.env.FLEET_OS_HOST ?? '127.0.0.1')!

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    let body: Record<string, unknown> | null = null
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim()) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
          return
        }
      } else {
        body = {}
      }
    }
    try {
      const result = await handleFleetHttp(plane, req.method ?? 'GET', url.searchParams, body)
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  })

  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  console.log(JSON.stringify({
    listening: `http://${host}:${port}`,
    home,
    machines: plane.snapshot().machines.map((item) => item.id),
    health: plane.fleetHealth(),
  }))

  if (process.argv.includes('--once-ready')) {
    // used by tests: print ready and keep serving until parent kills
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
