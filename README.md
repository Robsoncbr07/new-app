# Ateliê Local

App web instalável (PWA) que gera imagens a partir de texto **inteiramente no seu aparelho**, usando WebGPU e o modelo SD-Turbo (1 passo) via ONNX Runtime Web. Nenhum prompt ou imagem sai do celular. Interface em português do Brasil.

## Requisitos do aparelho

- Navegador com WebGPU e suporte a `shader-f16`: **Chrome no Android 12+** ou **Safari no iOS 26+**.
- Em Samsung com Exynos (testado: Galaxy S24 FE, GPU Xclipse 940) o WebGPU só aparece depois de ativar `chrome://flags/#enable-unsafe-webgpu` e reiniciar o Chrome.
- Cerca de **6 GB de RAM ou mais** (use o "Modo econômico de memória" em aparelhos com pouca RAM).
- ~2,4 GB livres para o modelo, baixado uma única vez (use Wi-Fi). Ele fica no armazenamento privado do navegador (OPFS).
- Na primeira geração é preciso internet para buscar o tokenizador (arquivos pequenos, depois ficam em cache).

## Como rodar

```bash
npm install
npm run dev      # servidor de desenvolvimento
npm run build    # verifica tipos (tsc --noEmit) e gera ./dist
npm run preview  # serve ./dist localmente
npm test         # testes unitários (vitest)
```

## Publicar no GitHub Pages e instalar no celular

1. No repositório: **Settings > Pages > Source: GitHub Actions**.
2. Faça push na branch `main` (ou rode o workflow manualmente). O arquivo `.github/workflows/deploy.yml` compila e publica `dist`.
3. Abra a URL do Pages no Chrome (Android) ou Safari (iOS) e use **Instalar app** / **Adicionar à Tela de Início**.
4. Abra o app, toque em **Baixar modelo** e aguarde (mantenha a tela ligada).

O app usa `base: './'`, então funciona em subpasta (`usuario.github.io/repo/`). Os arquivos de runtime do ONNX Runtime são copiados para `ort/` no build e servidos da própria origem; nada é carregado de CDN.

## Modo de teste `?mock=1`

Abra `/?mock=1` para usar um motor falso: o "download" é simulado (~1,5 s) e a imagem é um gradiente procedural com ruído (determinístico pela semente). Serve para testar a interface sem WebGPU nem o modelo. Não é o comportamento padrão.

## Licença do modelo

Os pesos do SD-Turbo são distribuídos pela Stability AI sob licença própria (termos não comerciais/community). Consulte o cartão do modelo no Hugging Face antes de qualquer uso comercial. Os pesos não fazem parte deste repositório; são baixados do Hugging Face (`schmuell/sd-turbo-ort-web`) no aparelho do usuário.
