import { z } from "zod";
export const connectionTypes = { price: "Загрузка прайса", api: "Подключение по API", both: "Прайс и API" } as const;
const link = (httpsOnly = false, noQuery = false) => z.string().trim().max(2000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return (httpsOnly ? url.protocol === "https:" : ["https:", "http:"].includes(url.protocol)) && !url.username && !url.password && (!noQuery || !url.search && !url.hash); }
  catch { return false; }
}, httpsOnly ? "Укажите HTTPS-адрес API без логина, пароля и параметров доступа." : "Укажите корректную ссылку на сайт.");
export const supplierInputSchema = z.object({
  name: z.string().trim().min(1, "Укажите название поставщика.").max(120),
  apiProvider: z.enum(["", "rossko"]).default(""),
  connectionType: z.enum(["price", "api", "both"]).default("price"),
  leadDays: z.number().int().min(0).max(365).default(0),
  contactName: z.string().trim().max(120).default(""), phone: z.string().trim().max(60).default(""),
  email: z.union([z.literal(""), z.string().trim().email().max(254)]).default(""),
  website: link().default(""), apiUrl: link(true, true).default(""), apiDocsUrl: link().default(""),
  notes: z.string().trim().max(2000).default(""), enabled: z.boolean().default(true),
});
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export const supplierRecordSchema = z.object({
  id: z.string().min(1).max(80), name: supplierInputSchema.shape.name, name_key: z.string().min(1).max(3000),
  api_provider: supplierInputSchema.shape.apiProvider, connection_type: supplierInputSchema.shape.connectionType, lead_days: supplierInputSchema.shape.leadDays,
  contact_name: supplierInputSchema.shape.contactName, phone: supplierInputSchema.shape.phone, email: supplierInputSchema.shape.email,
  website: supplierInputSchema.shape.website, api_url: supplierInputSchema.shape.apiUrl, api_docs_url: supplierInputSchema.shape.apiDocsUrl,
  notes: supplierInputSchema.shape.notes, enabled: z.number().int().min(0).max(1), revision: z.number().int().positive(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
});
export type Supplier = z.infer<typeof supplierRecordSchema> & { product_count?: number; last_import_at?: string | null; apiConnected?: boolean; rossko?: import("./rossko").RosskoConnection };
export const supplierInput = (s: Supplier): SupplierInput => ({ name: s.name, apiProvider: s.api_provider, connectionType: s.connection_type, leadDays: s.lead_days, contactName: s.contact_name, phone: s.phone, email: s.email, website: s.website, apiUrl: s.api_url, apiDocsUrl: s.api_docs_url, notes: s.notes, enabled: s.enabled === 1 });
