// Compatibility facade: runtime consumers keep importing from config.js while
// the registry owns provider discovery, validation and normalization.
export {
  buildProviderRuntimeConfig,
  getProviderCandidates,
  getProviderConfig,
  listProviderDefinitions,
  listProviders,
  resolveProvider,
  resolveProviderAlias,
  resolveProviderOutputTokens,
  validateProviderDefinition,
  validateProvidersDocument
} from "./provider-registry.js";
