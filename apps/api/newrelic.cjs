"use strict";

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || "prolific-api"],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  distributed_tracing: {
    enabled: true,
  },
  logging: {
    enabled: true,
    level: "info",
  },
  audit_log: {
    enabled: true,
  },
  application_logging: {
    enabled: true,
    forwarding: {
      enabled: true,
    },
    local_decorating: {
      enabled: true,
    },
  },
  allow_all_headers: true,
};
