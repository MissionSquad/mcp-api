# Use an official Node.js runtime as the base image
FROM node:20

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