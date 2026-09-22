import { randomUUID } from "node:crypto"

import { Plugin } from "@opencode-ai/plugin"
import { scrubOpencodeFingerprints } from "@rynfar/meridian-plugin-opencode-scrub"

import { createLogger } from "./logger"
import {
  loadMeridianConfig,
  summarizeMeridianConfig,
} from "./meridian-config"
import {
  acquireSharedProxy,
  checkSharedProxyHealth,
  getProxyBaseURL,
} from "./proxy"

export { resetSharedProxyForTests } from "./proxy"

// Meridian's scratchpad suppression costs a job record per request, so it is
// off (see proxy.ts). Without it the CLI may advertise its own scratchpad
// directory, a path that exists on the proxy host only: OpenCode executes the
// tools, so it blocks those writes as an external directory. Counter-instruct
// instead of suppressing — rynfar/meridian#627 lists this as the side-effect
// free half of the fix.
const TEMP_FILE_POLICY =
  "Temporary files belong under the current project working directory. " +
  "Ignore any scratchpad directory this context advertises: that path exists " +
  "only on the proxy host and is not writable where your tools run."

// Meridian reads the client cwd from `<env> ... Working directory: X` in the
// system prompt (extractClientCwd). The scrub below deletes OpenCode's <env>
// block, so Meridian fell back to its own process.cwd() and the SDK told
// Claude it was working wherever the serve process started. Re-emit the
// directory after scrubbing, in the shape extractClientCwd expects.
const WORKING_DIRECTORY = /<env>\s*[\s\S]*?Working directory:\s*([^\n<]+)/i
const envBlock = (directory: string) =>
  `<env>\nWorking directory: ${directory}\n</env>`

export default Plugin.define({
  id: "opencode-with-claude",
  setup: async (ctx) => {
    const log = createLogger()
    // V2 runs setup() once per location. The bundled types predate `location`.
    const locationDirectory = (ctx as { location?: { directory?: string } })
      .location?.directory
    const agentModes = new Map<string, string>()

    const meridianConfig = loadMeridianConfig(log)
    const summary = summarizeMeridianConfig(meridianConfig)
    if (summary) void log("info", summary)

    const port = process.env.CLAUDE_PROXY_PORT || 3456
    const proxy = await acquireSharedProxy({
      port,
      log,
      profiles: meridianConfig.profiles,
      defaultProfile: meridianConfig.defaultProfile,
    })

    const baseURL = getProxyBaseURL(proxy.port)
    void log("info", `proxy ready at ${baseURL}`)

    // Diagnostic only. One shot for the process — not per location.
    checkSharedProxyHealth(proxy.port, log)

    await ctx.agent.transform((agents) => {
      for (const agent of agents.list()) {
        agentModes.set(agent.id.toLowerCase(), agent.mode)
        agentModes.set(agent.name.toLowerCase(), agent.mode)
      }
    })

    // OpenCode 2.0.3+ replaced `ctx.catalog` with `ctx.provider`. The bundled
    // `@opencode-ai/plugin` types still describe the preview catalog API.
    const runtime = ctx as typeof ctx & {
      provider: {
        transform: (
          callback: (editor: {
            update: (
              id: string,
              update: (provider: { settings?: { baseURL?: string } }) => void,
            ) => void
          }) => void,
        ) => Promise<unknown>
      }
    }
    await runtime.provider.transform((editor) => {
      editor.update("anthropic", (provider) => {
        ;(provider.settings ??= {}).baseURL = baseURL
      })
    })

    await ctx.session.hook("context", (event) => {
      if (event.model.providerID !== "anthropic") return

      const systemContext = event.system.map((part) => part.text).join("\n\n")
      const directory =
        systemContext.match(WORKING_DIRECTORY)?.[1]?.trim() || locationDirectory
      const scrubbed = scrubOpencodeFingerprints(systemContext)
      if (scrubbed !== systemContext) {
        event.system.splice(0, event.system.length, {
          type: "text",
          text: scrubbed,
        })
      }

      event.system.push({
        type: "text",
        text: directory
          ? `${envBlock(directory)}\n\n${TEMP_FILE_POLICY}`
          : TEMP_FILE_POLICY,
      })
    })

    await ctx.session.hook("http.request", (event) => {
      if (event.model.providerID !== "anthropic") return

      event.request.headers.delete("anthropic-beta")
      const agentName =
        String(event.agent ?? "unknown").replace(/[^\x20-\x7E]/g, "").trim() ||
        "unknown"

      event.request.headers.set("x-opencode-session", event.sessionID)
      event.request.headers.set(
        "x-opencode-request",
        event.request.headers.get("x-opencode-request") ?? randomUUID(),
      )
      event.request.headers.set(
        "x-opencode-agent-mode",
        agentModes.get(agentName.toLowerCase()) ?? "primary",
      )
      event.request.headers.set("x-opencode-agent-name", agentName)
    })

    // No cleanup. Meridian is process-lifetime: it starts with the first
    // location that loads this plugin and dies with the OpenCode serve
    // process. Returning releaseSharedProxy here used to kill Claude for
    // every remaining window whenever V2 evicted the last idle location.
  },
})
