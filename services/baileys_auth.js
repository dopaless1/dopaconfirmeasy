'use strict';

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

/**
 * Creates Baileys AuthState backed by Turso SQLite database.
 * @param {Object} db - The database module (e.g. require('../database/db'))
 */
module.exports = async function useTursoAuthState(db) {
  const readData = async (key) => {
    try {
      const data = await db.getWhatsAppAuth(key);
      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }
    } catch (error) {
      console.error('[Baileys Auth] Read Error', error);
    }
    return null;
  };

  const writeData = async (key, data) => {
    try {
      const str = JSON.stringify(data, BufferJSON.replacer);
      await db.setWhatsAppAuth(key, str);
    } catch (error) {
      console.error('[Baileys Auth] Write Error', error);
    }
  };

  const removeData = async (key) => {
    try {
      await db.removeWhatsAppAuth(key);
    } catch (error) {
      console.error('[Baileys Auth] Remove Error', error);
    }
  };

  let creds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData('creds', creds);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(key, value));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => {
      return writeData('creds', creds);
    }
  };
};
