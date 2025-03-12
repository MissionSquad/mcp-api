# Use an official Node.js runtime as the base image
FROM node:20

# Create app directory
WORKDIR /app

# Bundle app source
COPY . .

# RUN unzip abis.zip

# Install dependencies & build
RUN yarn && yarn build

RUN rm -f .npmrc

# Expose port 8080 & 443
EXPOSE 8080 443




# Start Node.js app
CMD ["node", "--experimental-require-module", "dist/index.js"]