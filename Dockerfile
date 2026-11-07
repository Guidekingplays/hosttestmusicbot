FROM node:22-slim

# ffmpeg + tools needed to download yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Standalone yt-dlp binary (latest at build time; redeploy to update)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

# Let yt-dlp use Node to solve YouTube's JS challenges
RUN echo "--js-runtimes node" > /etc/yt-dlp.conf

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
