/**
 * Product identity (epic AIPP-2; FR-IDENT-001..003).
 *
 * Single source of truth for the renamed product's names. The package is
 * `aiproviderproxy` with the primary binary `aipp` (and an `aiproviderproxy`
 * alias); this replaces the former RelayPlane identity.
 */

/** npm package name. */
export const PRODUCT_NAME = 'aiproviderproxy';

/** Primary CLI binary name. */
export const BIN_NAME = 'aipp';

/** Secondary CLI binary alias (matches the package name). */
export const BIN_ALIAS = 'aiproviderproxy';

/** Human-facing product display name. */
export const DISPLAY_NAME = 'AI Provider Proxy';

/** Root directory name under the user's home for config and state. */
export const HOME_DIR_NAME = '.aiproviderproxy';

/**
 * Product version. Must be kept in sync with `package.json` "version"; it is
 * declared here because `tsc` (rootDir `./src`) cannot import the manifest.
 * Reported to Tokemetry as the source version of exported usage events.
 */
export const PRODUCT_VERSION = '2.1.0';
