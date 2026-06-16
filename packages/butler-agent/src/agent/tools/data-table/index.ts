import { createDataTableToolHandlers as createHandlerMap } from "./transform_public_data_table/executor.ts";

export function createDataTableToolHandlers(input: Parameters<typeof createHandlerMap>[0]) {
  return createHandlerMap(input);
}

export { transformPublicDataTable } from "./transform_public_data_table/executor.ts";
