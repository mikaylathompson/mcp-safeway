#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  login,
  searchProducts,
  getProductDetails,
  addToCart,
  getCart,
  updateCartItem,
  removeFromCart,
  getDeliverySlots,
  selectDeliverySlot,
  checkout,
  getOrders,
  getOrderDetails,
  clipCoupon,
  getWeeklyDeals,
  closeSession,
} from "./browser.js";

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "safeway_login",
    description:
      "Log in to your Safeway/Albertsons account. Must be called before using any other tools that require authentication.",
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Your Safeway account email address",
        },
        password: {
          type: "string",
          description: "Your Safeway account password",
        },
      },
      required: ["email", "password"],
    },
  },
  {
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
  {
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
  {
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
  {
    name: "safeway_get_cart",
    description:
      "Retrieve the current contents of the shopping cart including all items, quantities, prices, and cart totals.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
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
  {
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
  {
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
  {
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
  {
    name: "safeway_checkout",
    description:
      "Proceed to checkout with the current cart. Initiates the checkout process using the selected delivery slot.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "safeway_get_orders",
    description:
      "Get the order history for your Safeway account. Returns a list of past and current orders.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
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
  {
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
  {
    name: "safeway_get_weekly_deals",
    description:
      "Get the current weekly deals and sales from Safeway. Returns a list of featured deals with discounts.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// Input schemas for validation
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

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

function formatResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function createErrorContent(message: string) {
  return [{ type: "text" as const, text: `Error: ${message}` }];
}

function createSuccessContent(data: unknown) {
  return [{ type: "text" as const, text: formatResult(data) }];
}

async function handleToolCall(name: string, args: unknown) {
  switch (name) {
    case "safeway_login": {
      const { email, password } = LoginSchema.parse(args);
      const result = await login(email, password);
      return createSuccessContent(result);
    }

    case "safeway_search_products": {
      const { query, category, filters } = SearchProductsSchema.parse(args);
      const products = await searchProducts(query, category, filters);
      return createSuccessContent({
        query,
        category,
        count: products.length,
        products,
      });
    }

    case "safeway_get_product_details": {
      const { product_id } = GetProductDetailsSchema.parse(args);
      const product = await getProductDetails(product_id);
      return createSuccessContent(product);
    }

    case "safeway_add_to_cart": {
      const { product_id, quantity } = AddToCartSchema.parse(args);
      const result = await addToCart(product_id, quantity);
      return createSuccessContent(result);
    }

    case "safeway_get_cart": {
      const cart = await getCart();
      return createSuccessContent(cart);
    }

    case "safeway_update_cart_item": {
      const { item_id, quantity } = UpdateCartItemSchema.parse(args);
      const result = await updateCartItem(item_id, quantity);
      return createSuccessContent(result);
    }

    case "safeway_remove_from_cart": {
      const { item_id } = RemoveFromCartSchema.parse(args);
      const result = await removeFromCart(item_id);
      return createSuccessContent(result);
    }

    case "safeway_get_delivery_slots": {
      const { date } = GetDeliverySlotsSchema.parse(args);
      const slots = await getDeliverySlots(date);
      return createSuccessContent({
        date,
        count: slots.length,
        slots,
      });
    }

    case "safeway_select_delivery_slot": {
      const { slot_id } = SelectDeliverySlotSchema.parse(args);
      const result = await selectDeliverySlot(slot_id);
      return createSuccessContent(result);
    }

    case "safeway_checkout": {
      const result = await checkout();
      return createSuccessContent(result);
    }

    case "safeway_get_orders": {
      const orders = await getOrders();
      return createSuccessContent({
        count: orders.length,
        orders,
      });
    }

    case "safeway_get_order_details": {
      const { order_id } = GetOrderDetailsSchema.parse(args);
      const order = await getOrderDetails(order_id);
      return createSuccessContent(order);
    }

    case "safeway_clip_coupon": {
      const { coupon_id } = ClipCouponSchema.parse(args);
      const result = await clipCoupon(coupon_id);
      return createSuccessContent(result);
    }

    case "safeway_get_weekly_deals": {
      const deals = await getWeeklyDeals();
      return createSuccessContent({
        count: deals.length,
        deals,
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const content = await handleToolCall(name, args ?? {});
      return { content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: createErrorContent(message),
        isError: true,
      };
    }
  });

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    await closeSession();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await closeSession();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with MCP stdio protocol
  console.error("Safeway MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
