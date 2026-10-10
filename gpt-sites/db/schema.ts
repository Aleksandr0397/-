import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, check } from "drizzle-orm/sqlite-core";
export const settings = sqliteTable("settings", { key: text("key").primaryKey(), value: text("value").notNull() });
export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(), authUserId: text("auth_user_id").unique(), email: text("email").notNull().unique(),
  name: text("name").notNull(), role: text("role").notNull().default("customer"),
  discountBps: integer("discount_bps").notNull().default(0), createdAt: text("created_at").notNull(),
  markupBps: integer("markup_bps").notNull().default(0),
}, () => [check("discount_range", sql.raw("discount_bps >= 0 AND discount_bps <= 8000")), check("markup_range", sql.raw("markup_bps >= 0 AND markup_bps <= 100000"))]);
export const suppliers = sqliteTable("suppliers", {
  id: text("id").primaryKey(), name: text("name").notNull(), nameKey: text("name_key").notNull().unique(),
  apiProvider: text("api_provider").notNull().default(""), connectionType: text("connection_type").notNull().default("price"), leadDays: integer("lead_days").notNull().default(0),
  contactName: text("contact_name").notNull().default(""), phone: text("phone").notNull().default(""), email: text("email").notNull().default(""),
  website: text("website").notNull().default(""), apiUrl: text("api_url").notNull().default(""), apiDocsUrl: text("api_docs_url").notNull().default(""),
  notes: text("notes").notNull().default(""), enabled: integer("enabled").notNull().default(1), revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, () => [check("supplier_connection_type", sql.raw("connection_type IN ('price','api','both')")), check("supplier_enabled", sql.raw("enabled IN (0,1)")), check("supplier_lead_days", sql.raw("lead_days >= 0 AND lead_days <= 365")), check("supplier_revision", sql.raw("revision > 0"))]);
// Credentials deliberately stay outside portable data backups.
export const supplierConnections = sqliteTable("supplier_connections", {
  supplierId: text("supplier_id").primaryKey().references(() => suppliers.id),
  keysCipher: text("keys_cipher").notNull(), deliveryId: text("delivery_id").notNull().default(""),
  addressId: integer("address_id"), optionsJson: text("options_json").notNull(), verifiedAt: text("verified_at"),
  revision: integer("revision").notNull().default(1), lastRequestAt: integer("last_request_at").notNull().default(0),
});
export const imports = sqliteTable("imports", {
  id: text("id").primaryKey(), filename: text("filename").notNull(), fileKey: text("file_key"),
  rowCount: integer("row_count").notNull().default(0), createdAt: text("created_at").notNull(),
  sourceName: text("source_name").notNull().default("Мой склад"), sourceType: text("source_type").notNull().default("warehouse"),
  leadDays: integer("lead_days"),
  supplierId: text("supplier_id").references(() => suppliers.id),
});
export const products = sqliteTable("products", {
  id: text("id").primaryKey(), importId: text("import_id").notNull().references(() => imports.id),
  code: text("code").notNull(), brand: text("brand").notNull().default(""), name: text("name").notNull(),
  searchText: text("search_text").notNull(), stock: integer("stock"), priceCents: integer("price_cents").notNull(),
  warehouse: text("warehouse").notNull().default(""), bin: text("bin").notNull().default(""), minStock: integer("min_stock").notNull().default(0),
}, t => [uniqueIndex("offer_code_brand").on(t.importId, t.code, t.brand),
  check("stock_nonnegative", sql.raw("stock IS NULL OR stock >= 0")),
  check("price_positive", sql.raw("price_cents > 0"))]);
export const productPhotos = sqliteTable("product_photos", {
  id: text("id").primaryKey(), productId: text("product_id").notNull().references(() => products.id),
  fileKey: text("file_key").notNull(), filename: text("filename").notNull(), contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(), width: integer("width").notNull(), height: integer("height").notNull(),
  position: integer("position").notNull(), createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("one_photo_position").on(t.productId, t.position),
  check("photo_position", sql.raw("position >= 0 AND position < 5")),
  check("photo_size", sql.raw("size_bytes > 0 AND size_bytes <= 3000000")),
  check("photo_dimensions", sql.raw("width > 0 AND width <= 6000 AND height > 0 AND height <= 6000 AND width*height <= 24000000")),
  check("photo_content_type", sql.raw("content_type IN ('image/jpeg','image/png','image/webp')"))]);
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => customers.id),
  idempotencyKey: text("idempotency_key").notNull(), totalCents: integer("total_cents").notNull(),
  status: text("status").notNull().default("new"), comment: text("comment").notNull().default(""),
  createdAt: text("created_at").notNull(),
  channel: text("channel").notNull().default("online"), fiscalStatus: text("fiscal_status").notNull().default("not_sent"),
}, t => [uniqueIndex("one_checkout").on(t.customerId, t.idempotencyKey),
  check("total_positive", sql.raw("total_cents > 0"))]);
export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(), orderId: text("order_id").notNull().references(() => orders.id),
  productId: text("product_id").notNull().references(() => products.id),
  code: text("code").notNull(), brand: text("brand").notNull(), name: text("name").notNull(),
  quantity: integer("quantity").notNull(), unitPriceCents: integer("unit_price_cents").notNull(),
  sourceName: text("source_name").notNull().default("Мой склад"), sourceType: text("source_type").notNull().default("warehouse"), leadDays: integer("lead_days"),
}, () => [check("quantity_positive", sql.raw("quantity > 0"))]);
export const vinRequests = sqliteTable("vin_requests", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => customers.id),
  vin: text("vin").notNull(), vehicle: text("vehicle").notNull(), details: text("details").notNull(),
  answer: text("answer").notNull().default(""), status: text("status").notNull().default("new"), createdAt: text("created_at").notNull(),
});
export const topups = sqliteTable("topups", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => customers.id),
  amountCents: integer("amount_cents").notNull(), reference: text("reference").notNull(), status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(), approvedAt: text("approved_at"),
}, () => [check("topup_positive", sql.raw("amount_cents > 0"))]);
export const ledger = sqliteTable("ledger", {
  id: text("id").primaryKey(), customerId: text("customer_id").notNull().references(() => customers.id),
  amountCents: integer("amount_cents").notNull(), kind: text("kind").notNull(), referenceId: text("reference_id").notNull().unique(), createdAt: text("created_at").notNull(),
});
export const stockMovements = sqliteTable("stock_movements", {
  id: text("id").primaryKey(), productId: text("product_id").notNull().references(() => products.id),
  delta: integer("delta"), kind: text("kind").notNull(), referenceId: text("reference_id").notNull(), createdAt: text("created_at").notNull(),
});
export const purchaseRuns = sqliteTable("purchase_runs", {
  id: text("id").primaryKey(), idempotencyKey: text("idempotency_key").notNull().unique(),
  createdBy: text("created_by").notNull().references(() => customers.id), createdAt: text("created_at").notNull(),
});
export const purchaseOrders = sqliteTable("purchase_orders", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => purchaseRuns.id),
  supplierName: text("supplier_name").notNull(), status: text("status").notNull().default("draft"),
  totalCents: integer("total_cents").notNull(), createdAt: text("created_at").notNull(), orderedAt: text("ordered_at"),
}, () => [check("purchase_total_positive", sql.raw("total_cents > 0"))]);
export const purchaseItems = sqliteTable("purchase_order_items", {
  id: text("id").primaryKey(), purchaseId: text("purchase_id").notNull().references(() => purchaseOrders.id),
  warehouseProductId: text("warehouse_product_id").notNull().references(() => products.id),
  supplierProductId: text("supplier_product_id").notNull().references(() => products.id),
  code: text("code").notNull(), brand: text("brand").notNull(), name: text("name").notNull(),
  quantity: integer("quantity").notNull(), receivedQty: integer("received_qty").notNull().default(0),
  unitCostCents: integer("unit_cost_cents").notNull(), leadDays: integer("lead_days"),
}, t => [uniqueIndex("one_purchase_line").on(t.purchaseId, t.warehouseProductId),
  check("purchase_quantity_positive", sql.raw("quantity > 0")),
  check("purchase_received_range", sql.raw("received_qty >= 0 AND received_qty <= quantity")),
  check("purchase_cost_positive", sql.raw("unit_cost_cents > 0"))]);
export const purchaseReceipts = sqliteTable("purchase_receipts", {
  id: text("id").primaryKey(), purchaseId: text("purchase_id").notNull().references(() => purchaseOrders.id),
  idempotencyKey: text("idempotency_key").notNull().unique(), createdBy: text("created_by").notNull().references(() => customers.id),
  createdAt: text("created_at").notNull(),
});
export const purchaseReceiptItems = sqliteTable("purchase_receipt_items", {
  id: text("id").primaryKey(), receiptId: text("receipt_id").notNull().references(() => purchaseReceipts.id),
  purchaseItemId: text("purchase_item_id").notNull().references(() => purchaseItems.id), quantity: integer("quantity").notNull(),
}, t => [uniqueIndex("one_receipt_line").on(t.receiptId, t.purchaseItemId), check("receipt_quantity_positive", sql.raw("quantity > 0"))]);
