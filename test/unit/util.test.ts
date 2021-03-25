import { JSDOM } from "jsdom"
import {
  arrayify,
  generateUuid,
  getFirstString,
  getOptions,
  logError,
  plural,
  resolveBase,
  split,
  trimSlashes,
  normalize,
} from "../../src/common/util"
import { Cookie as CookieEnum } from "../../src/node/routes/login"
import { hash } from "../../src/node/util"
import { PASSWORD } from "../utils/constants"
import { checkForCookie, createCookieIfDoesntExist, loggerModule, Cookie } from "../utils/helpers"

const dom = new JSDOM()
global.document = dom.window.document

type LocationLike = Pick<Location, "pathname" | "origin">

// jest.mock is hoisted above the imports so we must use `require` here.
jest.mock("@coder/logger", () => require("../utils/helpers").loggerModule)

describe("util", () => {
  describe("normalize", () => {
    it("should remove multiple slashes", () => {
      expect(normalize("//foo//bar//baz///mumble")).toBe("/foo/bar/baz/mumble")
    })

    it("should remove trailing slashes", () => {
      expect(normalize("qux///")).toBe("qux")
    })

    it("should preserve trailing slash if it exists", () => {
      expect(normalize("qux///", true)).toBe("qux/")
      expect(normalize("qux", true)).toBe("qux")
    })
  })

  describe("split", () => {
    it("should split at a comma", () => {
      expect(split("Hello,world", ",")).toStrictEqual(["Hello", "world"])
    })

    it("shouldn't split if the delimiter doesn't exist", () => {
      expect(split("Hello world", ",")).toStrictEqual(["Hello world", ""])
    })
  })

  describe("plural", () => {
    it("should add an s if count is greater than 1", () => {
      expect(plural(2, "dog")).toBe("dogs")
    })
    it("should NOT add an s if the count is 1", () => {
      expect(plural(1, "dog")).toBe("dog")
    })
  })

  describe("generateUuid", () => {
    it("should generate a unique uuid", () => {
      const uuid = generateUuid()
      const uuid2 = generateUuid()
      expect(uuid).toHaveLength(24)
      expect(typeof uuid).toBe("string")
      expect(uuid).not.toBe(uuid2)
    })
    it("should generate a uuid of a specific length", () => {
      const uuid = generateUuid(10)
      expect(uuid).toHaveLength(10)
    })
  })

  describe("trimSlashes", () => {
    it("should remove leading slashes", () => {
      expect(trimSlashes("/hello-world")).toBe("hello-world")
    })

    it("should remove trailing slashes", () => {
      expect(trimSlashes("hello-world/")).toBe("hello-world")
    })

    it("should remove both leading and trailing slashes", () => {
      expect(trimSlashes("/hello-world/")).toBe("hello-world")
    })

    it("should remove multiple leading and trailing slashes", () => {
      expect(trimSlashes("///hello-world////")).toBe("hello-world")
    })
  })

  describe("resolveBase", () => {
    beforeEach(() => {
      const location: LocationLike = {
        pathname: "/healthz",
        origin: "http://localhost:8080",
      }

      // Because resolveBase is not a pure function
      // and relies on the global location to be set
      // we set it before all the tests
      // and tell TS that our location should be looked at
      // as Location (even though it's missing some properties)
      global.location = location as Location
    })

    it("should resolve a base", () => {
      expect(resolveBase("localhost:8080")).toBe("/localhost:8080")
    })

    it("should resolve a base with a forward slash at the beginning", () => {
      expect(resolveBase("/localhost:8080")).toBe("/localhost:8080")
    })

    it("should resolve a base with query params", () => {
      expect(resolveBase("localhost:8080?folder=hello-world")).toBe("/localhost:8080")
    })

    it("should resolve a base with a path", () => {
      expect(resolveBase("localhost:8080/hello/world")).toBe("/localhost:8080/hello/world")
    })

    it("should resolve a base to an empty string when not provided", () => {
      expect(resolveBase()).toBe("")
    })
  })

  describe("getOptions", () => {
    beforeEach(() => {
      const location: LocationLike = {
        pathname: "/healthz",
        origin: "http://localhost:8080",
        // search: "?environmentId=600e0187-0909d8a00cb0a394720d4dce",
      }

      // Because resolveBase is not a pure function
      // and relies on the global location to be set
      // we set it before all the tests
      // and tell TS that our location should be looked at
      // as Location (even though it's missing some properties)
      global.location = location as Location
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    it("should return options with base and cssStaticBase even if it doesn't exist", () => {
      expect(getOptions()).toStrictEqual({
        base: "",
        csStaticBase: "",
      })
    })

    it("should return options when they do exist", () => {
      // Mock getElementById
      const spy = jest.spyOn(document, "getElementById")
      // Create a fake element and set the attribute
      const mockElement = document.createElement("div")
      mockElement.setAttribute(
        "data-settings",
        '{"base":".","csStaticBase":"./static/development/Users/jp/Dev/code-server","logLevel":2,"disableTelemetry":false,"disableUpdateCheck":false}',
      )
      // Return mockElement from the spy
      // this way, when we call "getElementById"
      // it returns the element
      spy.mockImplementation(() => mockElement)

      expect(getOptions()).toStrictEqual({
        base: "",
        csStaticBase: "/static/development/Users/jp/Dev/code-server",
        disableTelemetry: false,
        disableUpdateCheck: false,
        logLevel: 2,
      })
    })

    it("should include queryOpts", () => {
      // Trying to understand how the implementation works
      // 1. It grabs the search params from location.search (i.e. ?)
      // 2. it then grabs the "options" param if it exists
      // 3. then it creates a new options object
      // spreads the original options
      // then parses the queryOpts
      location.search = '?options={"logLevel":2}'
      expect(getOptions()).toStrictEqual({
        base: "",
        csStaticBase: "",
        logLevel: 2,
      })
    })
  })

  describe("arrayify", () => {
    it("should return value it's already an array", () => {
      expect(arrayify(["hello", "world"])).toStrictEqual(["hello", "world"])
    })

    it("should wrap the value in an array if not an array", () => {
      expect(
        arrayify({
          name: "Coder",
          version: "3.8",
        }),
      ).toStrictEqual([{ name: "Coder", version: "3.8" }])
    })

    it("should return an empty array if the value is undefined", () => {
      expect(arrayify(undefined)).toStrictEqual([])
    })
  })

  describe("getFirstString", () => {
    it("should return the string if passed a string", () => {
      expect(getFirstString("Hello world!")).toBe("Hello world!")
    })

    it("should get the first string from an array", () => {
      expect(getFirstString(["Hello", "World"])).toBe("Hello")
    })

    it("should return undefined if the value isn't an array or a string", () => {
      expect(getFirstString({ name: "Coder" })).toBe(undefined)
    })
  })

  describe("logError", () => {
    afterEach(() => {
      jest.clearAllMocks()
    })

    afterAll(() => {
      jest.restoreAllMocks()
    })

    it("should log an error with the message and stack trace", () => {
      const message = "You don't have access to that folder."
      const error = new Error(message)

      logError("ui", error)

      expect(loggerModule.logger.error).toHaveBeenCalled()
      expect(loggerModule.logger.error).toHaveBeenCalledWith(`ui: ${error.message} ${error.stack}`)
    })

    it("should log an error, even if not an instance of error", () => {
      logError("api", "oh no")

      expect(loggerModule.logger.error).toHaveBeenCalled()
      expect(loggerModule.logger.error).toHaveBeenCalledWith("api: oh no")
    })
  })

  describe("checkForCookie", () => {
    it("should check if the cookie exists and has a value", () => {
      const fakeCookies: Cookie[] = [
        {
          name: CookieEnum.Key,
          value: hash(PASSWORD),
          domain: "localhost",
          secure: false,
          sameSite: "Lax",
          httpOnly: false,
          expires: 18000,
          path: "/",
        },
      ]
      expect(checkForCookie(fakeCookies, CookieEnum.Key)).toBe(true)
    })
    it("should return false if there are no cookies", () => {
      const fakeCookies: Cookie[] = []
      expect(checkForCookie(fakeCookies, "key")).toBe(false)
    })
  })

  describe("createCookieIfDoesntExist", () => {
    it("should create a cookie if it doesn't exist", () => {
      const cookies: Cookie[] = []
      const cookieToStore = {
        name: CookieEnum.Key,
        value: hash(PASSWORD),
        domain: "localhost",
        secure: false,
        sameSite: "Lax" as const,
        httpOnly: false,
        expires: 18000,
        path: "/",
      }
      expect(createCookieIfDoesntExist(cookies, cookieToStore)).toStrictEqual([cookieToStore])
    })
    it("should return the same cookies if the cookie already exists", () => {
      const PASSWORD = "123supersecure"
      const cookieToStore = {
        name: CookieEnum.Key,
        value: hash(PASSWORD),
        domain: "localhost",
        secure: false,
        sameSite: "Lax" as const,
        httpOnly: false,
        expires: 18000,
        path: "/",
      }
      const cookies: Cookie[] = [cookieToStore]
      expect(createCookieIfDoesntExist(cookies, cookieToStore)).toStrictEqual(cookies)
    })
  })
})
