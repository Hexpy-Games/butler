const REQUIRED_READY_SERVICE_IDS = ["butler-main", "app-gateway"];

export function createAppAgentServiceAdapter({
  nativeServices,
  registration = null,
} = {}) {
  return {
    async getStatus() {
      const status = await serviceStatus(nativeServices);
      return {
        status: status.status,
        service_available: status.service_available,
        raw_text_included: false,
      };
    },
    async install(request = {}) {
      if (!registration?.install) {
        return {
          ok: false,
          status: "needs_permission",
          code: "service_registration_unavailable",
          raw_text_included: false,
        };
      }
      await registration.install({ source: "app-service-adapter", ...request });
      return {
        ok: true,
        status: "stopped",
        raw_text_included: false,
      };
    },
    async start(request = {}) {
      if (!nativeServices?.start) {
        return unavailable("service_start_unavailable");
      }
      await nativeServices.start({ source: "app-service-adapter", ...request });
      return asyncActionFromStatus(await serviceStatus(nativeServices));
    },
    async stop(request = {}) {
      if (!nativeServices?.stop) {
        return unavailable("service_stop_unavailable");
      }
      await nativeServices.stop({ source: "app-service-adapter", ...request });
      return actionFromStatus(await serviceStatus(nativeServices), "agent_service_stop_failed", {
        successStatus: "stopped",
      });
    },
    async restart(request = {}) {
      if (!nativeServices?.stop || !nativeServices?.start) {
        return unavailable("service_restart_unavailable");
      }
      await nativeServices.stop({ source: "app-service-adapter", ...request });
      await nativeServices.start({ source: "app-service-adapter", ...request });
      return asyncActionFromStatus(await serviceStatus(nativeServices));
    },
    async diagnostics() {
      const status = await serviceStatus(nativeServices);
      return {
        status: status.status,
        service_available: status.service_available,
        service_count: status.service_count,
        online_count: status.online_count,
        stale_count: status.stale_count,
        raw_text_included: false,
      };
    },
  };
}

async function serviceStatus(nativeServices) {
  if (!nativeServices?.list) {
    return {
      status: "needs_permission",
      service_available: false,
      service_count: 0,
      online_count: 0,
      stale_count: 0,
    };
  }
  let projections;
  try {
    projections = normalizeProjections(await nativeServices.list());
  } catch {
    return {
      status: "failed",
      service_available: true,
      service_count: 0,
      online_count: 0,
      stale_count: 0,
      status_read_failed: true,
    };
  }
  const serviceCount = projections.length;
  const onlineCount = projections.filter((item) => item.status === "online").length;
  const staleCount = projections.filter((item) => item.status === "stale").length;
  const offlineCount = projections.filter((item) => item.status === "offline").length;
  const hasGateway = projections.some(
    (item) => item.serviceId === "app-gateway" && item.status === "online",
  );
  const hasRequiredReadyServices = REQUIRED_READY_SERVICE_IDS.every((serviceId) =>
    projections.some((item) => item.serviceId === serviceId && item.status === "online"),
  );
  if (serviceCount === 0 || offlineCount === serviceCount) {
    return {
      status: "stopped",
      service_available: true,
      service_count: serviceCount,
      online_count: onlineCount,
      stale_count: staleCount,
    };
  }
  if (staleCount > 0) {
    return {
      status: "failed",
      service_available: true,
      service_count: serviceCount,
      online_count: onlineCount,
      stale_count: staleCount,
    };
  }
  if (onlineCount === serviceCount && hasGateway && hasRequiredReadyServices) {
    return {
      status: "ready",
      service_available: true,
      service_count: serviceCount,
      online_count: onlineCount,
      stale_count: staleCount,
    };
  }
  return {
    status: "starting",
    service_available: true,
    service_count: serviceCount,
    online_count: onlineCount,
    stale_count: staleCount,
  };
}

function normalizeProjections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      serviceId: typeof item.serviceId === "string" ? item.serviceId : "unknown",
      status: ["online", "offline", "stale"].includes(item.status)
        ? item.status
        : "stale",
    }));
}

function actionFromStatus(status, code, { successStatus = "ready" } = {}) {
  const ok = status.status === successStatus;
  return {
    ok,
    status: status.status,
    ...(ok ? {} : { code }),
    raw_text_included: false,
  };
}

function asyncActionFromStatus(status) {
  if (status.status_read_failed) {
    return {
      ok: false,
      status: status.status,
      code: "agent_service_not_ready",
      raw_text_included: false,
    };
  }
  return {
    ok: true,
    status: status.status,
    raw_text_included: false,
  };
}

function unavailable(code) {
  return {
    ok: false,
    status: "failed",
    code,
    raw_text_included: false,
  };
}
