FROM node:20-slim

# Install ffmpeg and ca-certificates (required for audio processing and album artwork)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package definitions
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Build TypeScript to dist/
RUN npm run build

# Start the bot
CMD ["npm", "start"]
