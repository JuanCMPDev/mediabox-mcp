/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

interface ImportMetaEnv {
  readonly VITE_API_URL:           string;
  readonly VITE_INTERNAL_API_KEY:  string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
