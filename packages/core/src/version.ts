/**
 * Engine compatibility version.
 *
 * Content packs declare the engine range they were written for in
 * `pack.json#engine`, e.g. `">=0.2 <1.0"`. That range is compared against this
 * constant only — never against the npm package version, which is decoupled
 * on purpose (`内容包规范.md` §3 S14): bumping the engine contract does not
 * require touching `package.json`.
 */

/** Semver the content-pack loader validates `engine` ranges against. */
export const ENGINE_VERSION = '0.2.0'
