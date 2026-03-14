import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";

const fromCharCodes = (...codes: number[]) => String.fromCharCode(...codes);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),

  extensionInstallId: text("extension_install_id").unique().notNull(),

  telegramId: text("telegram_id").unique(),

  telegramUsername: text("telegram_username"),

  notificationsSent: integer("notifications_sent").notNull().default(0),

  country: text("country"),

  lastOnline: timestamp("last_online", { withTimezone: true }),

  extensionVersion: text("extension_version"),

  uninstallReason: text("uninstall_reason"),

  uninstallReasonMessage: text("uninstall_reason_message"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
