import { listProviderDefinitions, listProviders } from "../src/config.js";

const definitions = listProviderDefinitions();
console.log(JSON.stringify({
  ok: true,
  providerCount: definitions.length,
  enabledProviders: listProviders(),
  configFiles: definitions.map(({ id }) => `config/providers/${id}.json`)
}, null, 2));
