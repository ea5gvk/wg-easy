import fs from 'node:fs/promises';
import path from 'path';
import debug from 'debug';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import CRC32 from 'crc-32';

import type { NewClient } from '~~/services/database/repositories/client';
import { parseCidr } from 'cidr-tools';
import { stringifyIp } from 'ip-bigint';
import { isIPv4 } from 'is-ip';

const DEBUG = debug('WireGuard');

class WireGuard {
  async saveConfig() {
    await this.#saveWireguardConfig();
    await this.#syncWireguardConfig();
  }

  async #saveWireguardConfig() {
    const system = await Database.getSystem();
    const clients = await Database.getClients();
    const result = [];
    result.push(wg.generateServerInterface(system));

    for (const client of Object.values(clients)) {
      if (!client.enabled) {
        continue;
      }
      result.push(wg.generateServerPeer(client));
    }

    DEBUG('Config saving...');
    await fs.writeFile(path.join(WG_PATH, 'wg0.conf'), result.join('\n\n'), {
      mode: 0o600,
    });
    DEBUG('Config saved.');
  }

  async #syncWireguardConfig() {
    DEBUG('Config syncing...');
    await wg.sync();
    DEBUG('Config synced.');
  }

  async getClients() {
    const dbClients = await Database.getClients();
    const clients = Object.entries(dbClients).map(([clientId, client]) => ({
      id: clientId,
      name: client.name,
      enabled: client.enabled,
      address4: client.address4,
      address6: client.address6,
      publicKey: client.publicKey,
      createdAt: new Date(client.createdAt),
      updatedAt: new Date(client.updatedAt),
      expiresAt: client.expiresAt,
      allowedIPs: client.allowedIPs,
      oneTimeLink: client.oneTimeLink,
      downloadableConfig: 'privateKey' in client,
      persistentKeepalive: null as string | null,
      latestHandshakeAt: null as Date | null,
      endpoint: null as string | null,
      transferRx: null as number | null,
      transferTx: null as number | null,
    }));

    // Loop WireGuard status
    const dump = await wg.dump();
    dump.forEach(
      ({
        publicKey,
        latestHandshakeAt,
        endpoint,
        transferRx,
        transferTx,
        persistentKeepalive,
      }) => {
        const client = clients.find((client) => client.publicKey === publicKey);
        if (!client) {
          return;
        }

        client.latestHandshakeAt = latestHandshakeAt;
        client.endpoint = endpoint;
        client.transferRx = transferRx;
        client.transferTx = transferTx;
        client.persistentKeepalive = persistentKeepalive;
      }
    );

    return clients;
  }

  async getClient({ clientId }: { clientId: string }) {
    const client = await Database.getClient(clientId);
    if (!client) {
      throw createError({
        statusCode: 404,
        statusMessage: `Client Not Found: ${clientId}`,
      });
    }

    return client;
  }

  async getClientConfiguration({ clientId }: { clientId: string }) {
    const system = await Database.getSystem();
    const client = await this.getClient({ clientId });

    return wg.generateClientConfig(system, client);
  }

  async getClientQRCodeSVG({ clientId }: { clientId: string }) {
    const config = await this.getClientConfiguration({ clientId });
    return QRCode.toString(config, {
      type: 'svg',
      width: 512,
    });
  }

  async createClient({
    name,
    expireDate,
  }: {
    name: string;
    expireDate: string | null;
  }) {
    const system = await Database.getSystem();
    const clients = await Database.getClients();

    const privateKey = await wg.generatePrivateKey();
    const publicKey = await wg.getPublicKey(privateKey);
    const preSharedKey = await wg.generatePresharedKey();

    // Calculate next IP
    const cidr4 = parseCidr(system.userConfig.address4Range);
    let address4;
    for (let i = cidr4.start + 2n; i <= cidr4.end - 1n; i++) {
      const currentIp4 = stringifyIp({ number: i, version: 4 });
      const client = Object.values(clients).find((client) => {
        return client.address4 === currentIp4;
      });

      if (!client) {
        address4 = currentIp4;
        break;
      }
    }

    if (!address4) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Maximum number of clients reached.',
        data: { cause: 'IPv4 Address Pool exhausted' },
      });
    }

    const cidr6 = parseCidr(system.userConfig.address6Range);
    let address6;
    for (let i = cidr6.start + 2n; i <= cidr6.end - 1n; i++) {
      const currentIp6 = stringifyIp({ number: i, version: 6 });
      const client = Object.values(clients).find((client) => {
        return client.address6 === currentIp6;
      });

      if (!client) {
        address6 = currentIp6;
        break;
      }
    }

    if (!address6) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Maximum number of clients reached.',
        data: { cause: 'IPv6 Address Pool exhausted' },
      });
    }

    // Create Client
    const id = crypto.randomUUID();

    const client: NewClient = {
      id,
      name,
      address4,
      address6,
      privateKey,
      publicKey,
      preSharedKey,
      endpoint: null,
      oneTimeLink: null,
      expiresAt: null,
      enabled: true,
      allowedIPs: system.userConfig.allowedIps,
      serverAllowedIPs: null,
      persistentKeepalive: system.userConfig.persistentKeepalive,
    };

    if (expireDate) {
      const date = new Date(expireDate);
      date.setHours(23);
      date.setMinutes(59);
      date.setSeconds(59);
      client.expiresAt = date.toISOString();
    }

    await Database.createClient(client);

    await this.saveConfig();

    return client;
  }

  async deleteClient({ clientId }: { clientId: string }) {
    await Database.deleteClient(clientId);
    await this.saveConfig();
  }

  async enableClient({ clientId }: { clientId: string }) {
    await Database.toggleClient(clientId, true);

    await this.saveConfig();
  }

  async generateOneTimeLink({ clientId }: { clientId: string }) {
    const key = `${clientId}-${Math.floor(Math.random() * 1000)}`;
    const oneTimeLink = Math.abs(CRC32.str(key)).toString(16);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await Database.createOneTimeLink(clientId, {
      oneTimeLink,
      expiresAt,
    });
    await this.saveConfig();
  }

  async eraseOneTimeLink({ clientId }: { clientId: string }) {
    await Database.deleteOneTimeLink(clientId);
    await this.saveConfig();
  }

  async disableClient({ clientId }: { clientId: string }) {
    await Database.toggleClient(clientId, false);

    await this.saveConfig();
  }

  async updateClientName({
    clientId,
    name,
  }: {
    clientId: string;
    name: string;
  }) {
    await Database.updateClientName(clientId, name);

    await this.saveConfig();
  }

  async updateClientAddress({
    clientId,
    address4,
  }: {
    clientId: string;
    address4: string;
  }) {
    if (!isIPv4(address4)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Invalid Address: ${address4}`,
      });
    }

    await Database.updateClientAddress4(clientId, address4);

    await this.saveConfig();
  }

  async updateClientExpireDate({
    clientId,
    expireDate,
  }: {
    clientId: string;
    expireDate: string | null;
  }) {
    let updatedDate: string | null = null;

    if (expireDate) {
      const date = new Date(expireDate);
      date.setHours(23);
      date.setMinutes(59);
      date.setSeconds(59);
      updatedDate = date.toISOString();
    }

    await Database.updateClientExpirationDate(clientId, updatedDate);

    await this.saveConfig();
  }

  // TODO: reimplement database restore
  async restoreConfiguration(_config: string) {
    /* DEBUG('Starting configuration restore process.');
    // TODO: sanitize config
    const _config = JSON.parse(config);
    await this.__saveConfig(_config);
    await this.__reloadConfig();
    DEBUG('Configuration restore process completed.'); */
  }

  // TODO: reimplement database restore
  async backupConfiguration() {
    /* DEBUG('Starting configuration backup.');
    const config = await this.getConfig();
    const backup = JSON.stringify(config, null, 2);
    DEBUG('Configuration backup completed.');
    return backup; */
  }

  async Startup() {
    // TODO: improve this
    await new Promise((res) => {
      function wait() {
        if (Database.connected) {
          return res(true);
        }
      }
      setTimeout(wait, 1000);
    });
    DEBUG('Starting Wireguard');
    await this.#saveWireguardConfig();
    await wg.down().catch(() => {});
    await wg.up().catch((err) => {
      if (
        err &&
        err.message &&
        err.message.includes('Cannot find device "wg0"')
      ) {
        throw new Error(
          'WireGuard exited with the error: Cannot find device "wg0"\nThis usually means that your host\'s kernel does not support WireGuard!'
        );
      }

      throw err;
    });
    await this.#syncWireguardConfig();
    DEBUG('Wireguard started successfully');

    DEBUG('Starting Cron Job');
    await this.startCronJob();
  }

  async startCronJob() {
    await this.cronJob().catch((err) => {
      DEBUG('Running Cron Job failed.');
      console.error(err);
    });
    setTimeout(() => {
      this.startCronJob();
    }, 60 * 1000);
  }

  // Shutdown wireguard
  async Shutdown() {
    await wg.down().catch(() => {});
  }

  async cronJob() {
    const clients = await Database.getClients();
    const system = await Database.getSystem();
    // Expires Feature
    if (system.clientExpiration.enabled) {
      for (const client of Object.values(clients)) {
        if (client.enabled !== true) continue;
        if (
          client.expiresAt !== null &&
          new Date() > new Date(client.expiresAt)
        ) {
          DEBUG(`Client ${client.id} expired.`);
          await Database.toggleClient(client.id, false);
        }
      }
    }
    // One Time Link Feature
    if (system.oneTimeLinks.enabled) {
      for (const client of Object.values(clients)) {
        if (
          client.oneTimeLink !== null &&
          new Date() > new Date(client.oneTimeLink.expiresAt)
        ) {
          DEBUG(`Client ${client.id} One Time Link expired.`);
          await Database.deleteOneTimeLink(client.id);
        }
      }
    }
  }

  async getMetrics() {
    const clients = await this.getClients();
    let wireguardPeerCount = 0;
    let wireguardEnabledPeersCount = 0;
    let wireguardConnectedPeersCount = 0;
    let wireguardSentBytes = '';
    let wireguardReceivedBytes = '';
    let wireguardLatestHandshakeSeconds = '';
    for (const client of Object.values(clients)) {
      wireguardPeerCount++;
      if (client.enabled === true) {
        wireguardEnabledPeersCount++;
      }
      if (client.endpoint !== null) {
        wireguardConnectedPeersCount++;
      }
      wireguardSentBytes += `wireguard_sent_bytes{interface="wg0",enabled="${client.enabled}",address4="${client.address4}",address6="${client.address6}",name="${client.name}"} ${Number(client.transferTx)}\n`;
      wireguardReceivedBytes += `wireguard_received_bytes{interface="wg0",enabled="${client.enabled}",address4="${client.address4}",address6="${client.address6}",name="${client.name}"} ${Number(client.transferRx)}\n`;
      wireguardLatestHandshakeSeconds += `wireguard_latest_handshake_seconds{interface="wg0",enabled="${client.enabled}",address4="${client.address4}",address6="${client.address6}",name="${client.name}"} ${client.latestHandshakeAt ? (new Date().getTime() - new Date(client.latestHandshakeAt).getTime()) / 1000 : 0}\n`;
    }

    let returnText = '# HELP wg-easy and wireguard metrics\n';

    returnText += '\n# HELP wireguard_configured_peers\n';
    returnText += '# TYPE wireguard_configured_peers gauge\n';
    returnText += `wireguard_configured_peers{interface="wg0"} ${wireguardPeerCount}\n`;

    returnText += '\n# HELP wireguard_enabled_peers\n';
    returnText += '# TYPE wireguard_enabled_peers gauge\n';
    returnText += `wireguard_enabled_peers{interface="wg0"} ${wireguardEnabledPeersCount}\n`;

    returnText += '\n# HELP wireguard_connected_peers\n';
    returnText += '# TYPE wireguard_connected_peers gauge\n';
    returnText += `wireguard_connected_peers{interface="wg0"} ${wireguardConnectedPeersCount}\n`;

    returnText += '\n# HELP wireguard_sent_bytes Bytes sent to the peer\n';
    returnText += '# TYPE wireguard_sent_bytes counter\n';
    returnText += `${wireguardSentBytes}`;

    returnText +=
      '\n# HELP wireguard_received_bytes Bytes received from the peer\n';
    returnText += '# TYPE wireguard_received_bytes counter\n';
    returnText += `${wireguardReceivedBytes}`;

    returnText +=
      '\n# HELP wireguard_latest_handshake_seconds UNIX timestamp seconds of the last handshake\n';
    returnText += '# TYPE wireguard_latest_handshake_seconds gauge\n';
    returnText += `${wireguardLatestHandshakeSeconds}`;

    return returnText;
  }

  async getMetricsJSON() {
    const clients = await this.getClients();
    let wireguardPeerCount = 0;
    let wireguardEnabledPeersCount = 0;
    let wireguardConnectedPeersCount = 0;
    for (const client of Object.values(clients)) {
      wireguardPeerCount++;
      if (client.enabled === true) {
        wireguardEnabledPeersCount++;
      }
      if (client.endpoint !== null) {
        wireguardConnectedPeersCount++;
      }
    }
    return {
      wireguard_configured_peers: wireguardPeerCount,
      wireguard_enabled_peers: wireguardEnabledPeersCount,
      wireguard_connected_peers: wireguardConnectedPeersCount,
    };
  }
}

const inst = new WireGuard();
inst.Startup().catch((v) => {
  console.error(v);
  process.exit(1);
});

export default inst;
