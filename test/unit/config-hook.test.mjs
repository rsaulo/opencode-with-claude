import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../../dist/index.js"

test("bundle exposes one V2 default plugin entry", () => {
  assert.equal(plugin.id, "opencode-with-claude")
  assert.equal(typeof plugin.setup, "function")
})
