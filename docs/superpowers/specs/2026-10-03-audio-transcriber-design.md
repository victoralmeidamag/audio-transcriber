# Audio Transcriber — Design

Data: 2026-10-03

## Objetivo

Página web local, de uso pessoal, que recebe um arquivo de áudio em qualquer
formato (incluindo `.opus` do WhatsApp, `.caf`, `.amr`, `.3gp`, etc.) e devolve
a transcrição em texto usando a API gratuita da Groq (Whisper large-v3).

## Restrições e contexto

- Um único usuário, rodando em `localhost`. Sem autenticação, sem banco.
- Áudios curtos: até 10 minutos.
- Custo zero: plano gratuito da Groq (8 h de áudio/dia, 25 MB por envio).
- Nenhuma instalação no sistema além de Node 20 (já presente). O ffmpeg vem
  embutido via pacote npm `ffmpeg-static`.
- A chave `GROQ_API_KEY` fica no `.env` na raiz e só é lida pelo servidor.
- OpenRouter **não** é usada.

## Arquitetura

```
navegador  --multipart/form-data-->  POST /transcribe  (Express)
                                        |  1. salva upload em tmp
                                        |  2. ffmpeg -> mp3 mono 16 kHz
                                        |  3. POST api.groq.com/openai/v1/audio/transcriptions
                                        |  4. apaga arquivos tmp
           <----- { text } -----------  |
```

### Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `server.js` | Sobe o Express na porta 3000, serve `public/`, expõe `POST /transcribe`. |
| `src/convert.js` | `convertToMp3(inputPath) -> outputPath`. Roda `ffmpeg-static` com `-ac 1 -ar 16000 -b:a 64k`. Lança erro legível se o ffmpeg falhar. |
| `src/transcribe.js` | `transcribe(mp3Path, { apiKey, fetch }) -> string`. Monta o `FormData`, chama a Groq com `model=whisper-large-v3`, `response_format=json`. Traduz erros HTTP (401, 413, 429, 5xx) em mensagens em português. |
| `public/index.html` | Página única: área de arrastar/escolher arquivo, status, texto resultante, botões Copiar e Baixar .txt. CSS e JS inline. |
| `test/*.test.js` | Testes com `node:test`. |
| `.env` | `GROQ_API_KEY=...` (já existe; não versionar). |
| `.gitignore` | `node_modules/`, `.env`, `tmp/`. |

### Dependências npm

`express`, `multer` (upload), `ffmpeg-static`, `dotenv`. `fetch` e `FormData`
nativos do Node 20. Dev: nenhuma (usa `node:test`).

## Fluxo detalhado

1. Usuário solta ou escolhe um arquivo. O front aceita qualquer extensão
   (`accept="audio/*,.opus,.caf,.amr,.3gp,.wma,.aac,.ogg,.m4a,.mp3,.wav,.webm,.mp4"`).
2. Front envia `POST /transcribe` com campo `audio`. Mostra "Transcrevendo...".
3. Servidor (multer) salva em `tmp/<uuid>.<ext>`. Limite de upload: 200 MB.
4. `convertToMp3` gera `tmp/<uuid>.mp3`. Se o resultado passar de 25 MB,
   responde 413 com mensagem ("Áudio muito longo para o plano gratuito").
5. `transcribe` envia o mp3 à Groq, com `language` opcional (não enviado por
   padrão; detecção automática).
6. Servidor responde `{ text }` e apaga os dois arquivos em `finally`.
7. Front exibe o texto, habilita Copiar (clipboard) e Baixar (`<a download>`
   com Blob `.txt`, nome igual ao do áudio).

## Tratamento de erros (mensagem exibida na tela)

| Situação | HTTP | Mensagem |
|---|---|---|
| Nenhum arquivo enviado | 400 | "Escolha um arquivo de áudio." |
| ffmpeg não reconhece o arquivo | 422 | "Não consegui ler esse arquivo como áudio." |
| MP3 convertido > 25 MB | 413 | "Áudio muito longo para o plano gratuito da Groq." |
| `GROQ_API_KEY` ausente | 500 | "GROQ_API_KEY não encontrada no .env." (também loga no boot) |
| Groq 401 | 502 | "Chave da Groq inválida." |
| Groq 429 | 502 | "Limite da Groq atingido. Tente mais tarde." |
| Groq outro erro / rede | 502 | "Erro ao falar com a Groq: <detalhe>." |

## Testes

- `test/convert.test.js`: gera um WAV sintético de 1 s com ffmpeg, converte e
  verifica que o MP3 existe e é menor que o WAV; arquivo de texto renomeado
  para `.opus` deve lançar erro legível.
- `test/transcribe.test.js`: injeta `fetch` falso; verifica URL, header
  `Authorization`, campo `model`, retorno de `text`; mapeamento de 401/429/500.
- `test/server.test.js`: sobe o app com `transcribe` substituído por stub,
  envia multipart e confere `{ text }`, 400 sem arquivo, e que `tmp/` fica vazio.
- Teste manual final: `npm start`, abrir `http://localhost:3000`, enviar um
  `.opus` real do WhatsApp.

## Fora de escopo

Fallback para OpenRouter, resumo por LLM, histórico, múltiplos arquivos,
divisão de áudios longos, diarização, autenticação.
