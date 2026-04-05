import { existsSync } from "node:fs";
import {
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  chromium,
} from "playwright";

export type ChromiumLaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;

export type SafewayStorefront = "safeway" | "albertsons";

export interface SafewayAccountIdentity {
  accountId: string;
  storefront?: SafewayStorefront;
  sessionStatePath?: string;
}

export interface SafewayAccountCredentials {
  email?: string;
  password?: string;
  phoneNumber?: string;
  sessionStatePath?: string;
}

export interface SafewayResolvedAccount extends SafewayAccountIdentity, SafewayAccountCredentials {}

export interface SafewayAccountSession {
  accountId: string;
  storefront: SafewayStorefront;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  isLoggedIn: boolean;
  authenticatedEmail?: string;
  authenticatedLoginKey?: string;
  sessionStatePath?: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

interface ManagedSession extends SafewayAccountSession {
  mutex: SessionMutex;
}

const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  "safeway.com",
  "albertsons.com",
  "albertsons-media.com",
  "albertsonscompanies.com",
  "cookielaw.org",
  "onetrust.com",
  "google.com",
  "gstatic.com",
  "recaptcha.net",
];
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

class SessionMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
    }
  }
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAllowedHostSuffixes(): string[] {
  const extraHosts = process.env.SAFEWAY_BROWSER_EXTRA_ALLOWED_HOSTS
    ?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set([...DEFAULT_ALLOWED_HOST_SUFFIXES, ...(extraHosts ?? [])])];
}

function isAllowedHostname(hostname: string, allowedSuffixes: string[]): boolean {
  return allowedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isAllowedRequest(request: Request, allowedSuffixes: string[]): boolean {
  try {
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return true;
    }

    if (!isAllowedHostname(url.hostname.toLowerCase(), allowedSuffixes)) {
      return false;
    }

    return !BLOCKED_RESOURCE_TYPES.has(request.resourceType());
  } catch {
    return false;
  }
}

function getBrowserLaunchGuidance(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (
    message.includes("MachPortRendezvousServer") ||
    message.includes("sandbox_parameters_mac.mm") ||
    message.includes("_RegisterApplication") ||
    message.includes("TransformProcessType")
  ) {
    return "Chromium could not start in this macOS sandboxed environment. Run live browser tests in a normal local terminal session instead of the Codex sandbox.";
  }

  return null;
}

export function buildChromiumLaunchOptions(): ChromiumLaunchOptions {
  const disableSandbox = parseBooleanEnv(process.env.SAFEWAY_BROWSER_DISABLE_SANDBOX);
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-size=1280,800",
  ];

  if (disableSandbox) {
    launchArgs.unshift("--no-sandbox", "--disable-setuid-sandbox");
  }

  const launchOptions: ChromiumLaunchOptions = {
    headless: true,
    channel: "chromium",
    chromiumSandbox: !disableSandbox,
    args: launchArgs,
  };

  if (!disableSandbox) {
    launchOptions.ignoreDefaultArgs = ["--no-sandbox"];
  }

  return launchOptions;
}

export class SafewaySessionManager {
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingSessions = new Map<string, Promise<ManagedSession>>();
  private browserPromise: Promise<Browser> | null = null;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.ttlMs = parseNumberEnv(process.env.SAFEWAY_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS);
    this.cleanupIntervalMs = parseNumberEnv(
      process.env.SAFEWAY_SESSION_CLEANUP_INTERVAL_MS,
      DEFAULT_CLEANUP_INTERVAL_MS
    );
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async runWithSession<T>(
    account: SafewayAccountIdentity,
    task: (session: SafewayAccountSession) => Promise<T>
  ): Promise<T> {
    const session = await this.getOrCreateSession(account);
    return session.mutex.runExclusive(async () => {
      this.touchSession(session.accountId);

      if (session.page.isClosed()) {
        await this.closeSession(session.accountId);
        return this.runWithSession(account, task);
      }

      return task(session);
    });
  }

  touchSession(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (!session) {
      return;
    }

    const now = Date.now();
    session.lastUsedAt = now;
    session.expiresAt = now + this.ttlMs;
  }

  async closeSession(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    this.sessions.delete(accountId);
    this.pendingSessions.delete(accountId);

    if (!session) {
      return;
    }

    try {
      await session.context.close();
    } catch {
      // Ignore context teardown failures during cleanup.
    }
  }

  async closeAllSessions(): Promise<void> {
    const accountIds = [...this.sessions.keys()];
    await Promise.all(accountIds.map((accountId) => this.closeSession(accountId)));

    const browser = await this.browserPromise?.catch(() => null);
    this.browserPromise = null;
    await browser?.close().catch(() => undefined);
  }

  async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredAccountIds = [...this.sessions.values()]
      .filter((session) => session.expiresAt <= now || session.page.isClosed())
      .map((session) => session.accountId);

    await Promise.all(expiredAccountIds.map((accountId) => this.closeSession(accountId)));
  }

  private async getOrCreateSession(account: SafewayAccountIdentity): Promise<ManagedSession> {
    const existing = this.sessions.get(account.accountId);
    if (existing) {
      if (existing.expiresAt <= Date.now() || existing.page.isClosed()) {
        await this.closeSession(account.accountId);
      } else {
        return existing;
      }
    }

    const pending = this.pendingSessions.get(account.accountId);
    if (pending) {
      return pending;
    }

    const creation = this.createSession(account)
      .then((session) => {
        this.sessions.set(account.accountId, session);
        return session;
      })
      .finally(() => {
        this.pendingSessions.delete(account.accountId);
      });

    this.pendingSessions.set(account.accountId, creation);
    return creation;
  }

  private async createSession(account: SafewayAccountIdentity): Promise<ManagedSession> {
    const browser = await this.getBrowser();
    const now = Date.now();
    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
    };

    if (account.sessionStatePath && existsSync(account.sessionStatePath)) {
      contextOptions.storageState = account.sessionStatePath;
    }

    const context = await browser.newContext(contextOptions);

    await this.applyNetworkPolicy(context);
    context.setDefaultNavigationTimeout(30_000);
    context.setDefaultTimeout(15_000);

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);

    return {
      accountId: account.accountId,
      storefront: account.storefront ?? "safeway",
      browser,
      context,
      page,
      isLoggedIn: false,
      sessionStatePath: account.sessionStatePath,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + this.ttlMs,
      mutex: new SessionMutex(),
    };
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch(buildChromiumLaunchOptions()).catch((error) => {
        const guidance = getBrowserLaunchGuidance(error);
        if (guidance) {
          throw new Error(`${guidance}\nOriginal error: ${error instanceof Error ? error.message : String(error)}`);
        }

        throw error;
      });

      this.browserPromise.then((browser) => {
        browser.on("disconnected", () => {
          this.browserPromise = null;
          this.sessions.clear();
          this.pendingSessions.clear();
        });
      }).catch(() => {
        this.browserPromise = null;
      });
    }

    return this.browserPromise;
  }

  private async applyNetworkPolicy(context: BrowserContext): Promise<void> {
    const allowedSuffixes = getAllowedHostSuffixes();

    await context.route("**/*", async (route) => {
      if (!isAllowedRequest(route.request(), allowedSuffixes)) {
        await route.abort("blockedbyclient");
        return;
      }

      await route.continue();
    });
  }
}

export const sessionManager = new SafewaySessionManager();
