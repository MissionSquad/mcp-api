import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { env } from '../env'
import { log } from '../utils/general'
import type { SaveUserServerSecretsInput } from './mcp'

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

  public async saveUserServerSecrets(input: SaveUserServerSecretsInput): Promise<void> {
    for (const secret of input.secrets) {
      const encryptedSecretValue = this.secrets.encrypt(secret.value)
      await this.secretsDBClient.upsert(
        {
          username: input.username,
          key: `${input.serverName}.${secret.name}`,
          value: encryptedSecretValue
        },
        {
          username: input.username,
          key: `${input.serverName}.${secret.name}`
        }
      )
    }
  }

  public async deleteSecretsByServerPrefix(serverName: string, username: string): Promise<void> {
    await this.secretsDBClient.delete({
      username,
      key: { $regex: `^${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` }
    } as any)
  }

  public async listSecretNamesByServerPrefix(serverName: string, username: string): Promise<string[]> {
    const records = await this.secretsDBClient.find({
      username,
      key: { $regex: `^${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` }
    } as any)

    return records.map((record) => record.key.slice(serverName.length + 1))
  }

  public async getUserServerSecrets(serverName: string, username: string): Promise<Record<string, string>> {
    const records = await this.secretsDBClient.find({
      username,
      key: { $regex: `^${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` }
    } as any)

    return records.reduce((acc, record) => {
      const secretName = record.key.slice(serverName.length + 1)
      if (!secretName) {
        return acc
      }
      acc[secretName] = this.secrets.decrypt(record.value)
      return acc
    }, {} as Record<string, string>)
  }

  public async listUsernamesByServerPrefix(serverName: string): Promise<string[]> {
    const records = await this.secretsDBClient.find({
      key: { $regex: `^${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` }
    } as any)

    return Array.from(new Set(records.map((record) => record.username).filter(Boolean)))
  }
}
