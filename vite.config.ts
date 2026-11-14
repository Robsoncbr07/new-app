import { defineConfig, type Plugin } from 'vite';
import { cpSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Runtime files of onnxruntime-web/webgpu (the "bundle" build inlines the JS
// glue only partially, so we ship both the .mjs and the .wasm) served from our
// own origin under `ort/`.
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];
const ORT_DIST = resolve('node_modules/onnxruntime-web/dist');

// transformers.js tem um wasmPaths padrão apontando para um CDN (nunca usado, pois só
// usamos o tokenizador); troca por um caminho local para nada externo ficar no bundle.
function scrubCdn(): Plugin {
  return {
    name: 'scrub-cdn',
    transform(code, id) {
      if (!id.includes('@huggingface/transformers')) return null;
      return code.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@\$\{[^}]*\}\/dist\//g, './ort/');
    },
  };
}

function ortRuntime(): Plugin {
  return {
    name: 'ort-runtime-copy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const m = url.match(/\/ort\/([^/]+)$/);
        if (m && ORT_FILES.includes(m[1])) {
          const file = join(ORT_DIST, m[1]);
          res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          res.setHeader('Content-Length', statSync(file).size);
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
    // As cópias de .wasm que o bundler embute em assets/ nunca são usadas (wasmPaths aponta
    // para ort/), então removemos para não publicar ~55 MB mortos.
    generateBundle(_o, bundle) {
      for (const k of Object.keys(bundle)) if (k.endsWith('.wasm')) delete bundle[k];
    },
    closeBundle() {
      const out = resolve('dist/ort');
      mkdirSync(out, { recursive: true });
      for (const f of ORT_FILES) {
        const src = join(ORT_DIST, f);
        if (!existsSync(src)) throw new Error(`Arquivo ORT ausente: ${src}`);
        cpSync(src, join(out, f));
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [ortRuntime(), scrubCdn()],
  worker: { format: 'es', plugins: () => [scrubCdn()] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers'] },
});
