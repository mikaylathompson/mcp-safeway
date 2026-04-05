import { readFileSync } from "node:fs";
import { z } from "zod";

export const ALL_ACTIONS = [
  "safeway_search_products",
  "safeway_get_product_details",
  "safeway_add_to_cart",
  "safeway_get_cart",
  "safeway_update_cart_item",
  "safeway_remove_from_cart",
  "safeway_get_delivery_slots",
  "safeway_select_delivery_slot",
  "safeway_checkout",
  "safeway_get_orders",
  "safeway_get_order_details",
  "safeway_clip_coupon",
  "safeway_get_weekly_deals",
] as const;

const AllowedActionSchema = z.enum(ALL_ACTIONS);

const SafewayCredentialsSchema = z.object({
  emailEnvVar: z.string().min(1).optional(),
  passwordEnvVar: z.string().min(1).optional(),
  phoneNumberEnvVar: z.string().min(1).optional(),
  sessionStatePathEnvVar: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  const hasEmail = !!value.emailEnvVar;
  const hasPassword = !!value.passwordEnvVar;

  if (hasEmail !== hasPassword) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "emailEnvVar and passwordEnvVar must be provided together",
    });
  }

  if (!hasEmail && !value.phoneNumberEnvVar) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either email/password env vars or phoneNumberEnvVar",
    });
  }
});

const AccountConfigSchema = z.object({
  accountId: z.string().min(1),
  apiKeyHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "apiKeyHash must be a sha256 hex digest"),
  safewayCredentials: SafewayCredentialsSchema,
  allowedActions: z.array(AllowedActionSchema).nonempty(),
});

const ConfigSchema = z.object({
  host: z.string().min(1).default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(3000),
  mcpPath: z
    .string()
    .min(1)
    .transform((value) => (value.startsWith("/") ? value : `/${value}`))
    .default("/mcp"),
  accounts: z.array(AccountConfigSchema).nonempty(),
});

export type AllowedAction = z.infer<typeof AllowedActionSchema>;
export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type ServerConfig = z.infer<typeof ConfigSchema>;

export interface ResolvedSafewayCredentials {
  email?: string;
  password?: string;
  phoneNumber?: string;
  sessionStatePath?: string;
  emailEnvVar?: string;
  passwordEnvVar?: string;
  phoneNumberEnvVar?: string;
  sessionStatePathEnvVar?: string;
}

function readRawConfig(env: NodeJS.ProcessEnv) {
  if (env.SAFEWAY_MCP_CONFIG_PATH) {
    return readFileSync(env.SAFEWAY_MCP_CONFIG_PATH, "utf8");
  }

  if (env.SAFEWAY_MCP_CONFIG) {
    return env.SAFEWAY_MCP_CONFIG;
  }

  throw new Error(
    "Missing configuration. Set SAFEWAY_MCP_CONFIG_PATH or SAFEWAY_MCP_CONFIG."
  );
}

function validateUniqueAccounts(accounts: AccountConfig[]) {
  const seenAccountIds = new Set<string>();
  const seenApiKeyHashes = new Set<string>();

  for (const account of accounts) {
    if (seenAccountIds.has(account.accountId)) {
      throw new Error(`Duplicate accountId in config: ${account.accountId}`);
    }

    if (seenApiKeyHashes.has(account.apiKeyHash)) {
      throw new Error(`Duplicate apiKeyHash in config for account ${account.accountId}`);
    }

    seenAccountIds.add(account.accountId);
    seenApiKeyHashes.add(account.apiKeyHash);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(readRawConfig(env));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid config JSON";
    throw new Error(`Failed to parse configuration: ${message}`);
  }

  const config = ConfigSchema.parse(parsedJson);
  validateUniqueAccounts(config.accounts);
  return config;
}

export function resolveSafewayCredentials(
  account: AccountConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedSafewayCredentials {
  const { emailEnvVar, passwordEnvVar, phoneNumberEnvVar, sessionStatePathEnvVar } = account.safewayCredentials;
  const email = emailEnvVar ? env[emailEnvVar] : undefined;
  const password = passwordEnvVar ? env[passwordEnvVar] : undefined;
  const phoneNumber = phoneNumberEnvVar ? env[phoneNumberEnvVar] : undefined;
  const sessionStatePath = sessionStatePathEnvVar ? env[sessionStatePathEnvVar] : undefined;

  if (emailEnvVar && !email) {
    throw new Error(
      `Missing Safeway email env var ${emailEnvVar} for account ${account.accountId}`
    );
  }

  if (passwordEnvVar && !password) {
    throw new Error(
      `Missing Safeway password env var ${passwordEnvVar} for account ${account.accountId}`
    );
  }

  if (phoneNumberEnvVar && !phoneNumber) {
    throw new Error(
      `Missing Safeway phone number env var ${phoneNumberEnvVar} for account ${account.accountId}`
    );
  }

  if (sessionStatePathEnvVar && !sessionStatePath) {
    throw new Error(
      `Missing Safeway session state env var ${sessionStatePathEnvVar} for account ${account.accountId}`
    );
  }

  return {
    email,
    password,
    phoneNumber,
    sessionStatePath,
    emailEnvVar,
    passwordEnvVar,
    phoneNumberEnvVar,
    sessionStatePathEnvVar,
  };
}
