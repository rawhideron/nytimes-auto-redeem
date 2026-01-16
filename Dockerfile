FROM node:18-slim

# Install Chrome dependencies
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    cron \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (Puppeteer will download Chromium automatically)
RUN npm install

# Copy application files
COPY redeem.js ./
COPY crontab /etc/cron.d/nytimes-cron

# Set up cron job
RUN chmod 0644 /etc/cron.d/nytimes-cron && \
    crontab /etc/cron.d/nytimes-cron && \
    touch /var/log/cron.log && \
    mkdir -p /app/cookies

# Start cron and tail logs
CMD cron && tail -f /var/log/cron.log
