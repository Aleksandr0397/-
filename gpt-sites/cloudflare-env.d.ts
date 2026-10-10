declare namespace Cloudflare {
  interface Env {
    SUPPLIER_CREDENTIALS_KEY?: string;
    ROSSKO_KEY1?: string;
    ROSSKO_KEY2?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
    RESEND_API_KEY?: string;
    ORDER_EMAIL_FROM?: string;
    MOYSKLAD_TOKEN?: string;
    MOYSKLAD_PRICE_TYPE_ID?: string;
    MOYSKLAD_PRICE_UNIT?: string;
    SABY_ACCESS_TOKEN?: string;
    SABY_POINT_ID?: string;
    SABY_PRICE_LIST_ID?: string;
    SABY_PRICE_UNIT?: string;
  }
}
