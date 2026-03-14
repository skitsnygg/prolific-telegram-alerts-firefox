import { createDb } from "@prolific-alerts/database";
import { env } from "./env.js";

export const db = createDb(env.DATABASE_URL);
