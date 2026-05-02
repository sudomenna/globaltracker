/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_EDGE_URL: string;
  readonly PUBLIC_PAGE_ID: string;
  readonly PUBLIC_WORKSPACE_ID: string;
  readonly PUBLIC_TRACKER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
