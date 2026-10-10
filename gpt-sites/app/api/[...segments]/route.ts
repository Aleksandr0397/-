import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { inventoryApi } from "../../../server/inventory-api";

export async function GET(request: Request) { return inventoryApi(request, env, await getChatGPTUser()); }
export async function POST(request: Request) { return inventoryApi(request, env, await getChatGPTUser()); }
export async function PATCH(request: Request) { return inventoryApi(request, env, await getChatGPTUser()); }
