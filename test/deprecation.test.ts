/**
 * requireHandshakeProof устарела в 2.1.0 (удаление в 3.0): опция работает, но при
 * `false` SDK предупреждает. Отдельный файл: флаг «уже предупредили» живёт на уровне
 * модуля, а vitest изолирует модули между файлами.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinterConnectClient } from '../src/index.js';
import { RELAY_URL } from './helpers/connected.js';
import { TEST_CLIENT_CONFIG } from './helpers/wallet.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requireHandshakeProof устарела', () => {
  it('без опции и с true предупреждения нет; false — одно предупреждение на процесс', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG });
    new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG, requireHandshakeProof: true });
    expect(warn).not.toHaveBeenCalled();

    new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG, requireHandshakeProof: false });
    new MinterConnectClient({ relayUrl: RELAY_URL, ...TEST_CLIENT_CONFIG, requireHandshakeProof: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/requireHandshakeProof: false is deprecated since 2\.1\.0.*removed in 3\.0/);
  });
});
