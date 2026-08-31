import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  acquireSharedProxy,
  getProxyBaseURL,
  releaseSharedProxy,
  resetSharedProxyForTests,
} from "../../src/proxy.ts"

// Same-module singleton coverage. Do not cache-bust this import: the whole
// point is that every acquire in this file shares one listener.

async function withFakeHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "owc-singleton-"))
  mkdirSync(join(dir, ".config", "meridian"), { recursive: true })
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  }
  process.env.HOME = dir
  process.env.USERPROFILE = dir
  try {
    await fn()
  } finally {
    await resetSharedProxyForTests()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: server.address().port }
}

test("two acquires on the same module share one port", async () => {
  await withFakeHome(async () => {
    const first = await acquireSharedProxy({ port: 0, log: undefined })
    const second = await acquireSharedProxy({ port: 0, log: undefined })
    assert.equal(second.port, first.port)
  })
})

test("concurrent acquires still start only one listener", async () => {
  await withFakeHome(async () => {
    const [a, b, c] = await Promise.all([
      acquireSharedProxy({ port: 0, log: undefined }),
      acquireSharedProxy({ port: 0, log: undefined }),
      acquireSharedProxy({ port: 0, log: undefined }),
    ])
    assert.equal(b.port, a.port)
    assert.equal(c.port, a.port)
  })
})

test("handle.close does not kill the shared listener", async () => {
  await withFakeHome(async () => {
    const proxy = await acquireSharedProxy({ port: 0, log: undefined })
    await proxy.close()
    const res = await fetch(`${getProxyBaseURL(proxy.port)}/health`, {
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.status, "string")
  })
})

test("releaseSharedProxy closes only after the last acquire", async () => {
  await withFakeHome(async () => {
    const first = await acquireSharedProxy({ port: 0, log: undefined })
    const second = await acquireSharedProxy({ port: 0, log: undefined })
    await releaseSharedProxy()
    const stillUp = await fetch(`${getProxyBaseURL(first.port)}/health`, {
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(stillUp.status, 200)
    await releaseSharedProxy()
    await assert.rejects(
      () =>
        fetch(`${getProxyBaseURL(second.port)}/health`, {
          signal: AbortSignal.timeout(2_000),
        }),
    )
  })
})

test("EADDRINUSE on a Meridian /health is adopted, not duplicated", async () => {
  const { server, port } = await listen((req, res) => {
    if (!req.url?.startsWith("/health")) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ status: "healthy", version: "test" }))
  })

  try {
    await withFakeHome(async () => {
      const proxy = await acquireSharedProxy({ port, log: undefined })
      assert.equal(proxy.port, port)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("EADDRINUSE on a non-Meridian port falls back to one shared listener", async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("not meridian")
  })

  try {
    await withFakeHome(async () => {
      const logs = []
      const proxy = await acquireSharedProxy({
        port,
        log: async (level, message) => {
          logs.push({ level, message })
        },
      })
      assert.notEqual(proxy.port, port)
      assert.ok(
        logs.some(
          (l) =>
            l.level === "warn" &&
            l.message.includes("another process") &&
            l.message.includes("fallback"),
        ),
      )
      const second = await acquireSharedProxy({ port, log: undefined })
      assert.equal(second.port, proxy.port)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
