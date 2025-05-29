import {
  BulkWriteResult,
  Collection,
  Db,
  DeleteResult,
  Document,
  Filter,
  IndexDescription,
  InsertManyResult,
  InsertOneResult,
  MongoClientOptions,
  OptionalUnlessRequiredId,
  ReadPreference,
  Sort,
  UpdateResult,
  WithId
} from 'mongodb'
import { MongoClient } from 'mongodb'
import { log } from './general'

export const objectMapString = (input: { [key: string]: any }) =>
  Object.entries(input)
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce((acc, [k, v]) => `${acc}${k}${v}`, '')

export interface IndexDefinition extends Omit<IndexDescription, 'name'> {
  name: string
}

export interface MongoConnectionParams {
  host: string
  db: string
  user: string
  pass: string
  authDB?: string
  replicaSet?: string
}

export class MongoDBClient<T extends Document> {
  private url: string
  private dbName: string
  private collectionName!: string
  private client: MongoClient
  private db!: Db
  private collection!: Collection<T>
  private indexes: IndexDefinition[]

  constructor(
    {
      host,
      db,
      user,
      pass,
      authDB,
      replicaSet
    }: MongoConnectionParams,
    indexes: IndexDefinition[] = []
  ) {
    this.url = host.includes('://') ? host : `mongodb://${host}`
    this.dbName = db
    const options: MongoClientOptions = {
      auth: {
        username: user,
        password: pass,
      }
    }
    if (authDB) {
      options.authSource = authDB
    }
    if (replicaSet) {
      options.replicaSet = replicaSet
      options.readPreference = ReadPreference.PRIMARY_PREFERRED
      options.writeConcern = { w: 'majority' }
      options.retryWrites = true
    }
    this.client = new MongoClient(this.url, options)
    this.indexes = indexes
  }

  /**
   * Connects to MongoDB and selects a collection for data operations.
   *
   * @description Establishes a connection to the MongoDB database, selects the specified database,
   * and selects the given collection for performing CRUD operations. Logs an error if connecting
   * fails.
   *
   * @param {string} collectionName - The name of the collection to select.
   *
   * @returns {Promise<void>} A promise that resolves when the connection is established and the
   * collection is selected, or rejects with an error if connecting fails.
   */
  async connect(collectionName: string): Promise<void> {
    this.collectionName = collectionName
    log({ level: 'debug', msg: `Connecting to MongoDB collection: ${collectionName}...` })
    await this.client.connect().catch((error) => log({ level: 'error', msg: 'Failed to connect to MongoDB', error }))
    this.db = this.client.db(this.dbName)
    const collections = await this.db.listCollections().toArray()
    const collectionNames = collections.map(({ name }) => name)
    if (!collectionNames.includes(collectionName)) {
      this.collection = await this.db.createCollection<T>(collectionName)
      log({ level: 'info', msg: `Created collection: ${collectionName}` })
    } else {
      this.collection = this.db.collection<T>(collectionName)
    }
    const indexes = await this.collection.indexes()
    const indexMaps = indexes.map(({ key }) => objectMapString(key))
    for (const { name, key } of this.indexes) {
      const indexMap = objectMapString(key)
      if (!indexMaps.includes(indexMap)) {
        await this.collection.createIndexes([{ name, key }])
        log({ level: 'info', msg: `Created index ${name}` })
      }
    }
    log({ level: 'info', msg: `Connected to MongoDB collection: ${collectionName} at ${this.url}` })
  }

  /**
   * Inserts one or multiple documents into the MongoDB collection associated with this instance.
   *
   * @description If an array of items is passed, inserts many documents. Otherwise, inserts a single document.
   *
   * @param {Array<OptionalUnlessRequiredId<T>> | OptionalUnlessRequiredId<T>} items - The item(s) to insert. Can be an array or a single object.
   * @returns {Promise<InsertOneResult<T> | InsertManyResult<T>>} A promise that resolves with the result of the insertion operation(s).
   */
  async insert(
    items: Array<OptionalUnlessRequiredId<T>> | OptionalUnlessRequiredId<T>
  ): Promise<InsertOneResult<T> | InsertManyResult<T>> {
    if (Array.isArray(items)) {
      return this.collection.insertMany(items)
    } else {
      return this.collection.insertOne(items)
    }
  }

  /**
   * Updates an item in the collection based on a filter.
   *
   * @description Updates the first document that matches the provided filter with the given item. The item should contain only the fields to be updated, and the filter should match the criteria for selecting the document(s) to update.

  * @param {Partial<T> | T} item - The item containing the updates to apply. If a field is not present in the item, it will remain unchanged.
  * @param {Filter<T>} filter - The filter used to select the document(s) to update. Only the first matching document will be updated.
  *
  * @returns {Promise<UpdateResult<T>>} A promise that resolves to an object containing information about the update operation, including the number of documents matched and modified.
  */
  async update(item: Partial<T> | T, filter: Filter<T>): Promise<UpdateResult<T>> {
    return this.collection.updateOne(filter, { $set: item })
  }

  /** 
   * Upsert single item in the collection based on provided filter.
   * 
   * @param {Partial<T> | T} item - The item containing the updates to apply. If a field is not present in the item, it will remain unchanged.
   * @param {Filter<T>} filter - The filter used to select the document(s) to update. Only the first matching document will be updated.
   * 
   * @returns {Promise<UpdateResult<T>>} A promise that resolves to an object containing information about the update operation, including the number of documents matched and modified.
   */
  async upsert(item: Partial<T> | T, filter: Filter<T>): Promise<UpdateResult<T>> {
    return this.collection.updateOne(filter, { $set: item }, { upsert: true })
  }

  /**
   * Upserts multiple items in the collection based on provided filters.
   *
   * @description Performs a bulk write operation to upsert (update or insert) multiple items in the MongoDB collection. Each item is matched with its corresponding filter and updated or inserted accordingly.
   *
   * @param {Array<{ item: Partial<T> | T; filter: Filter<T> }>} items - An array of objects, where each object contains an 'item' (the data to update or insert) and a 'filter' (the query to match the document).
   *
   * @returns {Promise<BulkWriteResult>} A promise that resolves with the result of the bulk write operation.
   */
  async upsertBulk(items: Array<{ item: Partial<T> | T; filter: Filter<T> }>): Promise<BulkWriteResult> {
    const start = Date.now()
    const result = await this.collection.bulkWrite(
      items.map(({ item, filter }) => ({ updateOne: { filter, update: { $set: item }, upsert: true } }))
    )
    // log({ level: 'info', msg: `[${this.collection.collectionName}] saved ${items.length} items in ${((Date.now() - start)/1000).toFixed(2)} seconds.`})
    return result
  }

  /**
   * Retrieves documents from the MongoDB collection based on a filter.
   *
   * @description Finds documents in the collection matching the provided filter and returns them as an array.
   *
   * @param {Filter<T>} filter - The filter object to match against the collection's documents. If no filter is provided, all documents will be returned.
   *
   * @returns {Promise<Array<T>>} A promise that resolves with an array of documents matching the filter. If no documents match the filter, an empty array is returned.
   */
  async find(filter: Filter<T>, sort?: Sort, limit?: number): Promise<Array<WithId<T>>> {
    return this.collection.find(filter, { sort, limit }).toArray()
  }

  /**
   * Retrieves a single document from the MongoDB collection based on a filter.
   *
   * @description Finds a single document in the collection matching the provided filter and returns it.
   *
   * @param {Filter<T>} filter - The filter object to match against the collection's documents.
   * @param {Sort} [sort] - Optional sorting criteria for the query.
   */
  async findOne(filter: Filter<T>, sort?: Sort): Promise<T | null> {
    const result = await this.collection.findOne(filter, { sort })
    if (result != null) {
      const { _id, ...item } = result as any // typescript doesn't like this as WithId<T>
      return item as T
    } else {
      return null
    }
  }

  /**
   * Deletes documents from the MongoDB collection based on a filter.
   *
   * @description Deletes documents in the collection that match the provided filter.
   *
   * @param {Filter<T>} filter - The filter object to match against the collection's documents.
   *
   * @returns {Promise<DeleteResult>} A promise that resolves with the result of the delete operation.
   */
  async delete (filter: Filter<T>, many: boolean = true): Promise<DeleteResult> {
    if (many) {
      return this.collection.deleteMany(filter)
    } else {
      return this.collection.deleteOne(filter)
    }
  }

  async disconnect(): Promise<void> {
    await this.client.close()
    log({ level: 'info', msg: `Disconnected from ${this.dbName} : ${this.collectionName}` })
  }
}