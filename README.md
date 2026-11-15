# Ateliê Local

App web instalável (PWA) que gera imagens a partir de texto **inteiramente no seu aparelho**, usando WebGPU e modelos de difusão de 1 passo via ONNX Runtime Web: **Leve** (SDXS-512 DreamShaper, padrão, recomendado para celulares) ou **SD-Turbo** (mais detalhe, bem mais pesado). Nenhum prompt ou imagem sai do celular. Interface em português do Brasil.

## Requisitos do aparelho

- Navegador com WebGPU e suporte a `shader-f16`: **Chrome no Android 12+** ou **Safari no iOS 26+**.
- Em Samsung com Exynos (testado: Galaxy S24 FE, GPU Xclipse 940) o WebGPU só aparece depois de ativar `chrome://flags/#enable-unsafe-webgpu` e reiniciar o Chrome.
- Cerca de **6 GB de RAM ou mais** (use o "Modo econômico de memória" em aparelhos com pouca RAM).
- Espaço livre para o modelo escolhido, baixado uma única vez (use Wi-Fi): **Leve ~0,94 GB** ou **SD-Turbo ~2,51 GB** (decimal). Os arquivos ficam no armazenamento privado do navegador (OPFS). Os dois modelos podem coexistir; baixar, continuar e remover agem sobre o modelo selecionado.
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

Abra `/?mock=1` para usar um motor falso: o "download" de cada modelo é simulado (~1,5 s) e a imagem é um gradiente procedural com ruído (determinístico pela semente). Serve para testar a interface sem WebGPU nem o modelo. Não é o comportamento padrão.

## Modelos e licenças

| Modelo | Origem dos arquivos | Tamanho | Licença |
| --- | --- | --- | --- |
| Leve (`sdxs`, padrão) | `blinkfy/CVClass-SDXS-ONNX` (conversão ONNX fp16 de `IDKiro/sdxs-512-dreamshaper`) | 246.280.550 + 689.988.794 + 2.468.157 bytes (~0,94 GB) | OpenRAIL++ |
| SD-Turbo (`sd-turbo`) | `schmuell/sd-turbo-ort-web` | 681.393.168 + 1.733.430.199 + 99.094.314 bytes (~2,51 GB) | Stability AI: uso não comercial / termos da comunidade; consulte o cartão do modelo antes de qualquer uso comercial |

Os pesos não fazem parte deste repositório; são baixados do Hugging Face no aparelho do usuário. Um arquivo só conta como baixado se tiver exatamente o tamanho da tabela. No OPFS, o SD-Turbo mantém os nomes antigos na raiz de `atelie-modelos/` e o Leve fica em `atelie-modelos/sdxs/`.

Os dois modelos usam a mesma matemática de 1 passo (sigma 14,6146, entrada dividida por raiz de sigma²+1, x0 = latentes − sigma·ε). Diferenças: o SD-Turbo divide x0 por 0,18215 antes do VAE e preenche o prompt com o id 0; o Leve não divide (TAESD, escala 1) e preenche com o id 49407. O tokenizador (`Xenova/clip-vit-base-patch16`) é buscado da internet na primeira geração.
