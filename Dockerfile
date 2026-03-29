FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir yt-dlp

COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]