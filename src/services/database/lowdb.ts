import crypto from 'node:crypto';
import debug from 'debug';

import {
  DatabaseProvider,
  DatabaseError,
  DEFAULT_DATABASE,
} from './repositories/database';
import { JSONFilePreset } from 'lowdb/node';

import type { Low } from 'lowdb';
import { UserRepository, type User } from './repositories/user';
import type { Database } from './repositories/database';
import { migrationRunner } from './migrations';
import {
  ClientRepository,
  type Client,
  type NewClient,
  type OneTimeLink,
} from './repositories/client';
import { SystemRepository } from './repositories/system';

const DEBUG = debug('LowDB');

export class LowDBSystem extends SystemRepository {
  #db: Low<Database>;
  constructor(db: Low<Database>) {
    super();
    this.#db = db;
  }
  async get() {
    DEBUG('Get System');
    const system = this.#db.data.system;
    // system is only null if migration failed
    if (system === null) {
      throw new DatabaseError(DatabaseError.ERROR_INIT);
    }
    return system;
  }
}

export class LowDBUser extends UserRepository {
  #db: Low<Database>;
  constructor(db: Low<Database>) {
    super();
    this.#db = db;
  }
  // TODO: return copy to avoid mutation (everywhere)
  async findAll() {
    return this.#db.data.users;
  }

  async findById(id: string) {
    DEBUG('Get User');
    return this.#db.data.users.find((user) => user.id === id);
  }

  async create(username: string, password: string) {
    DEBUG('Create User');

    const isUserExist = this.#db.data.users.find(
      (user) => user.username === username
    );
    if (isUserExist) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Username already taken',
      });
    }

    const now = new Date().toISOString();
    const isUserEmpty = this.#db.data.users.length === 0;

    const hash = await hashPassword(password);

    const newUser: User = {
      id: crypto.randomUUID(),
      password: hash,
      username,
      name: 'Administrator',
      role: isUserEmpty ? 'ADMIN' : 'CLIENT',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.#db.update((data) => data.users.push(newUser));
  }

  async update(user: User) {
    // TODO: avoid mutation, prefer .update, updatedAt
    let oldUser = await this.findById(user.id);
    if (oldUser) {
      DEBUG('Update User');
      oldUser = user;
      await this.#db.write();
    }
  }

  async delete(id: string) {
    DEBUG('Delete User');
    const idx = this.#db.data.users.findIndex((user) => user.id === id);
    if (idx !== -1) {
      await this.#db.update((data) => data.users.splice(idx, 1));
    }
  }
}

export class LowDBClient extends ClientRepository {
  #db: Low<Database>;
  constructor(db: Low<Database>) {
    super();
    this.#db = db;
  }
  async findAll() {
    DEBUG('GET Clients');
    return this.#db.data.clients;
  }

  async findById(id: string) {
    DEBUG('Get Client');
    return this.#db.data.clients[id];
  }

  async create(client: NewClient) {
    DEBUG('Create Client');
    const now = new Date().toISOString();
    const newClient: Client = { ...client, createdAt: now, updatedAt: now };
    await this.#db.update((data) => {
      data.clients[client.id] = newClient;
    });
  }

  async delete(id: string) {
    DEBUG('Delete Client');
    await this.#db.update((data) => {
      // TODO: find something better than delete
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete data.clients[id];
    });
  }

  async toggle(id: string, enable: boolean) {
    DEBUG('Toggle Client');
    await this.#db.update((data) => {
      if (data.clients[id]) {
        data.clients[id].enabled = enable;
      }
    });
  }

  async updateName(id: string, name: string) {
    DEBUG('Update Client Name');
    await this.#db.update((data) => {
      if (data.clients[id]) {
        data.clients[id].name = name;
      }
    });
  }

  async updateAddress4(id: string, address4: string) {
    DEBUG('Update Client Address4');
    await this.#db.update((data) => {
      if (data.clients[id]) {
        data.clients[id].address4 = address4;
      }
    });
  }

  async updateExpirationDate(id: string, expirationDate: string | null) {
    DEBUG('Update Client Expiration Date');
    await this.#db.update((data) => {
      if (data.clients[id]) {
        data.clients[id].expiresAt = expirationDate;
      }
    });
  }

  async deleteOneTimeLink(id: string) {
    DEBUG('Delete Client One Time Link');
    await this.#db.update((data) => {
      if (data.clients[id]) {
        if (data.clients[id].oneTimeLink) {
          // Bug where Client makes 2 requests
          data.clients[id].oneTimeLink.expiresAt = new Date(
            Date.now() + 10 * 1000
          ).toISOString();
        }
      }
    });
  }

  async createOneTimeLink(id: string, oneTimeLink: OneTimeLink) {
    DEBUG('Create Client One Time Link');
    await this.#db.update((data) => {
      if (data.clients[id]) {
        data.clients[id].oneTimeLink = oneTimeLink;
      }
    });
  }
}

export default class LowDB extends DatabaseProvider {
  #db!: Low<Database>;
  #connected = false;

  system = new LowDBSystem(this.#db);
  user = new LowDBUser(this.#db);
  client = new LowDBClient(this.#db);

  private async __init() {
    const dbFilePath = '/etc/wireguard/db.json';
    this.#db = await JSONFilePreset(dbFilePath, DEFAULT_DATABASE);
  }

  /**
   * @throws
   */
  async connect() {
    if (this.#connected) {
      return;
    }
    try {
      await this.__init();
      DEBUG('Running Migrations');
      await migrationRunner(this.#db);
      DEBUG('Migrations ran successfully');
    } catch (e) {
      DEBUG(e);
      throw new Error('Failed to initialize Database');
    }
    this.#connected = true;
    DEBUG('Connected successfully');
  }

  get connected() {
    return this.#connected;
  }

  async disconnect() {
    this.#connected = false;
    DEBUG('Disconnected successfully');
  }
}
