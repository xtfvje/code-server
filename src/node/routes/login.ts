import { Router, Request } from "express"
import { promises as fs } from "fs"
import { RateLimiter as Limiter } from "limiter"
import * as os from "os"
import * as path from "path"
import { CookieKeys } from "../../common/http"
import { rootPath } from "../constants"
import { authenticated, getCookieOptions, redirect, replaceTemplates } from "../http"
import { getPasswordMethod, handlePasswordValidation, humanPath, sanitizeString, escapeHtml } from "../util"

// RateLimiter wraps around the limiter library for logins.
// It allows 2 logins every minute plus 12 logins every hour.
export class RateLimiter {
  private readonly minuteLimiter = new Limiter(2, "minute")
  private readonly hourLimiter = new Limiter(12, "hour")

  public canTry(): boolean {
    // Note: we must check using >= 1 because technically when there are no tokens left
    // you get back a number like 0.00013333333333333334
    // which would cause fail if the logic were > 0
    return this.minuteLimiter.getTokensRemaining() >= 1 || this.hourLimiter.getTokensRemaining() >= 1
  }

  public removeToken(): boolean {
    return this.minuteLimiter.tryRemoveTokens(1) || this.hourLimiter.tryRemoveTokens(1)
  }
}

const getRoot = async (req: Request, error?: Error): Promise<string> => {
  const content = await fs.readFile(path.join(rootPath, "src/browser/pages/login.html"), "utf8")
  let passwordMsg = `Check the config file at ${humanPath(os.homedir(), req.args.config)} for the password.`
  if (req.args.usingEnvPassword) {
    passwordMsg = "Password was set from $PASSWORD."
  } else if (req.args.usingEnvHashedPassword) {
    passwordMsg = "Password was set from $HASHED_PASSWORD."
  }

  return replaceTemplates(
    req,
    content
      .replace(/{{PASSWORD_MSG}}/g, passwordMsg)
      .replace(/{{ERROR}}/, error ? `<div class="error">${escapeHtml(error.message)}</div>` : ""),
  )
}

const limiter = new RateLimiter()

export const router = Router()

router.use(async (req, res, next) => {
  const to = (typeof req.query.to === "string" && req.query.to) || "/"
  if (await authenticated(req)) {
    return redirect(req, res, to, { to: undefined })
  }
  next()
})

router.get("/", async (req, res) => {
  res.send(await getRoot(req))
})

router.post<{}, string, { password: string; base?: string }, { to?: string }>("/", async (req, res) => {
  const password = sanitizeString(req.body.password)
  const hashedPasswordFromArgs = req.args["hashed-password"]

  try {
    // Check to see if they exceeded their login attempts
    if (!limiter.canTry()) {
      throw new Error("Login rate limited!")
    }

    if (!password) {
      throw new Error("Missing password")
    }

    const passwordMethod = getPasswordMethod(hashedPasswordFromArgs)
    const { isPasswordValid, hashedPassword } = await handlePasswordValidation({
      passwordMethod,
      hashedPasswordFromArgs,
      passwordFromRequestBody: password,
      passwordFromArgs: req.args.password,
    })

    if (isPasswordValid) {
      // The hash does not add any actual security but we do it for
      // obfuscation purposes (and as a side effect it handles escaping).
      res.cookie(CookieKeys.Session, hashedPassword, getCookieOptions(req))

      const to = (typeof req.query.to === "string" && req.query.to) || "/"
      return redirect(req, res, to, { to: undefined })
    }

    // Note: successful logins should not count against the RateLimiter
    // which is why this logic must come after the successful login logic
    limiter.removeToken()

    console.error(
      "Failed login attempt",
      JSON.stringify({
        xForwardedFor: req.headers["x-forwarded-for"],
        remoteAddress: req.connection.remoteAddress,
        userAgent: req.headers["user-agent"],
        timestamp: Math.floor(new Date().getTime() / 1000),
      }),
    )

    throw new Error("Incorrect password")
  } catch (error: any) {
    const renderedHtml = await getRoot(req, error)
    res.send(renderedHtml)
  }
})
