/** Browser demo settings. VITE_* values are public after bundling. */
export function networkConfig(env = {}) {
  const split = value => (value ?? '').split(',').map(url => url.trim()).filter(Boolean);
  const relayUrl = env.VITE_RELAY_URL?.trim();
  const urls = split(env.VITE_TURN_URLS);
  const username = env.VITE_TURN_USERNAME ?? '';
  const credential = env.VITE_TURN_CREDENTIAL ?? '';
  const policy = env.VITE_ICE_TRANSPORT_POLICY || 'all';
  if (!['all', 'relay'].includes(policy)) throw new Error('VITE_ICE_TRANSPORT_POLICY 必须为 all 或 relay');
  if (urls.some(url => !/^turns?:\S+$/i.test(url))) throw new Error('VITE_TURN_URLS 必须使用 TURN 服务商提供的 turn: 或 turns: 地址');
  if (urls.length && (!username || !credential)) throw new Error('请同时设置 VITE_TURN_USERNAME 和 VITE_TURN_CREDENTIAL');
  if (!urls.length && (username || credential)) throw new Error('设置 TURN 凭据时也需要设置 VITE_TURN_URLS');
  const options = {};
  if (relayUrl) options.relayConfig = { urls: [relayUrl], redundancy: 1 };
  if (urls.length) options.turnConfig = [{ urls, username, credential }];
  if (policy === 'relay') options.rtcConfig = { iceTransportPolicy: 'relay' };
  // Test fixture only: disable external STUN without dropping configured TURN servers.
  if (env.VITE_TEST_LOCAL_ICE === true || env.VITE_TEST_LOCAL_ICE === 'true') {
    options.rtcConfig = { ...options.rtcConfig, iceServers: options.turnConfig ?? [] };
  }
  return { relayUrl, options };
}

export function networkErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/after exchanging SDP/i.test(message)) {
    return '已交换连接信息，但 ICE 未建立连接。请展开“连接诊断”，对比成功与失败设备的候选和路径；配置了 TURN 不代表已获得可用的中继候选。';
  }
  if (/host-admission-timeout/i.test(message)) return '加入超时：已与主机建立数据连接，但未收到有效的游戏准入。请确认主机页面仍在前台运行，并检查双方游戏版本和主机控制台错误。';
  if (/host-not-connected/i.test(message)) return '加入超时：尚未与主机建立数据连接。请确认主机房间仍有效；即使同一 Wi-Fi，也需要双方能访问信令服务。请保留此前控制台中的信令或 ICE 报错。';
  if (/Join timed out/i.test(message)) return '加入超时：主机可能不可达或网络连接受限。跨网络连接失败时请检查信令、STUN 与 TURN 配置。';
  return message;
}

/** Diagnostic modes keep the same room/signaling protocol on both ends. */
export function connectionModeOptions(options, mode) {
  if (!['auto', 'lan', 'relay'].includes(mode)) throw new Error('Unknown connection mode');
  return {
    ...options,
    ...(mode === 'lan' ? { turnConfig: [] } : {}),
    rtcConfig: {
      ...options.rtcConfig,
      iceTransportPolicy: mode === 'relay' ? 'relay' : 'all',
      ...(mode === 'lan' ? { iceServers: [] } : {}),
    },
  };
}
