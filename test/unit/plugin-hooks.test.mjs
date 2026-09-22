import assert from "node:assert/strict"
import test, { after, before } from "node:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let resetSharedProxyForTests
let contextHook
let requestHook
let provider
let fakeHomeDir
let previousEnv

before(async () => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), "owc-hooks-"))
  mkdirSync(join(fakeHomeDir, ".config", "meridian"), { recursive: true })
  previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_PROXY_PORT: process.env.CLAUDE_PROXY_PORT,
  }
  process.env.HOME = fakeHomeDir
  process.env.USERPROFILE = fakeHomeDir
  process.env.CLAUDE_PROXY_PORT = "0"

  const pluginModule = await import(
    `../../dist/index.js?t=${Date.now()}${Math.random()}`
  )
  const plugin = pluginModule.default
  resetSharedProxyForTests = pluginModule.resetSharedProxyForTests
  provider = { settings: { baseURL: "https://api.anthropic.com" } }
  const ctx = {
    location: { directory: "/work/project" },
    agent: {
      transform: async (callback) => {
        callback({
          list: () => [
            { id: "explore", name: "Explore", mode: "subagent" },
            { id: "build", name: "Build", mode: "primary" },
          ],
        })
      },
    },
    provider: {
      transform: async (callback) => {
        callback({
          update: (id, update) => {
            if (id === "anthropic") update(provider)
          },
        })
      },
    },
    session: {
      hook: async (name, callback) => {
        if (name === "context") contextHook = callback
        if (name === "http.request") requestHook = callback
      },
    },
  }
  await plugin.setup(ctx)
})

after(async () => {
  await resetSharedProxyForTests?.()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fakeHomeDir, { recursive: true, force: true })
})

test("exports a V2 plugin definition", async () => {
  const { default: plugin } = await import("../../dist/index.js")
  assert.equal(plugin.id, "opencode-with-claude")
  assert.equal(typeof plugin.setup, "function")
})

test("provider transform points Anthropic at the owned proxy", () => {
  assert.match(provider.settings.baseURL, /^http:\/\/.+:\d+$/)
})

test("context hook scrubs fingerprints while preserving user context", async () => {
  const event = {
    model: { providerID: "anthropic" },
    system: [
      { type: "text", text: "You are OpenCode, the best coding agent on the planet." },
      { type: "text", text: "Project-specific instructions remain." },
    ],
  }
  await contextHook(event)
  assert.equal(event.system.length, 2)
  assert.doesNotMatch(event.system[0].text, /OpenCode/)
  assert.match(event.system[0].text, /Project-specific instructions remain/)
})

test("context hook counter-instructs the CLI's scratchpad advertisement", async () => {
  const event = {
    model: { providerID: "anthropic" },
    system: [{ type: "text", text: "Project-specific instructions." }],
  }
  await contextHook(event)
  const policy = event.system.at(-1).text
  assert.match(policy, /project working directory/)
  assert.match(policy, /scratchpad/)
})

test("context hook tells Meridian the location's working directory", async () => {
  const event = {
    model: { providerID: "anthropic" },
    system: [{ type: "text", text: "Project-specific instructions." }],
  }
  await contextHook(event)
  // Same pattern as Meridian's extractClientCwd.
  const text = event.system.map((part) => part.text).join("\n")
  const match = text.match(/<env>\s*[\s\S]*?Working directory:\s*([^\n<]+)/i)
  assert.equal(match?.[1]?.trim(), "/work/project")
})

test("context hook keeps the directory OpenCode reported after scrubbing its <env>", async () => {
  const event = {
    model: { providerID: "anthropic" },
    system: [
      {
        type: "text",
        text:
          "Instructions.\nHere is some useful information about the environment you are running in:\n" +
          "<env>\n  Working directory: /from/opencode\n  Platform: darwin\n</env>\nMore.",
      },
    ],
  }
  await contextHook(event)
  const text = event.system.map((part) => part.text).join("\n")
  assert.equal(text.match(/Working directory:/g).length, 1)
  const match = text.match(/<env>\s*[\s\S]*?Working directory:\s*([^\n<]+)/i)
  assert.equal(match?.[1]?.trim(), "/from/opencode")
})

test("request hook strips beta flags and adds Meridian session headers", async () => {
  const event = {
    sessionID: "sess-123",
    agent: "explore",
    model: { providerID: "anthropic" },
    request: new Request("http://localhost/messages", {
      headers: { "anthropic-beta": "flag", keep: "me" },
    }),
  }
  await requestHook(event)
  assert.equal(event.request.headers.get("anthropic-beta"), null)
  assert.equal(event.request.headers.get("x-opencode-session"), "sess-123")
  assert.match(event.request.headers.get("x-opencode-request"), /^[0-9a-f-]{36}$/)
  assert.equal(event.request.headers.get("x-opencode-agent-mode"), "subagent")
  assert.equal(event.request.headers.get("x-opencode-agent-name"), "explore")
  assert.equal(event.request.headers.get("keep"), "me")
})

test("request hook keeps utility agents out of the conversation's session", async () => {
  for (const agent of ["title", "summary", "compaction"]) {
    const event = {
      sessionID: "sess-123",
      agent,
      model: { providerID: "anthropic" },
      request: new Request("http://localhost/messages"),
    }
    await requestHook(event)
    assert.equal(event.request.headers.get("x-opencode-session"), `sess-123:${agent}`)
  }
})

test("hooks ignore non-Anthropic requests", async () => {
  const system = [{ type: "text", text: "You are OpenCode" }]
  await contextHook({ model: { providerID: "openai" }, system })
  assert.deepEqual(system, [{ type: "text", text: "You are OpenCode" }])

  const request = new Request("http://localhost", {
    headers: { "anthropic-beta": "keep" },
  })
  await requestHook({
    sessionID: "s",
    agent: "build",
    model: { providerID: "openai" },
    request,
  })
  assert.equal(request.headers.get("anthropic-beta"), "keep")
})
