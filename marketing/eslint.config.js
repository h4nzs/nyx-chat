import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import eslintPluginAstro from 'eslint-plugin-astro';

export default tseslint.config(
  // 1. Abaikan folder hasil build
  { ignores: ['dist', '.astro'] },

  // 2. Ini adalah pengganti "extends". 
  // Kita sebar config bawaan langsung di akar (root) array.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...eslintPluginAstro.configs.recommended,
  reactHooks.configs.flat.recommended,
  reactRefresh.configs.vite,

  // 3. Aturan spesifik HANYA untuk file TypeScript & React (TS/TSX)
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: true, 
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }
);