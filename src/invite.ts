export interface Invite { app: string; room: string; host: string; secret: string }

export function encodeInvite(invite: Invite): string {
  const bytes = new TextEncoder().encode(JSON.stringify(invite));
  return 'ogp1.' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeInvite(code: string, appId: string): Invite {
  try {
    if (code.length > 4096 || !/^ogp1\.[A-Za-z0-9_-]+$/.test(code)) throw new Error();
    const body = code.slice(5).replaceAll('-', '+').replaceAll('_', '/');
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), c => c.charCodeAt(0))));
    if (!value || typeof value !== 'object') throw new Error();
    const v = value as Record<string, unknown>;
    if (v.app !== appId || !['app', 'room', 'host', 'secret'].every(k => typeof v[k] === 'string' && (v[k] as string).length > 0)) throw new Error();
    return v as unknown as Invite;
  } catch { throw new Error('Invalid invitation or invitation belongs to another app'); }
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
