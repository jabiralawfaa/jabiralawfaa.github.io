// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Site di-deploy ke GitHub Pages (user site: jabiralawfaa.github.io)
export default defineConfig({
  site: 'https://jabiralawfaa.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
});
