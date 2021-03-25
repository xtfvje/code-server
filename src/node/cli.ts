import { field, Level, logger } from "@coder/logger"
import { promises as fs } from "fs"
import yaml from "js-yaml"
import * as os from "os"
import * as path from "path"
import { Args as VsArgs } from "../../lib/vscode/src/vs/server/ipc"
import { canConnect, generateCertificate, generatePassword, humanPath, paths } from "./util"

export enum AuthType {
  Password = "password",
  None = "none",
}

export class Optional<T> {
  public constructor(public readonly value?: T) {}
}

export enum LogLevel {
  Trace = "trace",
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export class OptionalString extends Optional<string> {}

export interface Args extends VsArgs {
  config?: string
  auth?: AuthType
  password?: string
  "hashed-password"?: string
  cert?: OptionalString
  "cert-host"?: string
  "cert-key"?: string
  "disable-telemetry"?: boolean
  "disable-update-check"?: boolean
  help?: boolean
  host?: string
  json?: boolean
  log?: LogLevel
  open?: boolean
  port?: number
  "bind-addr"?: string
  socket?: string
  version?: boolean
  force?: boolean
  "list-extensions"?: boolean
  "install-extension"?: string[]
  "show-versions"?: boolean
  "uninstall-extension"?: string[]
  "proxy-domain"?: string[]
  locale?: string
  _: string[]
  "reuse-window"?: boolean
  "new-window"?: boolean

  link?: OptionalString
}

interface Option<T> {
  type: T
  /**
   * Short flag for the option.
   */
  short?: string
  /**
   * Whether the option is a path and should be resolved.
   */
  path?: boolean
  /**
   * Description of the option. Leave blank to hide the option.
   */
  description?: string

  /**
   * If marked as beta, the option is marked as beta in help.
   */
  beta?: boolean
}

type OptionType<T> = T extends boolean
  ? "boolean"
  : T extends OptionalString
  ? typeof OptionalString
  : T extends LogLevel
  ? typeof LogLevel
  : T extends AuthType
  ? typeof AuthType
  : T extends number
  ? "number"
  : T extends string
  ? "string"
  : T extends string[]
  ? "string[]"
  : "unknown"

type Options<T> = {
  [P in keyof T]: Option<OptionType<T[P]>>
}

const options: Options<Required<Args>> = {
  auth: { type: AuthType, description: "The type of authentication to use." },
  password: {
    type: "string",
    description: "The password for password authentication (can only be passed in via $PASSWORD or the config file).",
  },
  "hashed-password": {
    type: "string",
    description:
      "The password hashed with SHA-256 for password authentication (can only be passed in via $HASHED_PASSWORD or the config file). \n" +
      "Takes precedence over 'password'.",
  },
  cert: {
    type: OptionalString,
    path: true,
    description: "Path to certificate. A self signed certificate is generated if none is provided.",
  },
  "cert-host": {
    type: "string",
    description: "Hostname to use when generating a self signed certificate.",
  },
  "cert-key": { type: "string", path: true, description: "Path to certificate key when using non-generated cert." },
  "disable-telemetry": { type: "boolean", description: "Disable telemetry." },
  "disable-update-check": {
    type: "boolean",
    description:
      "Disable update check. Without this flag, code-server checks every 6 hours against the latest github release and \n" +
      "then notifies you once every week that a new release is available.",
  },
  help: { type: "boolean", short: "h", description: "Show this output." },
  json: { type: "boolean" },
  open: { type: "boolean", description: "Open in browser on startup. Does not work remotely." },

  "bind-addr": {
    type: "string",
    description: "Address to bind to in host:port. You can also use $PORT to override the port.",
  },

  config: {
    type: "string",
    description: "Path to yaml config file. Every flag maps directly to a key in the config file.",
  },

  // These two have been deprecated by bindAddr.
  host: { type: "string", description: "" },
  port: { type: "number", description: "" },

  socket: { type: "string", path: true, description: "Path to a socket (bind-addr will be ignored)." },
  version: { type: "boolean", short: "v", description: "Display version information." },
  _: { type: "string[]" },

  "user-data-dir": { type: "string", path: true, description: "Path to the user data directory." },
  "extensions-dir": { type: "string", path: true, description: "Path to the extensions directory." },
  "builtin-extensions-dir": { type: "string", path: true },
  "extra-extensions-dir": { type: "string[]", path: true },
  "extra-builtin-extensions-dir": { type: "string[]", path: true },
  "list-extensions": { type: "boolean", description: "List installed VS Code extensions." },
  force: { type: "boolean", description: "Avoid prompts when installing VS Code extensions." },
  "install-extension": {
    type: "string[]",
    description:
      "Install or update a VS Code extension by id or vsix. The identifier of an extension is `${publisher}.${name}`.\n" +
      "To install a specific version provide `@${version}`. For example: 'vscode.csharp@1.2.3'.",
  },
  "enable-proposed-api": {
    type: "string[]",
    description:
      "Enable proposed API features for extensions. Can receive one or more extension IDs to enable individually.",
  },
  "uninstall-extension": { type: "string[]", description: "Uninstall a VS Code extension by id." },
  "show-versions": { type: "boolean", description: "Show VS Code extension versions." },
  "proxy-domain": { type: "string[]", description: "Domain used for proxying ports." },
  "ignore-last-opened": {
    type: "boolean",
    short: "e",
    description: "Ignore the last opened directory or workspace in favor of an empty window.",
  },
  "new-window": {
    type: "boolean",
    short: "n",
    description: "Force to open a new window.",
  },
  "reuse-window": {
    type: "boolean",
    short: "r",
    description: "Force to open a file or folder in an already opened window.",
  },

  locale: { type: "string" },
  log: { type: LogLevel },
  verbose: { type: "boolean", short: "vvv", description: "Enable verbose logging." },

  link: {
    type: OptionalString,
    description: `
      Securely bind code-server via our cloud service with the passed name. You'll get a URL like
      https://hostname-username.cdr.co at which you can easily access your code-server instance.
      Authorization is done via GitHub.
    `,
    beta: true,
  },
}

export const optionDescriptions = (): string[] => {
  const entries = Object.entries(options).filter(([, v]) => !!v.description)
  const widths = entries.reduce(
    (prev, [k, v]) => ({
      long: k.length > prev.long ? k.length : prev.long,
      short: v.short && v.short.length > prev.short ? v.short.length : prev.short,
    }),
    { short: 0, long: 0 },
  )
  return entries.map(([k, v]) => {
    const help = `${" ".repeat(widths.short - (v.short ? v.short.length : 0))}${v.short ? `-${v.short}` : " "} --${k} `
    return (
      help +
      v.description
        ?.trim()
        .split(/\n/)
        .map((line, i) => {
          line = line.trim()
          if (i === 0) {
            return " ".repeat(widths.long - k.length) + (v.beta ? "(beta) " : "") + line
          }
          return " ".repeat(widths.long + widths.short + 6) + line
        })
        .join("\n") +
      (typeof v.type === "object" ? ` [${Object.values(v.type).join(", ")}]` : "")
    )
  })
}

export const parse = (
  argv: string[],
  opts?: {
    configFile?: string
  },
): Args => {
  const error = (msg: string): Error => {
    if (opts?.configFile) {
      msg = `error reading ${opts.configFile}: ${msg}`
    }
    return new Error(msg)
  }

  const args: Args = { _: [] }
  let ended = false

  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i]

    // -- signals the end of option parsing.
    if (!ended && arg === "--") {
      ended = true
      continue
    }

    // Options start with a dash and require a value if non-boolean.
    if (!ended && arg.startsWith("-")) {
      let key: keyof Args | undefined
      let value: string | undefined
      if (arg.startsWith("--")) {
        const split = arg.replace(/^--/, "").split("=", 2)
        key = split[0] as keyof Args
        value = split[1]
      } else {
        const short = arg.replace(/^-/, "")
        const pair = Object.entries(options).find(([, v]) => v.short === short)
        if (pair) {
          key = pair[0] as keyof Args
        }
      }

      if (!key || !options[key]) {
        throw error(`Unknown option ${arg}`)
      }

      if (key === "password" && !opts?.configFile) {
        throw new Error("--password can only be set in the config file or passed in via $PASSWORD")
      }

      if (key === "hashed-password" && !opts?.configFile) {
        throw new Error("--hashed-password can only be set in the config file or passed in via $HASHED_PASSWORD")
      }

      const option = options[key]
      if (option.type === "boolean") {
        ;(args[key] as boolean) = true
        continue
      }

      // Might already have a value if it was the --long=value format.
      if (typeof value === "undefined") {
        // A value is only valid if it doesn't look like an option.
        value = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : undefined
      }

      if (!value && option.type === OptionalString) {
        ;(args[key] as OptionalString) = new OptionalString(value)
        continue
      } else if (!value) {
        throw error(`--${key} requires a value`)
      }

      if (option.type === OptionalString && value === "false") {
        continue
      }

      if (option.path) {
        value = path.resolve(value)
      }

      switch (option.type) {
        case "string":
          ;(args[key] as string) = value
          break
        case "string[]":
          if (!args[key]) {
            ;(args[key] as string[]) = []
          }
          ;(args[key] as string[]).push(value)
          break
        case "number":
          ;(args[key] as number) = parseInt(value, 10)
          if (isNaN(args[key] as number)) {
            throw error(`--${key} must be a number`)
          }
          break
        case OptionalString:
          ;(args[key] as OptionalString) = new OptionalString(value)
          break
        default: {
          if (!Object.values(option.type).includes(value)) {
            throw error(`--${key} valid values: [${Object.values(option.type).join(", ")}]`)
          }
          ;(args[key] as string) = value
          break
        }
      }

      continue
    }

    // Everything else goes into _.
    args._.push(arg)
  }

  // If a cert was provided a key must also be provided.
  if (args.cert && args.cert.value && !args["cert-key"]) {
    throw new Error("--cert-key is missing")
  }

  logger.debug(() => ["parsed command line", field("args", { ...args, password: undefined })])

  return args
}

export interface DefaultedArgs extends ConfigArgs {
  auth: AuthType
  cert?: {
    value: string
  }
  host: string
  port: number
  "proxy-domain": string[]
  verbose: boolean
  usingEnvPassword: boolean
  usingEnvHashedPassword: boolean
  "extensions-dir": string
  "user-data-dir": string
}

/**
 * Take CLI and config arguments (optional) and return a single set of arguments
 * with the defaults set. Arguments from the CLI are prioritized over config
 * arguments.
 */
export async function setDefaults(cliArgs: Args, configArgs?: ConfigArgs): Promise<DefaultedArgs> {
  const args = Object.assign({}, configArgs || {}, cliArgs)

  if (!args["user-data-dir"]) {
    args["user-data-dir"] = paths.data
  }

  if (!args["extensions-dir"]) {
    args["extensions-dir"] = path.join(args["user-data-dir"], "extensions")
  }

  // --verbose takes priority over --log and --log takes priority over the
  // environment variable.
  if (args.verbose) {
    args.log = LogLevel.Trace
  } else if (
    !args.log &&
    process.env.LOG_LEVEL &&
    Object.values(LogLevel).includes(process.env.LOG_LEVEL as LogLevel)
  ) {
    args.log = process.env.LOG_LEVEL as LogLevel
  }

  // Sync --log, --verbose, the environment variable, and logger level.
  if (args.log) {
    process.env.LOG_LEVEL = args.log
  }
  switch (args.log) {
    case LogLevel.Trace:
      logger.level = Level.Trace
      args.verbose = true
      break
    case LogLevel.Debug:
      logger.level = Level.Debug
      args.verbose = false
      break
    case LogLevel.Info:
      logger.level = Level.Info
      args.verbose = false
      break
    case LogLevel.Warn:
      logger.level = Level.Warning
      args.verbose = false
      break
    case LogLevel.Error:
      logger.level = Level.Error
      args.verbose = false
      break
  }

  // Default to using a password.
  if (!args.auth) {
    args.auth = AuthType.Password
  }

  const addr = bindAddrFromAllSources(configArgs || { _: [] }, cliArgs)
  args.host = addr.host
  args.port = addr.port

  // If we're being exposed to the cloud, we listen on a random address and
  // disable auth.
  if (args.link) {
    args.host = "localhost"
    args.port = 0
    args.socket = undefined
    args.cert = undefined
    args.auth = AuthType.None
  }

  if (args.cert && !args.cert.value) {
    const { cert, certKey } = await generateCertificate(args["cert-host"] || "localhost")
    args.cert = {
      value: cert,
    }
    args["cert-key"] = certKey
  }

  let usingEnvPassword = !!process.env.PASSWORD
  if (process.env.PASSWORD) {
    args.password = process.env.PASSWORD
  }

  const usingEnvHashedPassword = !!process.env.HASHED_PASSWORD
  if (process.env.HASHED_PASSWORD) {
    args["hashed-password"] = process.env.HASHED_PASSWORD
    usingEnvPassword = false
  }

  // Ensure they're not readable by child processes.
  delete process.env.PASSWORD
  delete process.env.HASHED_PASSWORD

  // Filter duplicate proxy domains and remove any leading `*.`.
  const proxyDomains = new Set((args["proxy-domain"] || []).map((d) => d.replace(/^\*\./, "")))
  args["proxy-domain"] = Array.from(proxyDomains)

  return {
    ...args,
    usingEnvPassword,
    usingEnvHashedPassword,
  } as DefaultedArgs // TODO: Technically no guarantee this is fulfilled.
}

async function defaultConfigFile(): Promise<string> {
  return `bind-addr: 127.0.0.1:8080
auth: password
password: ${await generatePassword()}
cert: false
`
}

interface ConfigArgs extends Args {
  config: string
}

/**
 * Reads the code-server yaml config file and returns it as Args.
 *
 * @param configPath Read the config from configPath instead of $CODE_SERVER_CONFIG or the default.
 */
export async function readConfigFile(configPath?: string): Promise<ConfigArgs> {
  if (!configPath) {
    configPath = process.env.CODE_SERVER_CONFIG
    if (!configPath) {
      configPath = path.join(paths.config, "config.yaml")
    }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })

  try {
    await fs.writeFile(configPath, await defaultConfigFile(), {
      flag: "wx", // wx means to fail if the path exists.
    })
    logger.info(`Wrote default config file to ${humanPath(configPath)}`)
  } catch (error) {
    // EEXIST is fine; we don't want to overwrite existing configurations.
    if (error.code !== "EEXIST") {
      throw error
    }
  }

  const configFile = await fs.readFile(configPath, "utf8")
  return parseConfigFile(configFile, configPath)
}

/**
 * parseConfigFile parses configFile into ConfigArgs.
 * configPath is used as the filename in error messages
 */
export function parseConfigFile(configFile: string, configPath: string): ConfigArgs {
  if (!configFile) {
    return { _: [], config: configPath }
  }

  const config = yaml.load(configFile, {
    filename: configPath,
  })
  if (!config || typeof config === "string") {
    throw new Error(`invalid config: ${config}`)
  }

  // We convert the config file into a set of flags.
  // This is a temporary measure until we add a proper CLI library.
  const configFileArgv = Object.entries(config).map(([optName, opt]) => {
    if (opt === true) {
      return `--${optName}`
    }
    return `--${optName}=${opt}`
  })
  const args = parse(configFileArgv, {
    configFile: configPath,
  })
  return {
    ...args,
    config: configPath,
  }
}

function parseBindAddr(bindAddr: string): Addr {
  const u = new URL(`http://${bindAddr}`)
  return {
    host: u.hostname,
    // With the http scheme 80 will be dropped so assume it's 80 if missing.
    // This means --bind-addr <addr> without a port will default to 80 as well
    // and not the code-server default.
    port: u.port ? parseInt(u.port, 10) : 80,
  }
}

interface Addr {
  host: string
  port: number
}

function bindAddrFromArgs(addr: Addr, args: Args): Addr {
  addr = { ...addr }
  if (args["bind-addr"]) {
    addr = parseBindAddr(args["bind-addr"])
  }
  if (args.host) {
    addr.host = args.host
  }

  if (process.env.PORT) {
    addr.port = parseInt(process.env.PORT, 10)
  }
  if (args.port !== undefined) {
    addr.port = args.port
  }
  return addr
}

function bindAddrFromAllSources(...argsConfig: Args[]): Addr {
  let addr: Addr = {
    host: "localhost",
    port: 8080,
  }

  for (const args of argsConfig) {
    addr = bindAddrFromArgs(addr, args)
  }

  return addr
}

export const shouldRunVsCodeCli = (args: Args): boolean => {
  return !!args["list-extensions"] || !!args["install-extension"] || !!args["uninstall-extension"]
}

/**
 * Determine if it looks like the user is trying to open a file or folder in an
 * existing instance. The arguments here should be the arguments the user
 * explicitly passed on the command line, not defaults or the configuration.
 */
export const shouldOpenInExistingInstance = async (args: Args): Promise<string | undefined> => {
  // Always use the existing instance if we're running from VS Code's terminal.
  if (process.env.VSCODE_IPC_HOOK_CLI) {
    return process.env.VSCODE_IPC_HOOK_CLI
  }

  const readSocketPath = async (): Promise<string | undefined> => {
    try {
      return await fs.readFile(path.join(os.tmpdir(), "vscode-ipc"), "utf8")
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error
      }
    }
    return undefined
  }

  // If these flags are set then assume the user is trying to open in an
  // existing instance since these flags have no effect otherwise.
  const openInFlagCount = ["reuse-window", "new-window"].reduce((prev, cur) => {
    return args[cur as keyof Args] ? prev + 1 : prev
  }, 0)
  if (openInFlagCount > 0) {
    return readSocketPath()
  }

  // It's possible the user is trying to spawn another instance of code-server.
  // Check if any unrelated flags are set (check against one because `_` always
  // exists), that a file or directory was passed, and that the socket is
  // active.
  if (Object.keys(args).length === 1 && args._.length > 0) {
    const socketPath = await readSocketPath()
    if (socketPath && (await canConnect(socketPath))) {
      return socketPath
    }
  }

  return undefined
}
