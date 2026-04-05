#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  addToCart,
  checkout,
  clipCoupon,
  closeSession,
  getCart,
  getDeliverySlots,
  getOrderDetails,
  getOrders,
  getProductDetails,
  getWeeklyDeals,
  loginWithAccount,
  removeFromCart,
  searchProducts,
  selectDeliverySlot,
  updateCartItem,
} from "./browser.js";
import {
  ALL_ACTIONS,
  loadConfig,
  type AllowedAction,
} from "./config.js";
import {
  AuthError,
  assertActionAllowed,
  authenticateRequest,
  type AuthenticatedAccount,
} from "./auth.js";

const TOOLS: Record<AllowedAction, Tool> = {
  safeway_search_products: {
    name: "safeway_search_products",
    description:
      "Search for products on Safeway/Albertsons. Returns a list of matching products with prices and availability.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'organic milk', 'chicken breast', 'apples')",
        },
        category: {
          type: "string",
          description: "Optional product category to filter by (e.g., 'produce', 'dairy', 'meat')",
        },
        filters: {
          type: "object",
          description: "Optional additional filters as key-value pairs",
          additionalProperties: { type: "string" },
        },
      },
      required: ["query"],
    },
  },
  safeway_get_product_details: {
    name: "safeway_get_product_details",
    description:
      "Get detailed information about a specific product including full description, nutritional info, and current pricing.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: {
          type: "string",
          description: "The product ID obtained from safeway_search_products",
        },
      },
      required: ["product_id"],
    },
  },
  safeway_add_to_cart: {
    name: "safeway_add_to_cart",
    description: "Add a product to the shopping cart.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: {
          type: "string",
          description: "The product ID to add to cart",
        },
        quantity: {
          type: "number",
          description: "Number of items to add (default: 1)",
          minimum: 1,
        },
      },
      required: ["product_id", "quantity"],
    },
  },
  safeway_get_cart: {
    name: "safeway_get_cart",
    description:
      "Retrieve the current contents of the shopping cart including all items, quantities, prices, and cart totals.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  safeway_update_cart_item: {
    name: "safeway_update_cart_item",
    description: "Update the quantity of an item already in the cart.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: {
          type: "string",
          description: "The cart item ID to update",
        },
        quantity: {
          type: "number",
          description: "New quantity for the item",
          minimum: 1,
        },
      },
      required: ["item_id", "quantity"],
    },
  },
  safeway_remove_from_cart: {
    name: "safeway_remove_from_cart",
    description: "Remove an item from the shopping cart.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: {
          type: "string",
          description: "The cart item ID to remove",
        },
      },
      required: ["item_id"],
    },
  },
  safeway_get_delivery_slots: {
    name: "safeway_get_delivery_slots",
    description:
      "Get available delivery time slots for grocery delivery. Returns available slots with times and delivery fees.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Optional date to check slots for (format: YYYY-MM-DD). Defaults to next available dates.",
        },
      },
      required: [],
    },
  },
  safeway_select_delivery_slot: {
    name: "safeway_select_delivery_slot",
    description: "Select a delivery time slot for your order.",
    inputSchema: {
      type: "object",
      properties: {
        slot_id: {
          type: "string",
          description: "The delivery slot ID to select (obtained from safeway_get_delivery_slots)",
        },
      },
      required: ["slot_id"],
    },
  },
  safeway_checkout: {
    name: "safeway_checkout",
    description:
      "Proceed to checkout with the current cart. Initiates the checkout process using the selected delivery slot.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  safeway_get_orders: {
    name: "safeway_get_orders",
    description:
      "Get the order history for your Safeway account. Returns a list of past and current orders.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  safeway_get_order_details: {
    name: "safeway_get_order_details",
    description: "Get detailed information about a specific order including all items and delivery information.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description: "The order ID to get details for",
        },
      },
      required: ["order_id"],
    },
  },
  safeway_clip_coupon: {
    name: "safeway_clip_coupon",
    description:
      "Clip (activate) a digital coupon to your account for use on your next purchase.",
    inputSchema: {
      type: "object",
      properties: {
        coupon_id: {
          type: "string",
          description: "The coupon ID to clip",
        },
      },
      required: ["coupon_id"],
    },
  },
  safeway_get_weekly_deals: {
    name: "safeway_get_weekly_deals",
    description:
      "Get the current weekly deals and sales from Safeway. Returns a list of featured deals with discounts.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const SearchProductsSchema = z.object({
  query: z.string().min(1),
  category: z.string().optional(),
  filters: z.record(z.string()).optional(),
});

const GetProductDetailsSchema = z.object({
  product_id: z.string().min(1),
});

const AddToCartSchema = z.object({
  product_id: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
});

const UpdateCartItemSchema = z.object({
  item_id: z.string().min(1),
  quantity: z.number().int().min(1),
});

const RemoveFromCartSchema = z.object({
  item_id: z.string().min(1),
});

const GetDeliverySlotsSchema = z.object({
  date: z.string().optional(),
});

const SelectDeliverySlotSchema = z.object({
  slot_id: z.string().min(1),
});

const GetOrderDetailsSchema = z.object({
  order_id: z.string().min(1),
});

const ClipCouponSchema = z.object({
  coupon_id: z.string().min(1),
});

interface SessionState {
  accountId: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
}

let activeBrowserAccountId: string | null = null;
let browserQueue: Promise<void> = Promise.resolve();

const sessions = new Map<string, SessionState>();
const knownActions = new Set<string>(ALL_ACTIONS);

function formatResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function createErrorContent(message: string) {
  return [{ type: "text" as const, text: `Error: ${message}` }];
}

function createSuccessContent(data: unknown) {
  return [{ type: "text" as const, text: formatResult(data) }];
}

function isAllowedAction(action: string): action is AllowedAction {
  return knownActions.has(action);
}

function withSerializedBrowser<T>(operation: () => Promise<T>): Promise<T> {
  const next = browserQueue.then(operation, operation);
  browserQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function ensureBrowserAccount(account: AuthenticatedAccount) {
  if (activeBrowserAccountId === account.accountId) {
    return;
  }

  await closeSession();
  activeBrowserAccountId = null;

  const result = await loginWithAccount({
    accountId: account.accountId,
    email: account.safewayCredentials.email,
    password: account.safewayCredentials.password,
    phoneNumber: account.safewayCredentials.phoneNumber,
    sessionStatePath: account.safewayCredentials.sessionStatePath,
    storefront: "safeway",
  });

  if (!result.success) {
    await closeSession();
    throw new Error(`Safeway login failed for account ${account.accountId}: ${result.message}`);
  }

  activeBrowserAccountId = account.accountId;
}

async function runAuthorizedTool<T>(
  account: AuthenticatedAccount,
  action: AllowedAction,
  operation: () => Promise<T>
) {
  return withSerializedBrowser(async () => {
    assertActionAllowed(account, action);
    await ensureBrowserAccount(account);
    return operation();
  });
}

async function handleToolCall(
  account: AuthenticatedAccount,
  name: AllowedAction,
  args: unknown
) {
  switch (name) {
    case "safeway_search_products": {
      const { query, category, filters } = SearchProductsSchema.parse(args);
      const products = await runAuthorizedTool(account, name, () =>
        searchProducts(query, category, filters)
      );
      return createSuccessContent({
        query,
        category,
        count: products.length,
        products,
      });
    }

    case "safeway_get_product_details": {
      const { product_id } = GetProductDetailsSchema.parse(args);
      const product = await runAuthorizedTool(account, name, () =>
        getProductDetails(product_id)
      );
      return createSuccessContent(product);
    }

    case "safeway_add_to_cart": {
      const { product_id, quantity } = AddToCartSchema.parse(args);
      const result = await runAuthorizedTool(account, name, () =>
        addToCart(product_id, quantity)
      );
      return createSuccessContent(result);
    }

    case "safeway_get_cart": {
      const cart = await runAuthorizedTool(account, name, () => getCart());
      return createSuccessContent(cart);
    }

    case "safeway_update_cart_item": {
      const { item_id, quantity } = UpdateCartItemSchema.parse(args);
      const result = await runAuthorizedTool(account, name, () =>
        updateCartItem(item_id, quantity)
      );
      return createSuccessContent(result);
    }

    case "safeway_remove_from_cart": {
      const { item_id } = RemoveFromCartSchema.parse(args);
      const result = await runAuthorizedTool(account, name, () =>
        removeFromCart(item_id)
      );
      return createSuccessContent(result);
    }

    case "safeway_get_delivery_slots": {
      const { date } = GetDeliverySlotsSchema.parse(args);
      const slots = await runAuthorizedTool(account, name, () =>
        getDeliverySlots(date)
      );
      return createSuccessContent({
        date,
        count: slots.length,
        slots,
      });
    }

    case "safeway_select_delivery_slot": {
      const { slot_id } = SelectDeliverySlotSchema.parse(args);
      const result = await runAuthorizedTool(account, name, () =>
        selectDeliverySlot(slot_id)
      );
      return createSuccessContent(result);
    }

    case "safeway_checkout": {
      const result = await runAuthorizedTool(account, name, () => checkout());
      return createSuccessContent(result);
    }

    case "safeway_get_orders": {
      const orders = await runAuthorizedTool(account, name, () => getOrders());
      return createSuccessContent({
        count: orders.length,
        orders,
      });
    }

    case "safeway_get_order_details": {
      const { order_id } = GetOrderDetailsSchema.parse(args);
      const order = await runAuthorizedTool(account, name, () =>
        getOrderDetails(order_id)
      );
      return createSuccessContent(order);
    }

    case "safeway_clip_coupon": {
      const { coupon_id } = ClipCouponSchema.parse(args);
      const result = await runAuthorizedTool(account, name, () =>
        clipCoupon(coupon_id)
      );
      return createSuccessContent(result);
    }

    case "safeway_get_weekly_deals": {
      const deals = await runAuthorizedTool(account, name, () => getWeeklyDeals());
      return createSuccessContent({
        count: deals.length,
        deals,
      });
    }
  }
}

function createSessionServer(account: AuthenticatedAccount) {
  const server = new Server(
    {
      name: "@striderlabs/mcp-safeway",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: account.allowedActionsArray.map((action) => TOOLS[action]),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (!isAllowedAction(name)) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const content = await handleToolCall(account, name, args ?? {});
      return { content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: createErrorContent(message),
        isError: true,
      };
    }
  });

  return server;
}

async function readRequestBody(req: IncomingMessage) {
  if (req.method !== "POST") {
    return undefined;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();

  if (rawBody === "") {
    return undefined;
  }

  return JSON.parse(rawBody);
}

function sendJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  headers: Record<string, string> = {}
) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
      },
      id: null,
    })
  );
}

async function closeAllSessions() {
  const uniqueServers = new Set<Server>();

  for (const session of sessions.values()) {
    uniqueServers.add(session.server);
    await session.transport.close().catch(() => undefined);
  }

  sessions.clear();

  for (const server of uniqueServers) {
    await server.close().catch(() => undefined);
  }

  await closeSession().catch(() => undefined);
  activeBrowserAccountId = null;
}

async function main() {
  const config = loadConfig();

  const httpServer = createServer(async (req, res) => {
    if (!req.url) {
      sendJsonRpcError(res, 400, "Missing request URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== config.mcpPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        allow: "GET, POST, DELETE, OPTIONS",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers":
          "authorization, content-type, mcp-session-id, last-event-id",
      });
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
      sendJsonRpcError(res, 405, `Unsupported method: ${req.method}`);
      return;
    }

    let parsedBody: unknown;

    try {
      parsedBody = await readRequestBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON request body";
      sendJsonRpcError(res, 400, message);
      return;
    }

    let account: AuthenticatedAccount;

    try {
      account = authenticateRequest(req, config);
    } catch (error) {
      if (error instanceof AuthError) {
        sendJsonRpcError(res, error.statusCode, error.message, error.headers);
        return;
      }

      throw error;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string" && sessionIdHeader.trim() !== ""
        ? sessionIdHeader
        : undefined;

    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (session) {
      if (session.accountId !== account.accountId) {
        sendJsonRpcError(res, 403, "Session does not belong to the authenticated account");
        return;
      }
    } else {
      if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
        sendJsonRpcError(
          res,
          sessionId ? 404 : 400,
          sessionId ? "Unknown MCP session" : "Initialization request required"
        );
        return;
      }

      const server = createSessionServer(account);
      let transport!: StreamableHTTPServerTransport;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, {
            accountId: account.accountId,
            server,
            transport,
          });
        },
        onsessionclosed: async (closedSessionId) => {
          sessions.delete(closedSessionId);
          await server.close().catch(() => undefined);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      transport.onerror = (error) => {
        console.error("Transport error:", error);
      };

      await server.connect(transport);

      session = {
        accountId: account.accountId,
        server,
        transport,
      };
    }

    const authenticatedRequest = req as IncomingMessage & {
      auth?: AuthenticatedAccount["authInfo"];
    };

    authenticatedRequest.auth = account.authInfo;

    try {
      await session.transport.handleRequest(authenticatedRequest, res, parsedBody);
    } catch (error) {
      console.error("Error handling MCP request:", error);

      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  process.on("SIGINT", async () => {
    await closeAllSessions();
    httpServer.close(() => process.exit(0));
  });

  process.on("SIGTERM", async () => {
    await closeAllSessions();
    httpServer.close(() => process.exit(0));
  });

  httpServer.listen(config.port, config.host, () => {
    console.error(
      `Safeway MCP server listening on http://${config.host}:${config.port}${config.mcpPath}`
    );
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
