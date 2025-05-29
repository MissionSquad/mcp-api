# Use an official Node.js runtime as the base image
FROM node:20

# We don't need the standalone Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true

# Install Chromium
RUN apt-get update \
  && apt-get install chromium -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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
