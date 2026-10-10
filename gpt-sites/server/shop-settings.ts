import { z } from "zod";
import { InputError } from "../lib/inventory-domain";
export type OrderSettingsEnv = { ORDER_NOTIFICATION_EMAIL?: string };
const emailSchema = z.string().trim().email().max(254);
export async function orderSettings(db: D1Database, env: OrderSettingsEnv) {
  let recipient = (await db.prepare("SELECT value FROM settings WHERE key='order_notification_email'").first<{ value: string }>())?.value;
  const configured = emailSchema.safeParse(env.ORDER_NOTIFICATION_EMAIL);
  if (recipient === undefined && configured.success) {
    await db.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('order_notification_email',?)").bind(configured.data.toLowerCase()).run();
    recipient = (await db.prepare("SELECT value FROM settings WHERE key='order_notification_email'").first<{ value: string }>())?.value;
  }
  return { orderEmail: recipient ?? "", emailSendingConnected: false };
}
export async function saveOrderSettings(db: D1Database, input: unknown) {
  const parsed = z.object({ orderEmail: z.union([z.literal(""), emailSchema]) }).safeParse(input);
  if (!parsed.success) throw new InputError("Укажите корректный email для получения заказов.");
  await db.prepare("INSERT INTO settings (key,value) VALUES ('order_notification_email',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(parsed.data.orderEmail.toLowerCase()).run();
  return { orderEmail: parsed.data.orderEmail.toLowerCase(), emailSendingConnected: false };
}
