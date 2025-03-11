import dotenv from 'dotenv'

dotenv.config()

export const env = {
  DEBUG: /true/i.test(process.env.DEBUG || 'false'),
  PORT: process.env.PORT || 8080,
  MONGO_USER: process.env.MONGO_USER || 'root',
  MONGO_PASS: process.env.MONGO_PASS || 'example',
  MONGO_HOST: process.env.MONGO_HOST || 'localhost:27017',
  MONGO_DBNAME: process.env.MONGO_DBNAME || 'squad-test',
  PAYLOAD_LIMIT: process.env.PAYLOAD_LIMIT || '6mb',
  SECRETS_KEY: process.env.SECRETS_KEY || 'secret',
  SECRETS_DBNAME: process.env.SECRETS_DBNAME || 'secrets',
}