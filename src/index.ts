/**
 * aiproviderproxy — public library surface.
 *
 * A local, multi-protocol AI gateway. The product is normally used via the
 * `aipp` CLI (see `src/cli/`); this barrel exposes the pieces a Node embedder
 * needs to run the gateway in-process. The legacy standalone proxy and all
 * RelayPlane cloud code were removed at v2.0.0 (epic AIPP-13).
 *
 * @packageDocumentation
 */

export { createGateway, Gateway, type GatewayDeps } from './gateway/server.js';
export { buildProviderRegistry } from './gateway/providers.js';
export {
  loadConfig,
  saveConfig,
  defaultConfig,
  configPath,
  configHome,
  type Config,
} from './config/index.js';
export { runCli } from './cli/cli.js';
export { PRODUCT_NAME, BIN_NAME } from './identity.js';
