FROM node:22-alpine

# wget for fetching fresh data on startup
RUN apk add --no-cache wget

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build the frontend
COPY . .
RUN npm run build

# HF Spaces require port 7860
EXPOSE 7860

# On startup:
#   1. Download fresh JSON data from the GitHub repo (catches up since last image build)
#   2. Start the management server (serves static frontend + /api/* routes)
CMD ["sh", "-c", "\
  echo 'Fetching latest data from GitHub...' && \
  wget -q -O data/providers.json \
    https://raw.githubusercontent.com/CrispStrobe/LLMProviders/main/data/providers.json && \
  wget -q -O data/benchmarks.json \
    https://raw.githubusercontent.com/CrispStrobe/LLMProviders/main/data/benchmarks.json && \
  echo 'Starting server...' && \
  node server.js"]
