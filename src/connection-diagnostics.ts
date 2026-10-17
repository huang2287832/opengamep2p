/** Candidate counts only: reports never contain IP addresses, SDP or credentials. */
export interface CandidateSummary {
  host: number; srflx: number; prflx: number; relay: number; mdns: number;
}
export interface PeerConnectionDiagnostic {
  id: number;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  remoteDescription: boolean;
  local: CandidateSummary;
  remote: CandidateSummary;
  path?: 'host-direct' | 'nat-direct' | 'relay';
  localType?: string;
  remoteType?: string;
  protocol?: string;
  roundTripTimeMs?: number;
}
export interface ConnectionDiagnostic {
  connections: PeerConnectionDiagnostic[];
}

export function summarizeCandidates(sdp = ''): CandidateSummary {
  const result: CandidateSummary = { host: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 };
  for (const line of new Set(sdp.split(/\r?\n/).filter(line => /^a=candidate:/.test(line)))) {
    const fields = line.split(/\s+/);
    const type = fields[fields.indexOf('typ') + 1];
    if (type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay') result[type]++;
    if (type === 'host' && fields[4]?.endsWith('.local')) result.mdns++;
  }
  return result;
}

export function selectedPath(stats: RTCStatsReport): Partial<PeerConnectionDiagnostic> {
  const records = new Map<string, RTCStats & { candidateType?: string; protocol?: string }>();
  stats.forEach(stat => records.set(stat.id, stat));
  let pair: RTCStats | undefined;
  stats.forEach(stat => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = records.get(stat.selectedCandidatePairId);
  });
  if (!pair) stats.forEach(stat => {
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) pair = stat;
  });
  const selected = pair as RTCIceCandidatePairStats | undefined;
  if (!selected) return {};
  const local = records.get(selected.localCandidateId);
  const remote = records.get(selected.remoteCandidateId);
  if (!local?.candidateType || !remote?.candidateType) return {};
  return {
    path: local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay'
      : local.candidateType === 'host' && remote.candidateType === 'host' ? 'host-direct' : 'nat-direct',
    localType: local.candidateType, remoteType: remote.candidateType, protocol: local.protocol,
    ...(typeof selected.currentRoundTripTime === 'number' ? { roundTripTimeMs: Math.round(selected.currentRoundTripTime * 1000) } : {}),
  };
}

/** Observe the actual PCs supplied to Trystero, including failed negotiations.
 * No global monkey patch, candidate rewriting, or changes to ICE selection.
 */
export function createConnectionDiagnostics(onDiagnostic: (report: ConnectionDiagnostic) => void,
  getConnectedPeers: () => RTCPeerConnection[] = () => []) {
  let nextId = 0, stopped = false, sampling = false;
  const connections = new Map<RTCPeerConnection, PeerConnectionDiagnostic>();
  const cleanups = new Map<RTCPeerConnection, () => void>();
  const NativePeerConnection = globalThis.RTCPeerConnection;
  function refresh(pc: RTCPeerConnection): PeerConnectionDiagnostic {
    const previous = connections.get(pc)!;
    const snapshot: PeerConnectionDiagnostic = pc.connectionState === 'closed'
      ? { ...previous, connectionState: 'closed', iceConnectionState: pc.iceConnectionState }
      : {
        id: previous.id, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState, remoteDescription: !!pc.remoteDescription,
        local: summarizeCandidates(pc.localDescription?.sdp), remote: summarizeCandidates(pc.remoteDescription?.sdp),
      };
    connections.set(pc, snapshot);
    return snapshot;
  }
  function observe(pc: RTCPeerConnection): void {
    if (stopped || connections.has(pc)) return;
    connections.set(pc, {
      id: ++nextId, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState, remoteDescription: false,
      local: summarizeCandidates(), remote: summarizeCandidates(),
    });
    const events = ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange', 'icecandidate'];
    const listener = () => { if (!stopped && connections.has(pc)) refresh(pc); };
    events.forEach(event => pc.addEventListener(event, listener));
    cleanups.set(pc, () => events.forEach(event => pc.removeEventListener(event, listener)));
  }
  class ObservedPeerConnection extends NativePeerConnection {
    constructor(configuration?: RTCConfiguration) {
      super(configuration);
      observe(this);
    }
  }
  async function sample(): Promise<void> {
    if (stopped || sampling) return;
    sampling = true;
    try {
      // Trystero can reuse live connections created for a previous room.
      getConnectedPeers().forEach(observe);
      await Promise.all([...connections].map(async ([pc]) => {
        // Preserve evidence of failed attempts after the dependency closes them.
        const snapshot = refresh(pc);
        if (pc.connectionState === 'closed') return;
        if (snapshot.remoteDescription) {
          try {
            const path = selectedPath(await pc.getStats());
            if (!stopped) Object.assign(refresh(pc), path);
          } catch { /* Browser may have closed it. */ }
        }
      }));
      if (stopped) return;
      // Ignore attempts without remote SDP; show real negotiations, or one PC
      // to distinguish candidate gathering from missing remote signaling.
      const all = [...connections.values()];
      const attempts = all.filter(pc => pc.remoteDescription);
      try { onDiagnostic({ connections: structuredClone(attempts.length ? attempts : all.slice(-1)) }); } catch { /* Observer only. */ }
      // Bound retained closed attempts during retries.
      for (const [pc] of connections) if (connections.size > 64 && pc.connectionState === 'closed') {
        cleanups.get(pc)?.(); cleanups.delete(pc); connections.delete(pc);
      }
    } finally { sampling = false; }
  }
  const timer = setInterval(() => { void sample(); }, 1000);
  return {
    rtcPolyfill: ObservedPeerConnection,
    async close() {
      await sample(); stopped = true; clearInterval(timer);
      cleanups.forEach(cleanup => cleanup()); cleanups.clear(); connections.clear();
    },
  };
}
