/**
 * Product Catalog tools for the Meta connector.
 *
 * Read-only in this iteration. Covers:
 *   - Business discovery (needed to find owned catalogs)
 *   - Catalog listing + details
 *   - Product feed listing
 *   - Catalog diagnostics (Meta's aggregated issue endpoint + latest
 *     upload error report as fallback)
 *   - Paginated product listing (single page; pass paging.next back in)
 *
 * Scope required on the System User token: `business_management` for the
 * business + catalog discovery, `catalog_management` for products, feeds
 * and diagnostics edges.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MetaClient } from "./meta-client.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value, null, 2) },
    ],
  };
}

export function registerCatalogTools(server: McpServer, meta: MetaClient): void {
  // ----------------------------------------------------------- Businesses
  server.registerTool(
    "list_businesses",
    {
      description:
        "List all Meta Business Manager accounts reachable from the authenticated System User. Discovery walks /me/adaccounts and /me/accounts (Pages) and deduplicates the parent businesses — /me/businesses returns empty for System User tokens. Use the returned business IDs as input to list_product_catalogs. Read-only.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max ad accounts / pages to inspect (default 50)"),
      },
    },
    async ({ limit }) => {
      const pageLimit = limit ?? 50;
      interface BizRef {
        id: string;
        name?: string;
      }
      const businesses = new Map<string, BizRef>();

      // Walk Ad Accounts → business
      const accounts = await meta.get<{
        data?: { id: string; business?: BizRef }[];
      }>("/me/adaccounts", {
        fields: "id,business{id,name}",
        limit: pageLimit,
      });
      for (const a of accounts.data ?? []) {
        if (a.business?.id) businesses.set(a.business.id, a.business);
      }

      // Walk Pages → business (Pages also have a parent business)
      const pages = await meta.get<{
        data?: { id: string; business?: BizRef }[];
      }>("/me/accounts", {
        fields: "id,business{id,name}",
        limit: pageLimit,
      });
      for (const p of pages.data ?? []) {
        if (p.business?.id) businesses.set(p.business.id, p.business);
      }

      return asJson({
        data: Array.from(businesses.values()),
        source: "deduplicated_from_adaccounts_and_pages",
      });
    }
  );

  // ------------------------------------------------------------- Catalogs
  server.registerTool(
    "list_product_catalogs",
    {
      description:
        "List product catalogs owned by a Business. Returns id, name, vertical, product_count and feed_count per catalog. Read-only.",
      inputSchema: {
        business_id: z.string()
          .describe("Business Manager ID (from list_businesses)"),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max catalogs per page (default 25)"),
      },
    },
    async ({ business_id, limit }) => {
      const data = await meta.get(
        `/${business_id}/owned_product_catalogs`,
        {
          fields:
            "id,name,vertical,product_count,feed_count,da_display_settings",
          limit: limit ?? 25,
        }
      );
      return asJson(data);
    }
  );

  server.registerTool(
    "get_product_catalog",
    {
      description:
        "Fetch full details for a single product catalog including name, vertical, product/feed counts and configuration.",
      inputSchema: {
        catalog_id: z.string().describe("Product Catalog ID"),
        fields: z.string().optional()
          .describe("Comma-separated fields to retrieve (default: useful summary)"),
      },
    },
    async ({ catalog_id, fields }) => {
      const data = await meta.get(`/${catalog_id}`, {
        fields:
          fields ??
          "id,name,vertical,product_count,feed_count,business,is_catalog_segment,default_image_url",
      });
      return asJson(data);
    }
  );

  // ------------------------------------------------------------- Feeds
  server.registerTool(
    "list_product_feeds",
    {
      description:
        "List product feeds attached to a catalog. Returns id, name, schedule (pull frequency), file_name, latest_upload status and item counts. Read-only.",
      inputSchema: {
        catalog_id: z.string().describe("Product Catalog ID"),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Max feeds per page (default 25)"),
      },
    },
    async ({ catalog_id, limit }) => {
      const data = await meta.get(`/${catalog_id}/product_feeds`, {
        fields:
          "id,name,file_name,country,encoding,delimiter,quoted_fields_mode,schedule,update_schedule,latest_upload{id,start_time,end_time,error_count,warning_count,num_invalid_appends,num_persisted_items},product_count,created_time",
        limit: limit ?? 25,
      });
      return asJson(data);
    }
  );

  // ----------------------------------------------------- Diagnostics
  server.registerTool(
    "get_catalog_diagnostics",
    {
      description:
        "Fetch aggregated catalog issues (rejected items, missing fields, image problems) from Meta's diagnostics endpoint. Falls back to the latest feed upload's error report if /diagnostics returns no rows. Read-only.",
      inputSchema: {
        catalog_id: z.string().describe("Product Catalog ID"),
        affected_channels: z.string().optional()
          .describe("Comma-separated channels to filter (e.g. 'advertising,commerce'). Defaults to all."),
        severity: z.enum(["MUST_FIX", "OPPORTUNITY"]).optional()
          .describe("Filter by severity. Defaults to both."),
        limit: z.number().int().min(1).max(200).optional()
          .describe("Max diagnostic rows (default 50)"),
      },
    },
    async ({ catalog_id, affected_channels, severity, limit }) => {
      const params: Record<string, string | number> = {
        fields:
          "id,type,severity,affected_entity,affected_channels,affected_features,number_of_affected_items,error_code,description,diagnostic_group,subtype,handler,handler_type,handler_function,handler_props,more_info_link",
        limit: limit ?? 50,
      };
      if (affected_channels) params.affected_channels = affected_channels;
      if (severity) params.severity = severity;

      interface DiagnosticsPage {
        data?: unknown[];
        paging?: unknown;
      }
      const diag = await meta.get<DiagnosticsPage>(
        `/${catalog_id}/diagnostics`,
        params
      );

      // If diagnostics endpoint is empty, fall back to latest feed-upload errors.
      if (!diag.data || diag.data.length === 0) {
        interface Feed {
          id: string;
          name?: string;
          latest_upload?: {
            id: string;
            error_count?: number;
            warning_count?: number;
          };
        }
        const feeds = await meta.get<{ data?: Feed[] }>(
          `/${catalog_id}/product_feeds`,
          {
            fields: "id,name,latest_upload{id,error_count,warning_count}",
            limit: 25,
          }
        );
        const errorUploads = (feeds.data ?? []).filter(
          (f) =>
            f.latest_upload &&
            ((f.latest_upload.error_count ?? 0) > 0 ||
              (f.latest_upload.warning_count ?? 0) > 0)
        );
        if (errorUploads.length === 0) {
          return asJson({
            data: [],
            note: "No diagnostics rows and no feed-upload errors. Catalog looks healthy.",
          });
        }
        const reports = await Promise.all(
          errorUploads.map(async (f) => {
            const uploadId = f.latest_upload!.id;
            const errs = await meta.get(`/${uploadId}/errors`, {
              fields: "id,severity,summary,description,row_number,affected_field_name,sample",
              limit: 25,
            });
            return {
              feed_id: f.id,
              feed_name: f.name,
              upload_id: uploadId,
              errors: errs,
            };
          })
        );
        return asJson({
          source: "feed_upload_errors_fallback",
          note: "Catalog /diagnostics returned no rows; showing latest feed-upload error reports instead.",
          reports,
        });
      }

      return asJson(diag);
    }
  );

  // ---------------------------------------------------------- Products
  server.registerTool(
    "list_catalog_products",
    {
      description:
        "List products inside a catalog, single page. Returns paging.next which you can pass back via `after` to fetch the next page. Read-only. Use sparingly on huge catalogs — Meta rate-limits this edge.",
      inputSchema: {
        catalog_id: z.string().describe("Product Catalog ID"),
        limit: z.number().int().min(1).max(100).optional()
          .describe("Items per page, max 100 (default 50)"),
        after: z.string().optional()
          .describe("Pagination cursor from a previous response's paging.cursors.after"),
        availability: z.enum([
          "in stock",
          "out of stock",
          "preorder",
          "available for order",
          "discontinued",
        ]).optional().describe("Filter by availability state"),
        condition: z.enum(["new", "refurbished", "used"]).optional()
          .describe("Filter by item condition"),
        fields: z.string().optional()
          .describe("Comma-separated fields (default: a useful summary set)"),
      },
    },
    async ({ catalog_id, limit, after, availability, condition, fields }) => {
      const params: Record<string, string | number> = {
        fields:
          fields ??
          "id,retailer_id,name,description,availability,condition,price,sale_price,currency,brand,category,image_url,url,gtin,review_status,visibility",
        limit: limit ?? 50,
      };
      if (after) params.after = after;

      // Graph filter syntax: JSON array of {field, operator, value}
      const filters: { field: string; operator: string; value: string }[] = [];
      if (availability) {
        filters.push({ field: "availability", operator: "EQUAL", value: availability });
      }
      if (condition) {
        filters.push({ field: "condition", operator: "EQUAL", value: condition });
      }
      if (filters.length > 0) {
        params.filter = JSON.stringify(
          filters.length === 1
            ? filters[0]
            : { and: filters }
        );
      }

      const data = await meta.get(`/${catalog_id}/products`, params);
      return asJson(data);
    }
  );
}
