import debug from 'debug';
import packageJson from '@/package.json';

import DatabaseProvider, { DatabaseError } from '~/ports/database';
import { ChartType, Lang } from '~/ports/types';
import { ROLE } from '~/ports/user/model';

import type { SessionConfig } from 'h3';
import type { System } from '~/ports/system/model';
import type { User } from '~/ports/user/model';
import type { Identity, String } from '~/ports/types';
import {
  hashPasswordWithBcrypt,
  isPasswordStrong,
} from '~/server/utils/password';

const INMDP_DEBUG = debug('InMemoryDP');

// Represent in-memory data structure
type InMemoryData = {
  system?: System;
  users: Array<User>;
};

// In-Memory Database Provider
export default class InMemory extends DatabaseProvider {
  protected data: InMemoryData = { users: [] };

  async connect() {
    INMDP_DEBUG('Connection...');
    const system: System = {
      release: packageJson.release.version,
      interface: {
        privateKey: '',
        publicKey: '',
        address: '10.8.0.1',
      },
      port: 51821,
      webuiHost: '0.0.0.0',
      sessionTimeout: 3600, // 1 hour
      lang: Lang.EN,
      userConfig: {
        mtu: 1420,
        persistentKeepalive: 0,
        rangeAddress: '10.8.0.x',
        defaultDns: ['1.1.1.1'],
        allowedIps: ['0.0.0.0/0', '::/0'],
      },
      wgPath: '/etc/wireguard/',
      wgDevice: 'wg0',
      wgHost: '',
      wgPort: 51820,
      wgConfigPort: 51820,
      iptables: {
        wgPreUp: '',
        wgPostUp: '',
        wgPreDown: '',
        wgPostDown: '',
      },
      trafficStats: {
        enabled: false,
        type: ChartType.None,
      },
      wgEnableExpiresTime: false,
      prometheus: {
        enabled: false,
        password: null,
      },
      sessionConfig: {
        password: '',
        name: 'wg-easy',
        cookie: undefined,
      } satisfies SessionConfig,
    };

    this.data.system = system;
    INMDP_DEBUG('Connection done');
  }

  async disconnect() {
    this.data = { users: [] };
  }

  async getSystem() {
    INMDP_DEBUG('Get System');
    return this.data.system;
  }

  async saveSystem(system: System) {
    INMDP_DEBUG('Save System');
    this.data.system = system;
  }

  async getLang() {
    return this.data.system?.lang || Lang.EN;
  }

  async getUsers() {
    return this.data.users;
  }

  async getUser(id: Identity<User>) {
    INMDP_DEBUG('Get User');
    if (typeof id === 'string' || typeof id === 'number') {
      return this.data.users.find((user) => user.id === id);
    }
    return this.data.users.find((user) => user.id === id.id);
  }

  async newUserWithPassword(username: String, password: String) {
    INMDP_DEBUG('New User');
    if (username.length < 8) {
      throw new DatabaseError(DatabaseError.ERROR_USERNAME_LEN);
    }

    if (!isPasswordStrong(password)) {
      throw new DatabaseError(DatabaseError.ERROR_PASSWORD_REQ);
    }

    const isUserExist = this.data.users.find(
      (user) => user.username === username
    );
    if (isUserExist) {
      throw new DatabaseError(DatabaseError.ERROR_USER_EXIST);
    }

    const now = new Date();
    const isUserEmpty = this.data.users.length == 0;

    const newUser: User = {
      id: `${this.data.users.length + 1}`,
      password: hashPasswordWithBcrypt(password),
      username,
      role: isUserEmpty ? ROLE.ADMIN : ROLE.CLIENT,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    this.data.users.push(newUser);
  }

  async saveUser(user: User) {
    let _user = await this.getUser(user);
    if (_user) {
      INMDP_DEBUG('Update User');
      _user = user;
    }
  }

  async deleteUser(id: Identity<User>) {
    INMDP_DEBUG('Delete User');
    const _id = typeof id === 'string' || typeof id === 'number' ? id : id.id;
    const idx = this.data.users.findIndex((user) => user.id == _id);
    if (idx !== -1) {
      this.data.users.splice(idx, 1);
    }
  }
}
