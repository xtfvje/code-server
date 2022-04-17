import { promises as fs } from "fs"
import { clean, getAvailablePort, tmpdir, useEnv } from "../../test/utils/helpers"

/**
 * This file is for testing test helpers (not core code).
 */
describe("test helpers", () => {
  const testName = "temp-dir"
  beforeAll(async () => {
    await clean(testName)
  })

  it("should return a temp directory", async () => {
    const pathToTempDir = await tmpdir(testName)
    expect(pathToTempDir).toContain(testName)
    expect(fs.access(pathToTempDir)).resolves.toStrictEqual(undefined)
  })
})

describe("useEnv", () => {
  beforeAll(() => {
    jest.resetModules()
    process.env.TEST_USE_ENV = "test environment variable"
  })
  afterAll(() => {
    delete process.env.TEST_USE_ENV
  })
  it("should set and reset the env var", () => {
    const envKey = "TEST_ENV_VAR"
    const [setValue, resetValue] = useEnv(envKey)
    setValue("hello-world")
    expect(process.env[envKey]).toEqual("hello-world")
    resetValue()
    expect(process.env[envKey]).toEqual(undefined)
  })
  it("should set and reset the env var where a value was already set", () => {
    const envKey = "TEST_USE_ENV"
    expect(process.env[envKey]).toEqual("test environment variable")
    const [setValue, resetValue] = useEnv(envKey)
    setValue("hello there")
    expect(process.env[envKey]).toEqual("hello there")
    resetValue()
    expect(process.env[envKey]).toEqual("test environment variable")
  })
})

describe("getAvailablePort", () => {
  it("should return a valid port", async () => {
    const port = await getAvailablePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })
  it("should return different ports for different calls", async () => {
    const portOne = await getAvailablePort()
    const portTwo = await getAvailablePort()
    expect(portOne).not.toEqual(portTwo)
  })
})
