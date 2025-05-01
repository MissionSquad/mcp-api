# Use an official Node.js runtime as the base image
FROM node:20

# We don't need the standalone Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true

# Install Google Chrome Stable and fonts
# Note: this installs the necessary libs to make the browser work with Puppeteer.
RUN apt-get update && apt-get install curl gnupg -y \
  && curl --location --silent https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
  && apt-get update \
  && apt-get install google-chrome-stable -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

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