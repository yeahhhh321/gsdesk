import type { ServiceSnapshot } from "./types";

export const GSUID_CORE_SERVICE_ID = "gsuid_core";
export const NONEBOT2_SERVICE_ID = "nonebot2";

export function findGsuidCore(services: ServiceSnapshot[]) {
  return services.find((service) => service.serviceId === GSUID_CORE_SERVICE_ID);
}
