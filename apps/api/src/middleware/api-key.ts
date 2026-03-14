import type { Request, Response, NextFunction } from "express";
import { env } from "../env.js";

/**
 * Optional API key middleware.
 * If API_KEY is set in env, all requests must include it in x-api-key header.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (!env.API_KEY) {
    next();
    return;
  }

  const providedKey = req.headers["x-api-key"];

  if (providedKey !== env.API_KEY) {
    res.status(401).json({
      success: false,
      message: "Invalid or missing API key",
    });
    return;
  }

  next();
}
