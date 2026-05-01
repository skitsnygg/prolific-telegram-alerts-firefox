type AuditEventType =
  | "EXTENSION_LINK_SUCCESS"
  | "EXTENSION_LINK_ERROR"
  | "NOTIFICATION_SENT"
  | "EXTENSION_UNLINK_UNINSTALL"
  | "EXTENSION_UNLINK_COMMAND";

type NotificationType = "NEW" | "SUMMARY" | "REAPPEARED";
type Provider = "prolific" | "cloudresearch";

type AuditEvent = {
  eventType: AuditEventType;
  success: boolean;
  userId?: string;
  telegramId?: string;
  extensionId?: string;
  notificationType?: NotificationType;
  provider?: Provider;
  errorCode?: string;
  message?: string;
  correlationId?: string;
  studyUrl?: string;
  // Rich study details for debugging duplicate notifications
  studyTitle?: string;
  studyReward?: string;
  studyPlaces?: string;
  studyCompletionTime?: string;
  studyMobileSupported?: boolean;
  studyPostedAt?: string;
  reappeared?: boolean;
  // Summary-specific fields
  summaryTotalNew?: number;
  summaryStudyUrls?: string;
  summaryStudyTitles?: string;
  // Dedup diagnostics
  deduplicated?: boolean;
  dedupSource?: string;
};

export function getCorrelationId(
  headers: Record<string, unknown>,
): string | undefined {
  const candidate = headers["x-correlation-id"] ?? headers["x-request-id"];
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return candidate;
  }
  return undefined;
}

export function auditLog(event: AuditEvent): void {
  const logRecord = {
    logType: "audit",
    service: "api",
    timestamp: new Date().toISOString(),
    ...event,
  };

  console.log(JSON.stringify(logRecord));
}
