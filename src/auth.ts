import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  resolveSafewayCredentials,
  type AccountConfig,
  type AllowedAction,
  type ResolvedSafewayCredentials,
  type ServerConfig,
} from "./config.js";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthenticatedAccount {
  accountId: string;
  allowedActions: ReadonlySet<AllowedAction>;
  allowedActionsArray: AllowedAction[];
  safewayCredentials: ResolvedSafewayCredentials;
  authInfo: AuthInfo;
}

function getAuthorizationHeader(req: IncomingMessage) {
  const header = req.headers.authorization;
  return typeof header === "string" ? header : undefined;
}

function extractBearerToken(req: IncomingMessage) {
  const header = getAuthorizationHeader(req);

  if (!header) {
    throw new AuthError("Missing Authorization header", 401, {
      "www-authenticate": "Bearer",
    });
  }

  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match || match[1].trim() === "") {
    throw new AuthError("Authorization header must use Bearer auth", 401, {
      "www-authenticate": "Bearer",
    });
  }

  return match[1].trim();
}

function hashApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey, "utf8").digest();
}

function matchesApiKeyHash(storedHashHex: string, presentedHash: Buffer) {
  const storedHash = Buffer.from(storedHashHex, "hex");

  if (storedHash.length !== presentedHash.length) {
    return false;
  }

  return timingSafeEqual(storedHash, presentedHash);
}

function findAccountByApiKey(apiKey: string, config: ServerConfig) {
  const presentedHash = hashApiKey(apiKey);
  let matchedAccount: AccountConfig | undefined;

  for (const account of config.accounts) {
    const matches = matchesApiKeyHash(account.apiKeyHash, presentedHash);

    if (matches && !matchedAccount) {
      matchedAccount = account;
    }
  }

  return matchedAccount;
}

export function authenticateRequest(
  req: IncomingMessage,
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env
): AuthenticatedAccount {
  const token = extractBearerToken(req);
  const account = findAccountByApiKey(token, config);

  if (!account) {
    throw new AuthError("Invalid API key", 401, {
      "www-authenticate": "Bearer",
    });
  }

  const safewayCredentials = resolveSafewayCredentials(account, env);

  return {
    accountId: account.accountId,
    allowedActions: new Set(account.allowedActions),
    allowedActionsArray: [...account.allowedActions],
    safewayCredentials,
    authInfo: {
      token,
      clientId: account.accountId,
      scopes: [...account.allowedActions],
      extra: {
        accountId: account.accountId,
      },
    },
  };
}

export function assertActionAllowed(
  account: AuthenticatedAccount,
  action: AllowedAction
) {
  if (!account.allowedActions.has(action)) {
    throw new AuthError(
      `Account ${account.accountId} is not allowed to call ${action}`,
      403
    );
  }
}
