# Stage with CPython 3.13 runtime artifacts
FROM python:3.13-slim-bookworm AS python313

# Use an official Node.js runtime as the base image
FROM node:20

# We don't need the standalone Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true

# Install Chromium and its dependencies
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  chromium \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  libbz2-1.0 \
  libffi8 \
  liblzma5 \
  libreadline8 \
  libsqlite3-0 \
  libssl3 \
  zlib1g \
  lsb-release \
  wget \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Copy Python 3.13 runtime from python image
COPY --from=python313 /usr/local/bin/python3.13 /usr/local/bin/python3.13
COPY --from=python313 /usr/local/lib/python3.13 /usr/local/lib/python3.13
COPY --from=python313 /usr/local/lib/libpython3.13.so* /usr/local/lib/
RUN ln -sf /usr/local/bin/python3.13 /usr/local/bin/python3 \
  && ln -sf /usr/local/bin/python3.13 /usr/local/bin/python \
  && python3.13 -V

# Default Python used by PackageService for python runtime MCP servers
ENV PYTHON_BIN=/usr/local/bin/python3.13

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Create app directory
WORKDIR /app

# Bundle app source
COPY . .

# RUN unzip abis.zip

# Install dependencies & build
RUN yarn && yarn build

# Expose port 8080 & 443
EXPOSE 8080 443

VOLUME [ "/app/packages" ]

# Start Node.js app
CMD ["node", "--experimental-require-module", "dist/index.js"]
