# Transcritor de Áudio

Página web local que transcreve qualquer áudio (inclusive `.opus` do WhatsApp)
usando a API gratuita da Groq (Whisper large-v3).

## Uso

1. Crie `.env` na raiz com `GROQ_API_KEY=sua_chave`.
2. `npm install`
3. `npm start`
4. Abra http://localhost:3000, arraste o áudio, copie ou baixe o texto.

## Limites do plano gratuito da Groq

8 horas de áudio por dia, 25 MB por envio (o app converte para MP3 leve antes
de enviar, então um áudio de 10 min fica em ~5 MB).

## Testes

`npm test`
