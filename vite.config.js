import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'public',
  publicDir: false,
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'public/index.html'),
      },
    },
    copyPublicDir: false,
  },
  server: {
    port: 5173,
  },
  plugins: [
    {
      name: 'copy-static-files',
      writeBundle() {
        const filesToCopy = [
          'service-worker.js',
          'manifest.json',
          'share.html',
          'index.js',
          'share-page.js',
          'geminiService.js',
          'imageOptimizer.js',
          'performanceMonitor.js',
          'generate-standalone.js',
          'tailwind.css',
          'admin-dashboard.html',
          'user-guide.html',
          'profile.html',
          'language-helper.js',
          'sw-share.js',
          'admin-settings.html',
          'download.html',
          'privacy.html'
        ];
        
        filesToCopy.forEach(file => {
          const src = path.resolve(__dirname, 'public', file);
          const dest = path.resolve(__dirname, 'dist/public', file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
          }
        });
        
        const assetsDir = path.resolve(__dirname, 'public/assets');
        const destAssetsDir = path.resolve(__dirname, 'dist/public/assets');
        if (fs.existsSync(assetsDir)) {
          if (!fs.existsSync(destAssetsDir)) {
            fs.mkdirSync(destAssetsDir, { recursive: true });
          }
          fs.readdirSync(assetsDir).forEach(file => {
            fs.copyFileSync(
              path.join(assetsDir, file),
              path.join(destAssetsDir, file)
            );
          });
        }
        
        const sharedTemplateDir = path.resolve(__dirname, 'public/shared-template');
        const destSharedTemplateDir = path.resolve(__dirname, 'dist/public/shared-template');
        if (fs.existsSync(sharedTemplateDir)) {
          if (!fs.existsSync(destSharedTemplateDir)) {
            fs.mkdirSync(destSharedTemplateDir, { recursive: true });
          }
          fs.readdirSync(sharedTemplateDir).forEach(file => {
            fs.copyFileSync(
              path.join(sharedTemplateDir, file),
              path.join(destSharedTemplateDir, file)
            );
          });
        }
        
        const imagesDir = path.resolve(__dirname, 'public/images');
        const destImagesDir = path.resolve(__dirname, 'dist/public/images');
        if (fs.existsSync(imagesDir)) {
          if (!fs.existsSync(destImagesDir)) {
            fs.mkdirSync(destImagesDir, { recursive: true });
          }
          fs.readdirSync(imagesDir).forEach(file => {
            fs.copyFileSync(
              path.join(imagesDir, file),
              path.join(destImagesDir, file)
            );
          });
        }
        
        const componentsDir = path.resolve(__dirname, 'public/components');
        const destComponentsDir = path.resolve(__dirname, 'dist/public/components');
        if (fs.existsSync(componentsDir)) {
          if (!fs.existsSync(destComponentsDir)) {
            fs.mkdirSync(destComponentsDir, { recursive: true });
          }
          fs.readdirSync(componentsDir).forEach(file => {
            fs.copyFileSync(
              path.join(componentsDir, file),
              path.join(destComponentsDir, file)
            );
          });
        }
      }
    }
  ],
});
