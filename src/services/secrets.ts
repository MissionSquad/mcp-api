import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { env } from '../env'
import { log } from '../utils/general'

export interface UserSecret {
  username: string
  key: string
  value: string
}
const userSecretIndexes: IndexDefinition[] = [
  { name: 'username', key: { username: 1 } },
  { name: 'key', key: { key: 1 } },
  { name: 'username_key', key: { username: 1, key: 1 } }
]

export class Secrets {
  private secrets: SecretEncryptor
  private secretsDBClient: MongoDBClient<UserSecret>

  constructor({
    mongoParams
  }: {
    mongoParams: MongoConnectionParams
  }) {
    this.secrets = new SecretEncryptor(env.SECRETS_KEY)
    this.secretsDBClient = new MongoDBClient<UserSecret>(mongoParams, userSecretIndexes)
  }

  public async init() {
    await this.secretsDBClient.connect(env.SECRETS_DBNAME)
  }

  public async getSecrets(username: string) {
    log({ level: 'info', msg: `get secrets for user ${username}` })
    if (this.secretsDBClient == null) {
      throw new Error('secretsDBClient is not initialized')
    }
    const userSecrets = await this.secretsDBClient.find({ username })
    // { 'secretName': 'secretValue' }
    const secrets: Record<string, string> = userSecrets.reduce((acc, secret) => {
      const decryptedSecretValue = this.secrets.decrypt(secret.value)
      acc[secret.key] = decryptedSecretValue
      return acc
    }, {} as Record<string, string>)
    return secrets
  }

  public async updateSecret({
    username,
    secretName,
    secretValue,
    action
  }: {
    username: string
    secretName: string
    secretValue: string
    action: 'save' | 'update' | 'delete'
  }) {
    if (!secretName || !action) {
      return false
    }
    // secretValue is required for save/update but not for delete
    if (action !== 'delete' && !secretValue) {
      return false
    }

    switch (action) {
      case 'delete':
        await this.secretsDBClient.delete({ username, key: secretName })
        break
      case 'save':
      case 'update':
        const encryptedSecretValue = this.secrets.encrypt(secretValue)
        await this.secretsDBClient.upsert({
          username,
          key: secretName,
          value: encryptedSecretValue
        }, {
          username,
          key: secretName
        })
        break
      default:
        return false
    }
    return true
  }
}
