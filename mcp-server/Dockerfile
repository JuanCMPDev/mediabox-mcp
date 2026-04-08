FROM node:20-slim

# System dependencies (static binaries for ffmpeg/unrar to keep image lean)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    aria2 \
    curl \
    unzip \
    p7zip \
    xz-utils \
    && pip3 install --break-system-packages yt-dlp gdown \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# unrar from RARLAB (supports encrypted archives)
RUN curl -L https://www.rarlab.com/rar/rarlinux-x64-721b1.tar.gz -o /tmp/rar.tar.gz \
    && tar -xzf /tmp/rar.tar.gz -C /tmp \
    && cp /tmp/rar/unrar /usr/local/bin/ \
    && chmod +x /usr/local/bin/unrar \
    && rm -rf /tmp/rar*

# ffmpeg/ffprobe static binaries
RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    -o /tmp/ffmpeg.tar.xz \
    && tar -xf /tmp/ffmpeg.tar.xz -C /tmp \
    && cp /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ \
    && cp /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ \
    && rm -rf /tmp/ffmpeg*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
