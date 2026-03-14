import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "./env.js";
import { apiKeyAuth } from "./middleware/api-key.js";
import { errorHandler } from "./middleware/error-handler.js";
import confirmTokenRouter from "./routes/confirm-token.js";
import notifyStudyRouter from "./routes/notify-study.js";
import notifySummaryRouter from "./routes/notify-summary.js";
import statusRouter from "./routes/status.js";
import unlinkRouter from "./routes/unlink.js";
import unlinkExtensionRouter from "./routes/unlink-extension.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust reverse proxy (e.g. nginx) so req.ip reflects the real client IP
app.set("trust proxy", 1);

// Security middleware
app.use(helmet());
app.use(cors());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "../public")));

// JSON body parser for all other routes
app.use(express.json());

// Tight limit for the notification endpoint (triggers Telegram messages)
const notifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many notification requests. Please slow down.",
  },
});

// Extension uninstall callback — GET with no auth, must be before apiKeyAuth
app.use("/api", unlinkExtensionRouter);

// Optional API key authentication
app.use("/api", apiKeyAuth);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api", confirmTokenRouter);
app.use("/api", notifyLimiter, notifyStudyRouter);
app.use("/api", notifyLimiter, notifySummaryRouter);
app.use("/api", statusRouter);
app.use("/api", unlinkRouter);

// Error handler
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`🚀 API server running on http://localhost:${env.PORT}`);
});
