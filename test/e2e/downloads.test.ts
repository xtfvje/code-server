import * as path from "path"
import { promises as fs } from "fs"
import { clean } from "../utils/helpers"
import { describe, test, expect } from "./baseFixture"

describe("Downloads (enabled)", true, [], {}, async () => {
  const testName = "downloads-enabled"
  test.beforeAll(async () => {
    await clean(testName)
  })

  test("should see the 'Download...' option", async ({ codeServerPage }) => {
    // Setup
    const workspaceDir = await codeServerPage.workspaceDir
    const tmpFilePath = path.join(workspaceDir, "unique-file.txt")
    await fs.writeFile(tmpFilePath, "hello world")

    // Action
    const fileInExplorer = await codeServerPage.page.waitForSelector("text=unique-file.txt")
    await fileInExplorer.click({
      button: "right",
    })

    expect(await codeServerPage.page.isVisible("text=Download...")).toBe(true)
  })
})

describe("Downloads (disabled)", true, ["--disable-file-downloads"], {}, async () => {
  const testName = "downloads-disabled"
  test.beforeAll(async () => {
    await clean(testName)
  })

  test("should not see the 'Download...' option", async ({ codeServerPage }) => {
    // Setup
    const workspaceDir = await codeServerPage.workspaceDir
    const tmpFilePath = path.join(workspaceDir, "unique-file.txt")
    await fs.writeFile(tmpFilePath, "hello world")

    // Action
    const fileInExplorer = await codeServerPage.page.waitForSelector("text=unique-file.txt")
    await fileInExplorer.click({
      button: "right",
    })

    expect(await codeServerPage.page.isVisible("text=Download...")).toBe(false)
  })
})
