interface ProviderSettings {
  base_url: string | null;
  api_key_secret: string;
}

export const PROVIDER_SETTINGS = {
  anthropic: { base_url: null, api_key_secret: "ANTHROPIC_API_KEY" },
  openrouter: { base_url: "https://openrouter.ai/api", api_key_secret: "OPENROUTER_API_KEY" },
} as const satisfies Record<string, ProviderSettings>;

export type Provider = keyof typeof PROVIDER_SETTINGS;

export const PROVIDERS = Object.keys(PROVIDER_SETTINGS) as [Provider, ...Provider[]];
