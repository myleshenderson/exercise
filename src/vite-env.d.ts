/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" preloads the mock backend with synthetic ride fixtures (AI-649; screenshots --rides). */
  readonly VITE_MOCK_RIDES?: string;
}
