export type RosskoOptions = { deliveries: { id: string; name: string }[]; addresses: { id: number; label: string; city?: string; street?: string; house?: string; office?: string; deliveryIds: string[] }[] };
export type RosskoConnection = { key1Saved: boolean; key2Saved: boolean; verifiedAt: string | null; deliveryId: string; addressId: number | null; options: RosskoOptions; deliveryReady: boolean; deliveryWarning: string | null };
export type RosskoOffer = { offerId: string; guid?: string; stockId?: string; code: string; brand: string; name: string; priceCents: number; stock: number; multiplicity: number; leadDays: number; type: number; analogue: boolean; description?: string; deliveryStart?: string | null; deliveryEnd?: string | null };
export type RosskoInput = { key1?: string; key2?: string; deliveryId?: string; addressId?: number | null };

export const rosskoDeliveryLabel = "Новониколаевский, ул. Октябрьская, 81А";
export const rosskoDeliveryMethod = "Курьерская доставка";
export type RosskoWave = { deliveryStart: string; deliveryEnd: string; timeLimit: string };
// ROSSKO sends local calendar dates/times, often without a timezone. Preserve
// their calendar values instead of letting the viewer's timezone move a date.
export function rosskoDateTime(value: string, time = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return "";
  const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(match[1] + "-" + match[2] + "-" + match[3] + "T12:00:00Z"));
  return date + (time ? ", " + match[4] + ":" + match[5] : "");
}

export const rosskoDeliveryWarning = "ROSSKO не вернул способ «Курьерская доставка». Проверьте подключение повторно.";
